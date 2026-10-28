/**
 * Property test for Route 53 resource placement by DNS mode (task 19.13,
 * Property 28).
 *
 * **Validates: Requirements 3.2, 3.3, 4.3, 10.2, 10.5, 12.8, 12.9, 12.10, 12.11, 12.13**
 *
 * Property 28 states that Route 53 resources are placed by DNS mode, and that
 * `route53-existing` NEVER declares a hosted zone. For an arbitrary set of
 * forums (1–3, Discourse and/or Flarum) the synthesized {@link EnvironmentStack}
 * must satisfy, per mode:
 *
 *  - `route53`: exactly ONE `AWS::Route53::HostedZone` is declared for the root
 *    domain; every forum `A` record and all six email records live in it as
 *    `AWS::Route53::RecordSet`s (Req 3.2, 4.3, 10.2, 12.13).
 *  - `route53-existing` (lookup context seeded offline): ZERO
 *    `AWS::Route53::HostedZone` resources; the same forum `A` and email record
 *    sets are still created, each referencing the declared/looked-up zone id
 *    rather than a created zone (Req 12.8, 12.9, 12.10).
 *  - `external`: ZERO `AWS::Route53::*` resources of any kind; each forum's `A`
 *    record surfaces as `DnsRecordName`/`DnsRecordValue` outputs and the email
 *    records surface as outputs instead of record sets (Req 3.3, 10.5, 12.11).
 *
 * These counts are asserted for arbitrary forum sets across all three modes:
 * the DNS mode is iterated explicitly over {@link DNS_MODES} (so every mode is
 * covered deterministically rather than sampled) and forum sets are generated
 * with distinct schema-valid ids/subdomains/senders, valid bundle ids and the
 * required secrets per engine.
 *
 * Determinism (per the testing steering) mirrors
 * `test/infra/dns/environment-dns.test.ts`: the seed is fixed at `0x5eed` and
 * `numRuns` is small; Lambda bundling is skipped via the
 * `aws:cdk:bundling-stacks: []` app context so synthesis needs no esbuild,
 * Docker or network; and the `route53-existing` hosted-zone lookup is fed
 * through seeded lookup context (the key computed with
 * {@link ContextProvider.getKey} for the `hosted-zone` provider), so no network
 * read happens. Only placeholder `ssm:` Secret_References appear; no secret
 * value is used. On failure fast-check reports the seed and counterexample.
 */

