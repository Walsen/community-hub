/**
 * CDK assertion and snapshot tests for {@link EnvironmentStack} per DNS_Mode
 * (task 19.9).
 *
 * The stack is synthesized through the same construction path `bin/app.ts` uses
 * (one {@link EnvironmentStack} from a validated model and the default engine
 * registry), so these tests exercise the real wiring of {@link EnvironmentDns},
 * the record factories and the forum node roles rather than a hand-built
 * fixture.
 *
 * Determinism (per the testing steering):
 *
 *  - Lambda bundling is skipped by seeding the `aws:cdk:bundling-stacks: []`
 *    context on the {@link App}, so `NodejsFunction`s do not invoke esbuild and
 *    the test needs no network or Docker. With bundling skipped the handler
 *    asset hashes are still non-deterministic across machines/CDK versions, so
 *    {@link normalizeTemplate} rewrites every asset hash (S3 keys, asset
 *    parameter names/values and `aws:asset:path` metadata) to stable
 *    placeholders before snapshotting.
 *  - For `route53-existing` the synth-time `HostedZone.fromLookup` is fed
 *    through SEEDED LOOKUP CONTEXT: the exact context key is computed with
 *    {@link ContextProvider.getKey} for the `hosted-zone` provider and the same
 *    `{ domainName, privateZone }` props `fromLookup` passes, then the fake zone
 *    value (`{ Id, Name }`) is set on the app node under that key. No network
 *    lookup happens.
 *
 * Secrets: the model uses only `ssm:` Secret_References with placeholder paths;
 * no secret value appears here.
 */

import { App, Stack } from 'aws-cdk-lib';
import { ContextProvider } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import * as cxschema from 'aws-cdk-lib/cloud-assembly-schema';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import type { ValidatedModel } from '../../../src/metadata/schema.js';
import { EnvironmentStack } from '../../../src/infra/environment-stack.js';
import { HostedZoneMismatchError } from '../../../src/shared/errors.js';

/** Fixed synthesis environment so account/region tokens never leak into snapshots. */
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ROOT_DOMAIN = 'example.org';

/** The declared hosted zone id used in `route53-existing` tests. */
const DECLARED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';
/** A different id, to exercise the mismatch branch. */
const OTHER_ZONE_ID = 'Z9999999999ZZZZZZZZZZ';

type DnsMode = 'route53' | 'route53-existing' | 'external';

/**
 * Generous per-test timeout. Each `it` synthesizes a full `EnvironmentStack`,
 * which is synth-heavy and slows under worker contention during the parallel
 * `npm test` run, occasionally exceeding Vitest's 5000ms default. Applied at the
 * suite level so it cascades to every test.
 */
const SUITE_TIMEOUT_MS = 60_000;

/**
 * A two-forum (Discourse + Flarum) metadata document for the given DNS mode,
 * serialized to YAML. Placeholder `ssm:` references only.
 */
function metadataYaml(dnsMode: DnsMode): string {
  const doc: Record<string, unknown> = {
    version: 1,
    environment: {
      name: 'community-test',
      region: REGION,
      availabilityZone: `${REGION}a`,
      dnsMode,
      rootDomain: ROOT_DOMAIN,
      adminEmail: 'ops@example.org',
      sshAllowedCidrs: ['203.0.113.0/24'],
      ...(dnsMode === 'route53-existing' ? { hostedZoneId: DECLARED_ZONE_ID } : {}),
    },
    forums: [
      {
        id: 'main',
        engine: 'discourse',
        subdomain: 'forum',
        bundleId: 'medium_3_0',
        senderAddress: 'noreply',
        secrets: {
          adminPassword: 'ssm:/community-hub/community-test/main/admin-password',
          apiKey: 'ssm:/community-hub/community-test/main/api-key',
        },
        engineOptions: {},
      },
      {
        id: 'dev',
        engine: 'flarum',
        subdomain: 'dev',
        bundleId: 'small_3_0',
        senderAddress: 'dev-forum@example.org',
        secrets: {
          adminPassword: 'ssm:/community-hub/community-test/dev/admin-password',
          apiKey: 'ssm:/community-hub/community-test/dev/api-key',
          databasePassword: 'ssm:/community-hub/community-test/dev/database-password',
        },
        engineOptions: {
          trustLevelGroups: { '0': 'members' },
        },
      },
    ],
  };
  return stringify(doc);
}

