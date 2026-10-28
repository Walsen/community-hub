/**
 * Property 31: Adding or removing a forum changes only that forum's record sets.
 *
 * Validates: Requirements 4.8, 4.9, 12.12
 *
 * In `route53` mode (where forum `A` record sets actually exist in the
 * template), adding or removing ONE forum must leave every OTHER forum's Route
 * 53 record SETS byte-for-byte identical, add or remove exactly the touched
 * forum's `A` record set, and never move another forum's record. Req 4.3 and
 * 12.12 make each forum's `A` record a pure function of its id and subdomain, so
 * this is a structural guarantee of the synthesized template.
 *
 * This complements task 19.10 (Property 18), which covers ALL of a forum's own
 * resources. Here the claim is scoped narrowly to `AWS::Route53::RecordSet`
 * resources: for any two forum sets differing by a single entry, each surviving
 * forum's `A` record set is identical across the two synths, the touched forum's
 * `A` record set appears in exactly the template that declares the forum, and no
 * surviving record set carries the touched forum's identity.
 *
 * A forum `A` record set is identified two independent ways, both asserted to
 * agree: by its CloudFormation logical id, which embeds the sanitized
 * construct-path segment `Forum<id>` (CDK drops the hyphen from the construct id
 * `Forum-<id>`), and by its record `Name` property, the forum's absolute
 * hostname `<subdomain>.<rootDomain>.`. Because forum ids and subdomains are
 * unique and hyphen-free, neither key of one forum is ever a prefix of
 * another's.
 *
 * The SHARED email record sets (DKIM CNAMEs, MAIL FROM MX, SPF/DMARC TXT) belong
 * to the Environment, not to any forum: they legitimately stay identical
 * regardless of the forum set, so the per-forum isolation claim is deliberately
 * scoped to the forum `A` records and never asserts anything about the email
 * records.
 *
 * Harness: the same construction path `bin/app.ts` uses — one
 * {@link EnvironmentStack} from a model loaded by {@link loadMetadata} against
 * {@link createDefaultRegistry}, synthesized with Lambda bundling disabled so no
 * esbuild, network or Docker is needed. The asset-hash and Lightsail `UserData`
 * normalizer is adapted from `test/infra/dns/environment-dns.test.ts` and
 * `test/infra/naming-stability.property.test.ts` so cross-synth bundling noise
 * does not cause false diffs.
 *
 * Determinism: a fixed fast-check seed (`0x5eed`) and a small run count (30)
 * keep any counterexample reproducible and the synth cost bounded; the per-test
 * timeout is raised because each run synthesizes two full stacks. Secrets are
 * only placeholder `ssm:` references; no secret value appears here.
 */

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import fc from 'fast-check';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import type { ValidatedModel } from '../../../src/metadata/schema.js';
import { EnvironmentStack } from '../../../src/infra/environment-stack.js';

/** Fixed synthesis environment so account/region tokens never vary between synths. */
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ROOT_DOMAIN = 'example.org';
const ENV_NAME = 'community-test';

/** Small run count: each run synthesizes two full stacks, so keep it bounded. */
const NUM_RUNS = 30;
/** Fixed seed so any counterexample is reproducible. */
const SEED = 0x5eed;
/**
 * Per-test timeout. Each run synthesizes two full `EnvironmentStack`s (several
 * `NodejsFunction`s each), which overruns Vitest's 5 s default, so the budget is
 * raised rather than the run count lowered below a useful level.
 */
const TEST_TIMEOUT_MS = 120_000;

/** A generated forum, in the raw shape the metadata YAML expects. */
interface GenForum {
  readonly id: string;
  readonly engine: 'discourse' | 'flarum';
  readonly subdomain: string;
  readonly senderLocal: string;
}

const LOWER_ALPHA = 'abcdefghijklmnopqrstuvwxyz';
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

const charFrom = (chars: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: chars.length - 1 }).map((i) => chars[i]!);

