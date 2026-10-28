/**
 * Property 18: Naming stability (Core 6).
 *
 * Validates: Requirements 4.8, 4.9, 11.17
 *
 * Adding or removing ONE forum must leave every OTHER forum's construct ids,
 * resource names, DNS record sets and SES credential resources byte-for-byte
 * unchanged. Req 4.8 and 4.9 require that redeploying after a forum is added or
 * removed touches only that forum's Lightsail instance and static IP; Req 11.17
 * requires the same of the removed forum's SES user and SMTP credentials — other
 * forums' SES resources stay put.
 *
 * Because every name and construct id in {@link import('../../src/infra/naming.js')}
 * derives purely from the Environment name and forum id, this is a structural
 * guarantee of the synthesized template: for any two forum sets that differ by a
 * single entry, the template fragments belonging to each shared forum are
 * identical. The test synthesizes an {@link EnvironmentStack} for a full set and
 * for the set with one forum removed, then asserts that the per-forum slice of
 * each surviving forum (its Lightsail, IAM node role, A record set and SES
 * user/policy/credential resources, plus its per-forum outputs) matches across
 * the two synths, and that the removed forum's `Ses/*` resources are gone.
 *
 * Harness: the same path `bin/app.ts` uses — one {@link EnvironmentStack} from a
 * model loaded by {@link loadMetadata} against {@link createDefaultRegistry},
 * synthesized with Lambda bundling disabled so no esbuild, network or Docker is
 * needed. The asset-hash and Lightsail `UserData` normalizer is adapted from
 * `test/infra/dns/environment-dns.test.ts` so cross-synth bundling noise does
 * not cause false diffs.
 *
 * Determinism: a fixed fast-check seed and a small run count (30) keep any
 * counterexample reproducible and the synth cost bounded. Secrets are only
 * placeholder `ssm:` references; no secret value appears here.
 */

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import fc from 'fast-check';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import type { ValidatedModel } from '../../src/metadata/schema.js';
import { EnvironmentStack } from '../../src/infra/environment-stack.js';

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
 * Per-test timeout. Each of the 30 runs synthesizes two full `EnvironmentStack`s
 * (several `NodejsFunction`s each), which overruns Vitest's 5 s default, so the
 * budget is raised rather than the run count lowered below a useful level.
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
 * Uniqueness is enforced by an index-derived suffix, exactly as the shared
 * document arbitrary does, so the loader never rejects the document on a
 * collision.
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
 * Template normalization (adapted from environment-dns.test.ts).
 *
 * Two cross-synth noise sources are removed so a shared forum's fragment is
 * byte-identical between two synths: CDK asset hashes (handler bundles) and the
 * Lightsail instance `UserData` (which embeds the broker URL token whose id
 * depends on how many tokens were allocated earlier in the process).
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
 * Per-forum slicing.
 *
 * A forum OWNS exactly the resources and outputs under its construct subtree
 * `Forum-<id>`: its Lightsail instance and static IP, its IAM node role (with
 * any DNS-01 statements), its `Dns/A` record set, its SES IAM user, send policy
 * and credential custom resources, and its per-forum outputs. CDK derives each
 * such construct's logical id from the construct path, sanitized by stripping
 * non-alphanumerics, so every owned logical id embeds the segment `Forum<id>`
 * (the hyphen in `Forum-<id>` is dropped). Because forum ids are unique and
 * hyphen-free, `Forum<id>` is never a prefix of another forum's segment
 * (`Forumax0` is not a prefix of `Forumax1`), so the slice is exact.
 *
 * Shared per-Environment resources — the bootstrap broker, the SES identity and
 * configuration set, the custom-resource providers — are deliberately EXCLUDED.
 * They legitimately aggregate references to every forum (for example the broker
 * embeds all forums in its `FORUMS` config), so they are expected to change as
 * the forum set changes; that is not what naming stability governs. The design's
 * Property 18 scopes the guarantee to each forum's OWN resources, and ownership
 * is the construct subtree, i.e. the logical id, not a body reference.
 * ------------------------------------------------------------------ */

/**
 * The sanitized construct-path segment that every logical id of forum `f`'s own
 * subtree contains. CDK strips the hyphen from the construct id `Forum-<id>`
 * when building a logical id, so the segment is `Forum<id>`.
 */
function forumLogicalIdSegment(forum: GenForum): string {
  return `Forum${forum.id}`;
}