/** Load a validated model for the given DNS mode against the default registry. */
function modelFor(dnsMode: DnsMode): ValidatedModel {
  return loadMetadata(metadataYaml(dnsMode), createDefaultRegistry());
}

/**
 * Create an {@link App} with Lambda bundling disabled, so `NodejsFunction`s do
 * not invoke esbuild during synthesis.
 */
function createApp(): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

/**
 * Seed the `HostedZone.fromLookup` context for `route53-existing`.
 *
 * `fromLookup` resolves the zone through the `hosted-zone` context provider with
 * props `{ domainName, privateZone }` (plus the stack's account/region, which
 * `getKey` includes by default). Computing the key with the same provider and
 * props and setting the fake value under it makes the lookup resolve offline to
 * `{ Id, Name }`. When `value` is a provider error (`{ '$providerError': ... }`)
 * synthesis fails as if no public zone existed.
 */
function seedHostedZoneLookup(app: App, stack: Stack, value: Record<string, string>): void {
  const { key } = ContextProvider.getKey(stack, {
    provider: cxschema.ContextProvider.HOSTED_ZONE_PROVIDER,
    props: { domainName: ROOT_DOMAIN, privateZone: false },
  });
  app.node.setContext(key, value);
}

/**
 * Build an {@link EnvironmentStack} for the mode. For `route53-existing` the
 * caller supplies the fake looked-up zone value (or a provider error); the stack
 * must be created before seeding would matter, so the model is built first, the
 * stack constructed, and — because the lookup only runs when the template is
 * produced — the context is seeded on the app before the stack is instantiated.
 */
function buildStack(
  dnsMode: DnsMode,
  options: { lookupValue?: Record<string, string> } = {},
): { app: App; stack: EnvironmentStack } {
  const app = createApp();
  const model = modelFor(dnsMode);

  // For route53-existing the lookup key depends only on the provider, the
  // domain, privateZone and the stack's account/region, none of which depend on
  // the stack instance, so a throwaway stack computes the same key.
  if (dnsMode === 'route53-existing' && options.lookupValue !== undefined) {
    const keyScope = new Stack(createApp(), 'KeyScope', {
      env: { account: ACCOUNT, region: REGION },
    });
    seedHostedZoneLookup(app, keyScope, options.lookupValue);
  }

  const stack = new EnvironmentStack(app, 'TestStack', {
    model,
    registry: createDefaultRegistry(),
    env: { account: ACCOUNT, region: REGION },
  });
  return { app, stack };
}

/** A well-formed fake looked-up zone matching the declared id. */
const MATCHING_LOOKUP = { Id: DECLARED_ZONE_ID, Name: ROOT_DOMAIN };

/**
 * Placeholder written in place of each Lightsail instance's `UserData`. The
 * user-data content is covered structurally by the `test/infra/user-data/`
 * suite; see {@link normalizeTemplate} for why it is replaced here.
 */
const USER_DATA_PLACEHOLDER = '<<USER_DATA>>';

/** Matches a CDK asset hash: a bare 64-character lowercase hex token. */
const ASSET_HASH = /^[0-9a-f]{64}$/;

/** Reproduces an asset hash wherever it appears as a substring (e.g. `<hash>.zip`). */
const ASSET_HASH_GLOBAL = /[0-9a-f]{64}/g;

/**
 * Is `path` exactly a resource's `Properties.UserData` VALUE node? The shape is
 * `Resources.<logicalId>.Properties.UserData`. The value is not a bare string —
 * CloudFormation wraps it (e.g. `{ "Fn::Base64": "<gzip+base64>" }` or an
 * `Fn::Join`) — so {@link normalizeNode} short-circuits the WHOLE value to a
 * placeholder here rather than trying to reach the leaf string. (An earlier
 * version only replaced a bare-string UserData, which never occurs, so the raw
 * gzip base64 leaked into the snapshot and made it depend on the payload / CDK
 * token ids — environment-fragile.)
 */