const stringFrom = (chars: string, minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(charFrom(chars), { minLength, maxLength }).map((cs) => cs.join(''));

/** A valid forum id base: `^[a-z][a-z0-9]{0,19}$` (uniqueness enforced later). */
const forumIdBase: fc.Arbitrary<string> = fc
  .tuple(charFrom(LOWER_ALPHA), stringFrom(LOWER_ALNUM, 0, 6))
  .map(([head, tail]) => `${head}${tail}`);

/** One generated forum with an engine drawn from the two default engines. */
const genForum: fc.Arbitrary<GenForum> = fc.record({
  id: forumIdBase,
  engine: fc.constantFrom<'discourse' | 'flarum'>('discourse', 'flarum'),
  subdomain: forumIdBase,
  senderLocal: forumIdBase,
});

/**
 * A set of 2–4 forums with distinct ids, subdomains and sender local parts.
 * Uniqueness is enforced by an index-derived suffix so the loader never rejects
 * the document on a collision.
 */
const genForums: fc.Arbitrary<readonly GenForum[]> = fc
  .array(genForum, { minLength: 2, maxLength: 4 })
  .map((forums) =>
    forums.map((forum, index) => {
      const suffix = `x${String(index)}`;
      return {
        ...forum,
        id: `${forum.id}${suffix}`.slice(0, 20),
        subdomain: `${forum.subdomain}${suffix}`,
        senderLocal: `${forum.senderLocal}${suffix}`,
      } satisfies GenForum;
    }),
  );

/** Build the raw metadata YAML (route53 mode) for a forum set. */
function metadataYaml(forums: readonly GenForum[]): string {
  const doc = {
    version: 1,
    environment: {
      name: ENV_NAME,
      region: REGION,
      availabilityZone: `${REGION}a`,
      dnsMode: 'route53',
      rootDomain: ROOT_DOMAIN,
      adminEmail: 'ops@example.org',
      sshAllowedCidrs: ['203.0.113.0/24'],
    },
    forums: forums.map((forum) => forumEntry(forum)),
  };
  return stringify(doc);
}

/** The raw YAML entry for one forum, valid for its engine. */
function forumEntry(forum: GenForum): Record<string, unknown> {
  const prefix = `/community-hub/${ENV_NAME}/${forum.id}/`;
  if (forum.engine === 'discourse') {
    return {
      id: forum.id,
      engine: 'discourse',
      subdomain: forum.subdomain,
      bundleId: 'medium_3_0',
      senderAddress: forum.senderLocal,
      secrets: {
        adminPassword: `ssm:${prefix}admin-password`,
        apiKey: `ssm:${prefix}api-key`,
      },
      engineOptions: {},
    };
  }
  return {
    id: forum.id,
    engine: 'flarum',
    subdomain: forum.subdomain,
    bundleId: 'small_3_0',
    senderAddress: forum.senderLocal,
    secrets: {
      adminPassword: `ssm:${prefix}admin-password`,
      apiKey: `ssm:${prefix}api-key`,
      databasePassword: `ssm:${prefix}database-password`,
    },
    engineOptions: {
      trustLevelGroups: { '0': 'members' },
    },
  };
}

/** Load a validated model for a forum set against the default registry. */
function modelFor(forums: readonly GenForum[]): ValidatedModel {
  return loadMetadata(metadataYaml(forums), createDefaultRegistry());
}

/** Synthesize the normalized template JSON for a forum set. */
function templateFor(forums: readonly GenForum[]): Record<string, unknown> {
  const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new EnvironmentStack(app, 'TestStack', {
    model: modelFor(forums),
    registry: createDefaultRegistry(),
    env: { account: ACCOUNT, region: REGION },
  });
  return normalizeTemplate(Template.fromStack(stack)) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ *
 * Template normalization (adapted from environment-dns.test.ts and
 * naming-stability.property.test.ts).
 *
 * Two cross-synth noise sources are removed so a record set's fragment is
 * byte-identical between two synths: CDK asset hashes (handler bundles) and the
 * Lightsail instance `UserData` (which embeds the broker URL token whose id
 * depends on how many tokens were allocated earlier in the process). Neither
 * appears inside a `RecordSet`, but the whole template is normalized uniformly
 * for simplicity and so logical-id slicing never trips over hash-derived keys.
 * ------------------------------------------------------------------ */

const USER_DATA_PLACEHOLDER = '<<USER_DATA>>';
const ASSET_HASH_GLOBAL = /[0-9a-f]{64}/g;

function isLightsailUserData(path: readonly string[]): boolean {
  return (
    path.length === 4 &&
    path[0] === 'Resources' &&
    path[2] === 'Properties' &&
    path[3] === 'UserData'
  );
}

function normalizeTemplate(template: Template): unknown {
  const json: unknown = template.toJSON();
  const hashSet = new Set<string>();
  collectHashes(json, hashSet);
  const placeholders = new Map<string, string>();
  [...hashSet].sort().forEach((hash, index) => {
    placeholders.set(hash, `ASSET${String(index)}`);
  });
  return normalizeNode(json, [], placeholders);
}

function collectHashes(node: unknown, into: Set<string>): void {
  if (typeof node === 'string') {
    for (const match of node.matchAll(ASSET_HASH_GLOBAL)) {
      into.add(match[0]);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectHashes(item, into);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectHashes(value, into);
    }
  }
}

function normalizeNode(
  node: unknown,
  path: readonly string[],
  placeholders: ReadonlyMap<string, string>,
): unknown {
  if (typeof node === 'string') {
    if (isLightsailUserData(path)) {
      return USER_DATA_PLACEHOLDER;
    }
    const key = path[path.length - 1];
    if (key === 'Analytics' && path[path.length - 2] === 'CDKMetadata') {
      return '<<ANALYTICS>>';
    }
    if (key === 'aws:asset:path' || key === 'aws:asset:original-path') {
      return '<<ASSET_PATH>>';
    }
    return node.replace(ASSET_HASH_GLOBAL, (hash) => placeholders.get(hash) ?? hash);
  }
  if (Array.isArray(node)) {
    return node.map((item) => normalizeNode(item, path, placeholders));
  }
  if (node !== null && typeof node === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = normalizeNode(value, [...path, key], placeholders);
    }
    return result;
  }
  return node;
}

/* ------------------------------------------------------------------ *
 * Record-set slicing.
 *
 * Every forum `A` record is a CloudFormation `AWS::Route53::RecordSet` whose
 * construct path is `Forum-<id>/Dns/A`; CDK sanitizes that to a logical id
 * containing the segment `Forum<id>` (hyphen dropped) and gives it `Type: 'A'`
 * and `Name: '<subdomain>.<rootDomain>.'`. A forum's record set is identified
 * two independent ways — by that logical-id segment and by that record name —
 * and the two are asserted to agree, so a false identification on either side is
 * caught.
 * ------------------------------------------------------------------ */

/** A normalized `AWS::Route53::RecordSet` resource with the fields we read. */
interface RecordSetResource {
  readonly Type: 'AWS::Route53::RecordSet';
  readonly Properties: {
    readonly Type?: unknown;
    readonly Name?: unknown;
  };
}

/** Is `value` a Route 53 record-set resource body? */
function isRecordSet(value: unknown): value is RecordSetResource {
  return (
    value !== null &&
    typeof value === 'object' &&
    (value as { Type?: unknown }).Type === 'AWS::Route53::RecordSet'
  );
}

/**
 * Every `AWS::Route53::RecordSet` in a normalized template, keyed by logical id.
 * The body is the entry's JSON, so comparing two entries with `toStrictEqual` is
 * a structural byte-for-byte comparison of the record set.
 */
function recordSets(template: Record<string, unknown>): Record<string, RecordSetResource> {
  const resources = template.Resources;
  const out: Record<string, RecordSetResource> = {};
  if (resources === null || typeof resources !== 'object') {
    return out;
  }
  for (const [logicalId, body] of Object.entries(resources as Record<string, unknown>)) {
    if (isRecordSet(body)) {
      out[logicalId] = body;
    }
  }
  return out;
}

/**
 * The sanitized construct-path segment every logical id of forum `f`'s subtree
 * contains. CDK strips the hyphen from the construct id `Forum-<id>`, so the
 * segment is `Forum<id>`.
 */
function forumLogicalIdSegment(forum: GenForum): string {
  return `Forum${forum.id}`;
}

/** The forum's absolute hostname, as written to the `A` record's `Name`. */
function forumHostname(forum: GenForum): string {
  return `${forum.subdomain}.${ROOT_DOMAIN}.`;
}

/**
 * The forum's own `A` record set, sliced from a template. The record is required
 * to be identifiable BOTH by the forum's `Forum<id>` logical-id segment AND by
 * its hostname `Name`, and those two identifications must select the same single
 * record set; a disagreement fails the test rather than silently picking one.
 * Returns the `[logicalId, body]` pair, or `undefined` when the forum has no `A`
 * record set in this template (because the forum is absent).
 */
function forumARecordSet(
  template: Record<string, unknown>,
  forum: GenForum,
): readonly [string, RecordSetResource] | undefined {
  const segment = forumLogicalIdSegment(forum);
  const hostname = forumHostname(forum);
  const sets = recordSets(template);

  const byLogicalId = Object.entries(sets).filter(([logicalId, body]) => {
    return logicalId.includes(segment) && body.Properties.Type === 'A';
  });
  const byHostname = Object.entries(sets).filter(([, body]) => {
    return body.Properties.Type === 'A' && body.Properties.Name === hostname;
  });

  // Both keys select at most one record set, and they agree.
  expect(byLogicalId.length).toBeLessThanOrEqual(1);
  expect(byHostname.length).toBeLessThanOrEqual(1);
  expect(byLogicalId.map(([id]) => id)).toStrictEqual(byHostname.map(([id]) => id));

  const entry = byLogicalId[0];
  return entry === undefined ? undefined : [entry[0], entry[1]];
}

/** Does any record set in `template` carry forum `f`'s logical-id segment? */
function anyRecordSetOwnedBy(template: Record<string, unknown>, forum: GenForum): boolean {
  const segment = forumLogicalIdSegment(forum);
  return Object.keys(recordSets(template)).some((logicalId) => logicalId.includes(segment));
}

describe('Property 31: per-forum record set isolation', () => {
  it(
    'removing one forum changes only that forum A record set (Req 4.8, 4.9, 12.12)',
    { timeout: TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(genForums, fc.nat(), (forums, removalPick) => {
          const removeIndex = removalPick % forums.length;
          const removed = forums[removeIndex]!;
          const remaining = forums.filter((_, index) => index !== removeIndex);

          const fullTemplate = templateFor(forums);
          const reducedTemplate = templateFor(remaining);

          // The removed forum DID own an A record set in the full template, so
          // the absence check below is meaningful rather than vacuously true.
          expect(forumARecordSet(fullTemplate, removed)).toBeDefined();

          // Each surviving forum's A record set is byte-for-byte identical across
          // the two synths: same logical id, same Name, same target, same TTL.
          for (const forum of remaining) {
            const before = forumARecordSet(fullTemplate, forum);
            const after = forumARecordSet(reducedTemplate, forum);
            expect(before).toBeDefined();
            expect(after).toBeDefined();
            expect(after).toStrictEqual(before);
          }

          // The removed forum's A record set is gone from the reduced template,
          // by both identification keys.
          expect(forumARecordSet(reducedTemplate, removed)).toBeUndefined();
          expect(anyRecordSetOwnedBy(reducedTemplate, removed)).toBe(false);
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );

  it(
    'adding one forum changes only that forum A record set (Req 4.8, 12.12)',
    { timeout: TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(genForums, (forums) => {
          // Treat the first forum as the one being added: the "before" set is the
          // remaining forums, the "after" set is all of them.
          const added = forums[0]!;
          const before = forums.slice(1);
          fc.pre(before.length >= 1);

          const beforeTemplate = templateFor(before);
          const afterTemplate = templateFor(forums);

          // Each pre-existing forum's A record set is unchanged by the addition.
          for (const forum of before) {
            const sliceBefore = forumARecordSet(beforeTemplate, forum);
            const sliceAfter = forumARecordSet(afterTemplate, forum);
            expect(sliceBefore).toBeDefined();
            expect(sliceAfter).toBeDefined();
            expect(sliceAfter).toStrictEqual(sliceBefore);
          }

          // The added forum's A record set is absent before and present after.
          expect(forumARecordSet(beforeTemplate, added)).toBeUndefined();
          expect(anyRecordSetOwnedBy(beforeTemplate, added)).toBe(false);
          expect(forumARecordSet(afterTemplate, added)).toBeDefined();
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );
});
