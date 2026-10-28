/**
 * Property test for SES rotation-counter isolation in the synthesized template
 * (task 19.12, Property 26; Req 11.15, 11.16).
 *
 * Each forum's SES credentials are managed by a `Credentials` custom resource
 * under `Forum-<id>/Ses`, whose `rotationCounter` property is
 * `forum.credentialRotation` (see {@link SesSender}). Bumping one forum's
 * `credentialRotation` must replace only that forum's credentials — in the
 * template, change only that forum's `Credentials` custom-resource properties —
 * and leave every other forum's credential resource and every other resource
 * byte-for-byte identical.
 *
 * The property generates 2–3 forums with distinct ids/subdomains/sender
 * addresses and arbitrary non-negative rotation counters, synthesizes the stack,
 * bumps one chosen forum's counter by one, synthesizes again, and compares the
 * two normalized templates per forum.
 *
 * Determinism follows the `test/infra/dns/environment-dns.test.ts` harness:
 * Lambda bundling is skipped via the `aws:cdk:bundling-stacks: []` app context,
 * and asset hashes and Lightsail `UserData` are normalized before comparison so
 * two synths of the same model compare equal. The seed `0x5eed` is fixed and
 * `numRuns` is kept small. Secrets are only placeholder `ssm:` references.
 */

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { stringify } from 'yaml';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import { EnvironmentStack } from '../../../src/infra/environment-stack.js';

/** Fixed synthesis environment so account/region tokens never vary across synths. */
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ROOT_DOMAIN = 'example.org';
const ENV_NAME = 'community-test';

type DnsMode = 'route53' | 'external';

/** A generated forum description for the metadata document. */
interface ForumSpec {
  readonly id: string;
  readonly engine: 'discourse' | 'flarum';
  readonly subdomain: string;
  readonly senderAddress: string;
  readonly bundleId: string;
  readonly credentialRotation: number;
}

/** Matches a CDK asset hash: a bare 64-character lowercase hex token. */
const ASSET_HASH_GLOBAL = /[0-9a-f]{64}/g;

/** Placeholder written in place of each Lightsail instance's `UserData`. */
const USER_DATA_PLACEHOLDER = '<<USER_DATA>>';

/**
 * Build the metadata document for a set of forums and DNS mode, serialized to
 * YAML with placeholder `ssm:` references only.
 */
function metadataYaml(forums: readonly ForumSpec[], dnsMode: DnsMode): string {
  const doc: Record<string, unknown> = {
    version: 1,
    environment: {
      name: ENV_NAME,
      region: REGION,
      availabilityZone: `${REGION}a`,
      dnsMode,
      rootDomain: ROOT_DOMAIN,
      adminEmail: 'ops@example.org',
      sshAllowedCidrs: ['203.0.113.0/24'],
    },
    forums: forums.map((forum) => {
      const base = `/community-hub/${ENV_NAME}/${forum.id}`;
      const secrets: Record<string, string> = {
        adminPassword: `ssm:${base}/admin-password`,
        apiKey: `ssm:${base}/api-key`,
      };
      if (forum.engine === 'flarum') {
        secrets.databasePassword = `ssm:${base}/database-password`;
      }
      return {
        id: forum.id,
        engine: forum.engine,
        subdomain: forum.subdomain,
        bundleId: forum.bundleId,
        senderAddress: forum.senderAddress,
        credentialRotation: forum.credentialRotation,
        secrets,
        engineOptions: forum.engine === 'flarum' ? { trustLevelGroups: { '0': 'members' } } : {},
      };
    }),
  };
  return stringify(doc);
}

/** Create an {@link App} with Lambda bundling disabled (no esbuild, no network). */
function createApp(): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

/** Synthesize the stack for the given forums and mode into a normalized template JSON. */
function synth(forums: readonly ForumSpec[], dnsMode: DnsMode): Record<string, unknown> {
  const app = createApp();
  const model = loadMetadata(metadataYaml(forums, dnsMode), createDefaultRegistry());
  const stack = new EnvironmentStack(app, 'TestStack', {
    model,
    registry: createDefaultRegistry(),
    env: { account: ACCOUNT, region: REGION },
  });
  return normalizeTemplate(Template.fromStack(stack));
}

/**
 * Normalize a synthesized template: collect every distinct asset hash and
 * rewrite it to a stable placeholder (numbered over the sorted set so emit
 * order cannot renumber), drop asset-parameter plumbing under `Parameters`, and
 * replace each Lightsail instance `UserData` with a stable placeholder. This
 * mirrors the normalization in `environment-dns.test.ts` so two synths of the
 * same model produce byte-identical JSON.
 */
function normalizeTemplate(template: Template): Record<string, unknown> {
  const json: unknown = template.toJSON();

  const hashSet = new Set<string>();
  collectHashes(json, hashSet);
  const placeholders = new Map<string, string>();
  [...hashSet].sort().forEach((hash, index) => {
    placeholders.set(hash, `ASSET${String(index)}`);
  });

  const normalized = normalizeNode(json, [], placeholders);
  return normalized as Record<string, unknown>;
}

/** Walk the tree recording every 64-hex asset hash found in any string. */
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

/** True for an object key that is pure CDK asset-bundling plumbing. */
function isAssetPlumbingKey(key: string): boolean {
  return (
    /^[0-9a-f]{64}$/.test(key) ||
    key.startsWith('AssetParameters') ||
    key.includes('S3Bucket') ||
    key.includes('S3VersionKey')
  );
}

/**
 * Is the node at `path` a Lightsail instance `UserData`? The shape is
 * `Resources.<logicalId>.Properties.UserData`.
 */
function isLightsailUserData(path: readonly string[]): boolean {
  return (
    path.length === 4 &&
    path[0] === 'Resources' &&
    path[2] === 'Properties' &&
    path[3] === 'UserData'
  );
}