function isLightsailUserData(path: readonly string[]): boolean {
  return (
    path.length === 4 &&
    path[0] === 'Resources' &&
    path[2] === 'Properties' &&
    path[3] === 'UserData'
  );
}

/**
 * Recursively strip and normalize every run-varying token in a synthesized
 * template so two synths of the same model produce byte-identical normalized
 * JSON, while every real resource (Route 53, Lightsail, SES, IAM, the custom
 * resources and outputs) stays intact so the snapshot still catches structural
 * drift.
 *
 * Two sources of non-determinism are handled:
 *
 *  1. **CDK asset hashes.** The handler bundles' content hashes surface as
 *     `<hash>.zip` S3 keys, as `AssetParameters<hash>...` parameter names and
 *     values, and as `aws:asset:path` / `aws:asset:original-path` metadata.
 *     Hashes vary across machines and CDK versions. Every distinct 64-hex hash
 *     is rewritten to `ASSET<n>`; the numbering is assigned over the hashes
 *     sorted lexically (not in first-seen order) so a shift in which resource
 *     is emitted first cannot renumber the placeholders. The asset-parameter
 *     plumbing (`AssetParameters*` / `*S3Bucket*` / `*S3VersionKey*` entries
 *     under `Parameters`) is pure bundling machinery and is deleted outright.
 *
 *  2. **Lightsail instance `UserData`.** The user data embeds the bootstrap
 *     broker URL, which is a CDK token whose numeric id (`${Token[TOKEN.NN]}`)
 *     depends on how many tokens were allocated earlier in the process. Across
 *     a clean run other tests allocate tokens first, shifting that id, which
 *     changes the gzip+base64 payload and so the `UserData` string. The content
 *     is deterministic for a fixed token id and is asserted by the
 *     `test/infra/user-data/` tests, so here each Lightsail instance's
 *     `UserData` is replaced with {@link USER_DATA_PLACEHOLDER}.
 *
 * The `CDKMetadata` `Analytics` string and the bootstrap-version rule are
 * normalized too (Analytics to a placeholder, any 64-hex inside the rule via
 * the hash map) if they appear, so the normalizer does not depend on the
 * current CDK version omitting them.
 */
function normalizeTemplate(template: Template): unknown {
  const json: unknown = template.toJSON();

  // First pass: collect every distinct asset hash in a STABLE first-seen order
  // and number the placeholders over that order. The template STRUCTURE (logical
  // ids, key ordering) is identical across machines; only the hash VALUES differ
  // (different esbuild/Node produces different bundle bytes). Sorting the hashes
  // lexically made the ASSET<n> numbering depend on those volatile values, so
  // the same Lambda got a different number in CI vs. locally and the snapshot
  // failed in CI only. First-seen order over the deterministic walk is stable
  // regardless of the hash bytes.
  const hashOrder: string[] = [];
  const seen = new Set<string>();
  collectHashes(json, hashOrder, seen);
  const placeholders = new Map<string, string>();
  hashOrder.forEach((hash, index) => {
    placeholders.set(hash, `ASSET${String(index)}`);
  });

  return normalizeNode(json, [], placeholders);
}

/**
 * Walk the tree in a deterministic order recording every 64-hex asset hash the
 * first time it is seen. `order` preserves first-seen order (for stable
 * placeholder numbering); `seen` de-duplicates. The walk order (string, then
 * array items, then object values in insertion order) is identical across
 * machines because the template structure is, so the numbering is stable even
 * though the hash values are not.
 */
function collectHashes(node: unknown, order: string[], seen: Set<string>): void {
  if (typeof node === 'string') {
    for (const match of node.matchAll(ASSET_HASH_GLOBAL)) {
      if (!seen.has(match[0])) {
        seen.add(match[0]);
        order.push(match[0]);
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      collectHashes(item, order, seen);
    }
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const value of Object.values(node)) {
      collectHashes(value, order, seen);
    }
  }
}