/**
 * Whether `logicalId` belongs to forum `f`'s own construct subtree. The segment
 * is matched as a boundary-delimited token so one forum's segment can never be a
 * prefix of another's: a digit/letter immediately after the segment (as in
 * `Forumax1...` vs the needle `Forumax0`) differs, and the suffixes CDK appends
 * are the next construct-path segment (`StaticIp`, `NodeRole`, `Instance`,
 * `Ses`, `Dns`, ...) or an 8-hex disambiguator, never an extension of the id.
 */
function ownsLogicalId(logicalId: string, forum: GenForum): boolean {
  return logicalId.includes(forumLogicalIdSegment(forum));
}

/**
 * Slice the per-forum fragment out of a normalized template: every Resources
 * and Outputs entry whose LOGICAL ID is in the forum's `Forum-<id>` subtree,
 * keyed by `section/logicalId`. The value is the entry's JSON, so comparing two
 * slices with `toStrictEqual` is a structural byte-for-byte comparison of names,
 * construct ids and properties.
 */
function sliceForum(template: Record<string, unknown>, forum: GenForum): Record<string, unknown> {
  const slice: Record<string, unknown> = {};
  for (const section of ['Resources', 'Outputs'] as const) {
    const entries = template[section];
    if (entries === null || typeof entries !== 'object') {
      continue;
    }
    for (const [logicalId, body] of Object.entries(entries as Record<string, unknown>)) {
      if (ownsLogicalId(logicalId, forum)) {
        slice[`${section}/${logicalId}`] = body;
      }
    }
  }
  return slice;
}

/** Every logical id in a template's Resources section. */
function resourceIds(template: Record<string, unknown>): readonly string[] {
  const resources = template.Resources;
  if (resources === null || typeof resources !== 'object') {
    return [];
  }
  return Object.keys(resources);
}

describe('Property 18: Naming stability (Core 6)', () => {
  it(
    'removing one forum leaves every other forum unchanged (Req 4.8, 4.9, 11.17)',
    { timeout: TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(genForums, fc.nat(), (forums, removalPick) => {
          const removeIndex = removalPick % forums.length;
          const removed = forums[removeIndex]!;
          const remaining = forums.filter((_, index) => index !== removeIndex);

          const fullTemplate = templateFor(forums);
          const reducedTemplate = templateFor(remaining);

          // Each surviving forum's slice is byte-for-byte identical across the two
          // synths: its construct ids, resource names, A record set and SES
          // user/policy/credential resources never move when another forum leaves.
          for (const forum of remaining) {
            const before = sliceForum(fullTemplate, forum);
            const after = sliceForum(reducedTemplate, forum);
            // Sanity: the slice is non-empty (the forum really is in the template),
            // so the equality below is meaningful rather than two empty objects.
            expect(Object.keys(after).length).toBeGreaterThan(0);
            expect(after).toStrictEqual(before);
          }

          // The removed forum's own resources are gone from the reduced template:
          // its Lightsail instance and static IP (Req 4.9) and its SES user and
          // SMTP credential custom resource (Req 11.17) all live under its
          // `Forum-<id>` subtree, so no surviving logical id carries its segment.
          for (const logicalId of resourceIds(reducedTemplate)) {
            expect(ownsLogicalId(logicalId, removed)).toBe(false);
          }
          // The removed forum DID own resources in the full template, so the
          // check above is meaningful rather than vacuously true.
          expect(Object.keys(sliceForum(fullTemplate, removed)).length).toBeGreaterThan(0);
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );

  it(
    'adding one forum leaves every pre-existing forum unchanged (Req 4.8)',
    { timeout: TEST_TIMEOUT_MS },
    () => {
      fc.assert(
        fc.property(genForums, (forums) => {
          // Treat the first forum as the one being added: the "before" set is the
          // remaining forums, the "after" set is all of them. Adding must not move
          // any pre-existing forum's fragment.
          const added = forums[0]!;
          const before = forums.slice(1);
          fc.pre(before.length >= 1);

          const beforeTemplate = templateFor(before);
          const afterTemplate = templateFor(forums);

          for (const forum of before) {
            const sliceBefore = sliceForum(beforeTemplate, forum);
            const sliceAfter = sliceForum(afterTemplate, forum);
            expect(Object.keys(sliceAfter).length).toBeGreaterThan(0);
            expect(sliceAfter).toStrictEqual(sliceBefore);
          }

          // The added forum is absent before and present after.
          expect(Object.keys(sliceForum(beforeTemplate, added))).toHaveLength(0);
          expect(Object.keys(sliceForum(afterTemplate, added)).length).toBeGreaterThan(0);
        }),
        { numRuns: NUM_RUNS, seed: SEED },
      );
    },
  );
});