import { App, ContextProvider, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cxschema from 'aws-cdk-lib/cloud-assembly-schema';
import fc from 'fast-check';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import type { ValidatedModel } from '../../../src/metadata/schema.js';
import { EnvironmentStack } from '../../../src/infra/environment-stack.js';

/** Fixed synthesis environment so account/region tokens stay stable. */
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ROOT_DOMAIN = 'example.org';
const ENV_NAME = 'community-test';

/** The declared/looked-up hosted zone id used in `route53-existing`. */
const DECLARED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

/** Fixed seed so any counterexample is reproducible. */
const SEED = 0x5eed;

/**
 * Few runs per mode: each case synthesizes a full {@link EnvironmentStack} with
 * up to three Lambda-bundled forums, so a handful of forum sets per mode
 * (6 × 3 modes = 18 synths) exercises every branch without a slow suite.
 */
const NUM_RUNS = 6;

/** Generous per-test timeout for the synth-heavy property (ms). */
const SYNTH_TEST_TIMEOUT = 180_000;

/**
 * Number of email authentication record sets the Environment always declares in
 * a Route 53 mode: 3 DKIM CNAMEs + 1 MAIL FROM MX + SPF TXT + DMARC TXT.
 */
const EMAIL_RECORD_COUNT = 6;

/** The six email record ids, used to count `external`-mode outputs. */
const EMAIL_RECORD_IDS = ['Dkim1', 'Dkim2', 'Dkim3', 'MailFromMx', 'MailFromSpf', 'Dmarc'] as const;

type DnsMode = 'route53' | 'route53-existing' | 'external';

/** Every DNS mode, iterated so the property covers all three deterministically. */
const DNS_MODES: readonly DnsMode[] = ['route53', 'route53-existing', 'external'];

/** A generated forum description for the metadata document. */
interface ForumSpec {
  readonly id: string;
  readonly engine: 'discourse' | 'flarum';
  readonly subdomain: string;
  readonly senderAddress: string;
  readonly bundleId: string;
}

/**
 * Serialize a metadata document for the forums and DNS mode, with placeholder
 * `ssm:` references only. Flarum forums carry the required `databasePassword`
 * secret and a minimal `trustLevelGroups` mapping; Discourse forums an empty
 * options object.
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
      adminEmail: `ops@${ROOT_DOMAIN}`,
      sshAllowedCidrs: ['203.0.113.0/24'],
      ...(dnsMode === 'route53-existing' ? { hostedZoneId: DECLARED_ZONE_ID } : {}),
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

/**
 * Seed the `HostedZone.fromLookup` context so the `route53-existing` lookup
 * resolves offline to a zone matching the declared id. The lookup key depends
 * only on the provider, root domain, `privateZone` and the account/region, none
 * of which depend on the stack instance, so a throwaway stack computes the same
 * key.
 */
function seedHostedZoneLookup(app: App): void {
  const keyScope = new Stack(createApp(), 'KeyScope', {
    env: { account: ACCOUNT, region: REGION },
  });
  const { key } = ContextProvider.getKey(keyScope, {
    provider: cxschema.ContextProvider.HOSTED_ZONE_PROVIDER,
    props: { domainName: ROOT_DOMAIN, privateZone: false },
  });
  app.node.setContext(key, { Id: DECLARED_ZONE_ID, Name: ROOT_DOMAIN });
}

/** Build and synthesize the stack template for a mode and forum set. */
function synthTemplate(forums: readonly ForumSpec[], dnsMode: DnsMode): Template {
  const registry = createDefaultRegistry();
  const model: ValidatedModel = loadMetadata(metadataYaml(forums, dnsMode), registry);
  const app = createApp();
  if (dnsMode === 'route53-existing') {
    seedHostedZoneLookup(app);
  }
  const stack = new EnvironmentStack(app, 'TestStack', {
    model,
    registry,
    env: { account: ACCOUNT, region: REGION },
  });
  return Template.fromStack(stack);
}

/**
 * An arbitrary set of 1–3 forums with distinct, schema-valid ids, subdomains
 * and sender addresses keyed on the index, random engines and a bundle id that
 * meets the chosen engine's minimum RAM (Discourse ≥ 2048 MB, Flarum ≥ 1024 MB).
 */
const forumsArb: fc.Arbitrary<ForumSpec[]> = fc
  .integer({ min: 1, max: 3 })
  .chain((count) =>
    fc.tuple(
      ...Array.from({ length: count }, (_, index) =>
        fc.record({
          engine: fc.constantFrom<'discourse' | 'flarum'>('discourse', 'flarum'),
          index: fc.constant(index),
        }),
      ),
    ),
  )
  .map((parts) =>
    parts.map((part) => ({
      id: `forum${String(part.index)}`,
      engine: part.engine,
      subdomain: `sub${String(part.index)}`,
      senderAddress: `sender${String(part.index)}@${ROOT_DOMAIN}`,
      // medium_3_0 (4096 MB) clears Discourse's 2048 MB minimum; small_3_0
      // (2048 MB) clears Flarum's 1024 MB minimum. Both are valid bundle ids.
      bundleId: part.engine === 'discourse' ? 'medium_3_0' : 'small_3_0',
    })),
  );

/** The `Outputs` section of a synthesized template, or an empty map. */
function outputsOf(template: Template): Record<string, unknown> {
  return (template.toJSON() as { Outputs?: Record<string, unknown> }).Outputs ?? {};
}

describe('Route 53 placement by DNS mode (Property 28)', () => {
  it(
    'places hosted zones and record sets per mode for arbitrary forum sets',
    () => {
      for (const dnsMode of DNS_MODES) {
        fc.assert(
          fc.property(forumsArb, (forums) => {
            const template = synthTemplate(forums, dnsMode);
            const forumCount = forums.length;
            const expectedRecordSets = forumCount + EMAIL_RECORD_COUNT;

            if (dnsMode === 'route53') {
              // Exactly one managed public hosted zone for the root domain.
              template.resourceCountIs('AWS::Route53::HostedZone', 1);
              template.hasResourceProperties('AWS::Route53::HostedZone', {
                Name: `${ROOT_DOMAIN}.`,
              });

              // All forum A records + the six email records live in the zone.
              template.resourceCountIs('AWS::Route53::RecordSet', expectedRecordSets);
              const aRecords = Object.values(
                template.findResources('AWS::Route53::RecordSet'),
              ).filter((r) => (r as { Properties: { Type: string } }).Properties.Type === 'A');
              expect(aRecords).toHaveLength(forumCount);
            } else if (dnsMode === 'route53-existing') {
              // Never declares a hosted zone resource.
              template.resourceCountIs('AWS::Route53::HostedZone', 0);

              // The same record sets are created, each against the declared id.
              template.resourceCountIs('AWS::Route53::RecordSet', expectedRecordSets);
              const recordSets = template.findResources('AWS::Route53::RecordSet');
              for (const resource of Object.values(recordSets)) {
                const props = (resource as { Properties: { HostedZoneId: unknown } }).Properties;
                expect(props.HostedZoneId).toBe(DECLARED_ZONE_ID);
              }
              const aRecords = Object.values(recordSets).filter(
                (r) => (r as { Properties: { Type: string } }).Properties.Type === 'A',
              );
              expect(aRecords).toHaveLength(forumCount);
            } else {
              // external: no Route 53 resources of any kind.
              template.resourceCountIs('AWS::Route53::HostedZone', 0);
              template.resourceCountIs('AWS::Route53::RecordSet', 0);
              // No route53: action or resource appears anywhere in the template.
              expect(JSON.stringify(template.toJSON())).not.toContain('AWS::Route53::');

              const allOutputs = outputsOf(template);

              // Each forum's A record surfaces as one Name + one Value output.
              const nameOutputs = Object.keys(allOutputs).filter((name) =>
                name.includes('DnsRecordName'),
              );
              const valueOutputs = Object.keys(allOutputs).filter((name) =>
                name.includes('DnsRecordValue'),
              );
              expect(nameOutputs).toHaveLength(forumCount);
              expect(valueOutputs).toHaveLength(forumCount);

              // The email records surface as outputs (Name/Type/Value per record).
              for (const id of EMAIL_RECORD_IDS) {
                for (const suffix of ['Name', 'Type', 'Value'] as const) {
                  const matching = Object.keys(allOutputs).filter((name) =>
                    name.includes(`Email${id}${suffix}`),
                  );
                  expect(matching).toHaveLength(1);
                }
              }
            }
          }),
          { numRuns: NUM_RUNS, seed: SEED },
        );
      }
    },
    SYNTH_TEST_TIMEOUT,
  );
});