/** True for an object key that is pure CDK asset-bundling plumbing. */
function isAssetPlumbingKey(key: string): boolean {
  return (
    ASSET_HASH.test(key) ||
    key.startsWith('AssetParameters') ||
    key.includes('S3Bucket') ||
    key.includes('S3VersionKey')
  );
}

/**
 * Return a normalized copy of `node`, replacing asset hashes with their
 * placeholders, dropping asset-parameter plumbing under `Parameters`,
 * normalizing `aws:asset:*` metadata and the `Analytics` string, and replacing
 * each Lightsail instance `UserData` with a stable placeholder.
 */
function normalizeNode(
  node: unknown,
  path: readonly string[],
  placeholders: ReadonlyMap<string, string>,
): unknown {
  // Replace the ENTIRE UserData value (string or Fn::Base64/Fn::Join wrapper)
  // with a stable placeholder: its gzip+base64 payload varies with CDK token
  // ids and script bytes and is asserted by the user-data tests, not here.
  if (isLightsailUserData(path)) {
    return USER_DATA_PLACEHOLDER;
  }
  if (typeof node === 'string') {
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
      // Delete the generated asset-parameter entries: they are bundling
      // plumbing with hash-derived ids, not real template structure.
      if (underParameters && isAssetPlumbingKey(key)) {
        continue;
      }
      result[key] = normalizeNode(value, [...path, key], placeholders);
    }
    return result;
  }

  return node;
}