/** Return a normalized copy of `node` (see {@link normalizeTemplate}). */
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
    const underParameters = path.length === 1 && path[0] === 'Parameters';
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (underParameters && isAssetPlumbingKey(key)) {
        continue;
      }
      result[key] = normalizeNode(value, [...path, key], placeholders);
    }
    return result;
  }

  return node;
}

/** A template resource shape: a `Type` plus arbitrary other fields. */
interface TemplateResource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
}

/** Extract the `Resources` map from a normalized template. */
function resourcesOf(template: Record<string, unknown>): Record<string, TemplateResource> {
  return (template.Resources ?? {}) as Record<string, TemplateResource>;
}

/**
 * Find the SES `Credentials` custom resource for a forum by its `forumId`
 * property. The resource is a `Custom::`/`AWS::CloudFormation::CustomResource`
 * carrying `{ environment, forumId, rotationCounter, ServiceToken }`. Returns the
 * resource object, or undefined if no credentials resource declares that forum.
 */
function credentialsResourceFor(
  resources: Record<string, TemplateResource>,
  forumId: string,
): TemplateResource | undefined {
  const matches = Object.values(resources).filter((resource) => {
    const props = resource.Properties;
    return (
      props !== undefined &&
      typeof props.rotationCounter !== 'undefined' &&
      props.forumId === forumId
    );
  });
  // Exactly one credentials resource per forum.
  return matches.length === 1 ? matches[0] : undefined;
}

/** fast-check arbitrary for a non-empty set of 2–3 distinct forums. */
const forumsArb: fc.Arbitrary<ForumSpec[]> = fc
  .integer({ min: 2, max: 3 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, index) =>
        fc.record({
          engine: fc.constantFrom<'discourse' | 'flarum'>('discourse', 'flarum'),
          credentialRotation: fc.nat({ max: 5 }),
          // Distinct, schema-valid ids/subdomains/senders keyed on the index.
          index: fc.constant(index),
        }),
      ),
    ),
  )
  .map((parts) =>
    parts.map((part) => {
      const id = `forum${String(part.index)}`;
      return {
        id,
        engine: part.engine,
        subdomain: `sub${String(part.index)}`,
        senderAddress: `sender${String(part.index)}@${ROOT_DOMAIN}`,
        bundleId: part.engine === 'discourse' ? 'medium_3_0' : 'small_3_0',
        credentialRotation: part.credentialRotation,
      } satisfies ForumSpec;
    }),
  );

describe('SES rotation-counter isolation in the synthesized template (Property 26)', () => {
  it('bumping one forum credentialRotation changes only that forum credentials resource', () => {
    fc.assert(
      fc.property(
        forumsArb,
        fc.constantFrom<DnsMode>('route53', 'external'),
        fc.nat({ max: 2 }),
        (forums, dnsMode, chosenRaw) => {
          const chosenIndex = chosenRaw % forums.length;
          const chosen = forums[chosenIndex];
          if (chosen === undefined) {
            throw new Error('chosen forum index out of range');
          }

          const before = synth(forums, dnsMode);

          const bumped = forums.map((forum, index) =>
            index === chosenIndex
              ? { ...forum, credentialRotation: forum.credentialRotation + 1 }
              : forum,
          );
          const after = synth(bumped, dnsMode);

          const beforeResources = resourcesOf(before);
          const afterResources = resourcesOf(after);

          // The chosen forum's credentials resource must change: its
          // rotationCounter goes from old to old+1.
          const chosenBefore = credentialsResourceFor(beforeResources, chosen.id);
          const chosenAfter = credentialsResourceFor(afterResources, chosen.id);
          expect(chosenBefore).toBeDefined();
          expect(chosenAfter).toBeDefined();
          expect(chosenBefore?.Properties?.rotationCounter).toBe(chosen.credentialRotation);
          expect(chosenAfter?.Properties?.rotationCounter).toBe(chosen.credentialRotation + 1);

          // Every OTHER forum's credentials resource must be byte-for-byte equal.
          for (const forum of forums) {
            if (forum.id === chosen.id) {
              continue;
            }
            const other = credentialsResourceFor(afterResources, forum.id);
            const otherBefore = credentialsResourceFor(beforeResources, forum.id);
            expect(otherBefore).toBeDefined();
            expect(other).toEqual(otherBefore);
          }

          // Every resource that is NOT the chosen forum's credentials resource
          // must be identical across the two templates. We compare the two
          // Resources maps with the chosen forum's credentials resource removed
          // (identified by forumId); nothing else may differ.
          const strip = (resources: Record<string, TemplateResource>): Record<string, unknown> => {
            const copy: Record<string, unknown> = {};
            for (const [logicalId, resource] of Object.entries(resources)) {
              const props = resource.Properties;
              const isChosenCredentials =
                props !== undefined &&
                typeof props.rotationCounter !== 'undefined' &&
                props.forumId === chosen.id;
              if (isChosenCredentials) {
                continue;
              }
              copy[logicalId] = resource;
            }
            return copy;
          };

          expect(strip(afterResources)).toEqual(strip(beforeResources));

          // And the non-resource sections of the template (Outputs, Parameters,
          // Conditions, Mappings) must be identical too.
          for (const section of ['Outputs', 'Parameters', 'Conditions', 'Mappings']) {
            expect(after[section]).toEqual(before[section]);
          }
        },
      ),
      { numRuns: 30, seed: 0x5eed },
    );
    // Each run synthesizes the full EnvironmentStack twice (two Lambda-bundled
    // stacks), so 30 runs needs well above the 5s default. The property itself
    // is deterministic; the timeout only accommodates synthesis cost.
  }, 120_000);
});