describe('EnvironmentStack DNS per mode', { timeout: SUITE_TIMEOUT_MS }, () => {
  describe('route53', () => {
    it('creates a PublicHostedZone for the root domain with DeletionPolicy Delete', () => {
      const { stack } = buildStack('route53');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Route53::HostedZone', 1);
      template.hasResource('AWS::Route53::HostedZone', {
        Properties: { Name: `${ROOT_DOMAIN}.` },
        DeletionPolicy: 'Delete',
      });
    });

    it('renders the HostedZoneNameServers output via Fn::Join', () => {
      const { stack } = buildStack('route53');
      const template = Template.fromStack(stack);

      const outputs = template.findOutputs('*', {
        Value: { 'Fn::Join': Match.anyValue() },
      });
      const nameServerOutputs = Object.entries(outputs).filter(([name]) =>
        name.includes('HostedZoneNameServers'),
      );
      expect(nameServerOutputs).toHaveLength(1);
      const [, output] = nameServerOutputs[0] as [string, { Value: { 'Fn::Join': unknown[] } }];
      // Fn::Join of ',' over the zone's name-server tokens.
      expect(output.Value['Fn::Join'][0]).toBe(',');
    });

    it('creates the forum A records and the six email records in the zone', () => {
      const { stack } = buildStack('route53');
      const template = Template.fromStack(stack);

      // 2 forum A records + DKIM CNAMEs (3) + MX (1) + SPF/DMARC TXT (2) = 8 sets.
      template.resourceCountIs('AWS::Route53::RecordSet', 8);
      template.hasResourceProperties('AWS::Route53::RecordSet', {
        Type: 'A',
        Name: `forum.${ROOT_DOMAIN}.`,
      });
    });

    it('matches the template snapshot', () => {
      const { stack } = buildStack('route53');
      expect(normalizeTemplate(Template.fromStack(stack))).toMatchSnapshot();
    });
  });

  describe('route53-existing', () => {
    it('declares no AWS::Route53::HostedZone resource', () => {
      const { stack } = buildStack('route53-existing', { lookupValue: MATCHING_LOOKUP });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Route53::HostedZone', 0);
    });

    it('creates records using the declared hosted zone id', () => {
      const { stack } = buildStack('route53-existing', { lookupValue: MATCHING_LOOKUP });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Route53::RecordSet', 8);
      // Every record set references the declared literal id, never a Ref to a
      // created zone resource.
      const recordSets = template.findResources('AWS::Route53::RecordSet');
      for (const resource of Object.values(recordSets)) {
        const props = (resource as { Properties: { HostedZoneId: unknown } }).Properties;
        expect(props.HostedZoneId).toBe(DECLARED_ZONE_ID);
      }
    });

    it('throws HostedZoneMismatchError naming the declared id, found id and root domain', () => {
      let caught: unknown;
      try {
        const { stack } = buildStack('route53-existing', {
          lookupValue: { Id: OTHER_ZONE_ID, Name: ROOT_DOMAIN },
        });
        // The lookup resolves while the construct tree is built, so the throw
        // happens during buildStack; produce the template to be safe.
        Template.fromStack(stack);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(HostedZoneMismatchError);
      const mismatch = caught as HostedZoneMismatchError;
      expect(mismatch.declaredId).toBe(DECLARED_ZONE_ID);
      expect(mismatch.lookedUpId).toBe(OTHER_ZONE_ID);
      expect(mismatch.rootDomain).toBe(ROOT_DOMAIN);
      expect(mismatch.message).toContain(DECLARED_ZONE_ID);
      expect(mismatch.message).toContain(OTHER_ZONE_ID);
      expect(mismatch.message).toContain(ROOT_DOMAIN);
    });

    it('does not throw for the DUMMY first-pass sentinel (unseeded lookup)', () => {
      // No lookup context seeded: fromLookup returns the DUMMY sentinel on the
      // first pass, which the construct must not treat as a mismatch.
      expect(() => {
        const { stack } = buildStack('route53-existing');
        Template.fromStack(stack);
      }).not.toThrow();
    });

    it('fails synthesis naming the root domain when no public zone exists', () => {
      // A provider error seeded under the lookup key models "no public hosted
      // zone for the root domain". The context provider records it as an
      // `aws:cdk:error` annotation, which the CDK toolkit elevates to a
      // synthesis failure. The message names the root domain.
      const message = `Could not find any hosted zones in account ${ACCOUNT} with domain name ${ROOT_DOMAIN}`;
      const { stack } = buildStack('route53-existing', {
        lookupValue: { $providerError: message },
      });

      const errors = Annotations.fromStack(stack).findError('*', Match.anyValue());
      const matching = errors.filter(
        (error) => typeof error.entry.data === 'string' && error.entry.data.includes(ROOT_DOMAIN),
      );
      expect(matching.length).toBeGreaterThanOrEqual(1);
    });

    it('matches the template snapshot', () => {
      const { stack } = buildStack('route53-existing', { lookupValue: MATCHING_LOOKUP });
      expect(normalizeTemplate(Template.fromStack(stack))).toMatchSnapshot();
    });
  });

  describe('external', () => {
    it('declares no Route 53 resources at all', () => {
      const { stack } = buildStack('external');
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::Route53::HostedZone', 0);
      template.resourceCountIs('AWS::Route53::RecordSet', 0);
    });

    it('emits each forum A record as DnsRecordName / DnsRecordValue outputs', () => {
      const { stack } = buildStack('external');
      const template = Template.fromStack(stack);

      const nameOutputs = template.findOutputs('*', {
        Value: `forum.${ROOT_DOMAIN}.`,
      });
      expect(Object.keys(nameOutputs).some((name) => name.includes('DnsRecordName'))).toBe(true);

      // One name + one value output per forum (2 forums).
      const allOutputs = template.toJSON().Outputs as Record<string, unknown>;
      const recordNameOutputs = Object.keys(allOutputs).filter((name) =>
        name.includes('DnsRecordName'),
      );
      const recordValueOutputs = Object.keys(allOutputs).filter((name) =>
        name.includes('DnsRecordValue'),
      );
      expect(recordNameOutputs).toHaveLength(2);
      expect(recordValueOutputs).toHaveLength(2);
    });

    it('emits the 18 email record outputs (Name/Type/Value for six records)', () => {
      const { stack } = buildStack('external');
      const template = Template.fromStack(stack);
      const allOutputs = template.toJSON().Outputs as Record<string, { Value: unknown }>;

      const emailRecordIds = ['Dkim1', 'Dkim2', 'Dkim3', 'MailFromMx', 'MailFromSpf', 'Dmarc'];
      for (const id of emailRecordIds) {
        for (const suffix of ['Name', 'Type', 'Value']) {
          const matching = Object.keys(allOutputs).filter((name) =>
            name.includes(`Email${id}${suffix}`),
          );
          expect(matching).toHaveLength(1);
        }
      }

      // The DMARC and SPF TXT values are plain (quoted exactly once by the
      // display value, i.e. not pre-quoted); the stored value is unquoted text.
      const dmarcValue = Object.entries(allOutputs).find(([name]) =>
        name.includes('EmailDmarcValue'),
      );
      expect(dmarcValue?.[1].Value).toContain('v=DMARC1');
      expect(dmarcValue?.[1].Value).not.toContain('"');

      // DKIM record names are absolute: their value is an Fn::Join of the
      // identity's DKIM token GetAtt and a literal trailing '.'.
      const dkimName = Object.entries(allOutputs).find(([name]) => name.includes('EmailDkim1Name'));
      const dkimValue = dkimName?.[1].Value as { 'Fn::Join': [string, unknown[]] };
      expect(dkimValue['Fn::Join'][0]).toBe('');
      const joinParts = dkimValue['Fn::Join'][1];
      expect(joinParts[joinParts.length - 1]).toBe('.');
    });

    it('matches the template snapshot', () => {
      const { stack } = buildStack('external');
      expect(normalizeTemplate(Template.fromStack(stack))).toMatchSnapshot();
    });
  });

  describe('DNS-01 node policy statements per mode', () => {
    /**
     * Count IAM statements with the given Sid across every inline policy on
     * every `AWS::IAM::Role` (the node policy is an inline role policy, not a
     * standalone `AWS::IAM::Policy`).
     */
    function countStatementsWithSid(template: Template, sid: string): number {
      const roles = template.findResources('AWS::IAM::Role');
      let count = 0;
      for (const role of Object.values(roles)) {
        const policies = (
          role as {
            Properties: {
              Policies?: { PolicyDocument: { Statement: { Sid?: string }[] } }[];
            };
          }
        ).Properties.Policies;
        if (policies === undefined) {
          continue;
        }
        for (const policy of policies) {
          count += policy.PolicyDocument.Statement.filter(
            (statement) => statement.Sid === sid,
          ).length;
        }
      }
      return count;
    }

    it('present for DNS-01 forums in route53 mode (one per forum)', () => {
      const { stack } = buildStack('route53');
      const template = Template.fromStack(stack);

      // Both default engines are DNS-01 capable; in a Route 53 mode each forum's
      // node role carries the three scoped ACME statements.
      expect(countStatementsWithSid(template, 'AcmeDns01Change')).toBe(2);
      expect(countStatementsWithSid(template, 'AcmeDns01ReadZone')).toBe(2);
      expect(countStatementsWithSid(template, 'AcmeDns01GetChange')).toBe(2);
    });

    it('present for DNS-01 forums in route53-existing mode', () => {
      const { stack } = buildStack('route53-existing', { lookupValue: MATCHING_LOOKUP });
      const template = Template.fromStack(stack);

      expect(countStatementsWithSid(template, 'AcmeDns01Change')).toBe(2);
      expect(countStatementsWithSid(template, 'AcmeDns01ReadZone')).toBe(2);
      expect(countStatementsWithSid(template, 'AcmeDns01GetChange')).toBe(2);
    });

    it('absent in external mode (HTTP-01 forums get no Route 53 access)', () => {
      const { stack } = buildStack('external');
      const template = Template.fromStack(stack);

      expect(countStatementsWithSid(template, 'AcmeDns01Change')).toBe(0);
      expect(countStatementsWithSid(template, 'AcmeDns01ReadZone')).toBe(0);
      expect(countStatementsWithSid(template, 'AcmeDns01GetChange')).toBe(0);

      // No route53: action appears anywhere in the external-mode template.
      const json = JSON.stringify(template.toJSON());
      expect(json).not.toContain('route53:');
    });
  });
});
