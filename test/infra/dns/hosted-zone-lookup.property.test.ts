/**
 * Property test for Property 30 — hosted zone lookup validation precedes every
 * record (task 19.14; validates Requirements 12.5, 12.6).
 *
 * In `route53-existing` mode the stack resolves the public zone with
 * {@link HostedZone.fromLookup} and validates its id against the declared
 * `hostedZoneId` BEFORE any DNS record is created (Req 12.5). When the found id
 * differs it stops synthesis with {@link HostedZoneMismatchError} naming the
 * declared id, the found id and the root domain, and NO record set is produced
 * (Req 12.6).
 *
 * This file exercises that contract over arbitrary declared / looked-up id
 * pairs:
 *
 *  - matching ids (identical, or differing only by a `/hostedzone/` prefix on
 *    either side) → synthesis succeeds and the eight record sets exist against
 *    the declared literal id;
 *  - differing ids → synthesis throws {@link HostedZoneMismatchError} naming the
 *    declared id, found id and root domain, and the template is never produced
 *    (so no record set is created);
 *  - the CDK `DUMMY` first-pass sentinel → validation is skipped (no throw).
 *
 * Determinism (per the testing steering): no AWS credentials or network. Lambda
 * bundling is disabled on the {@link App}; the synth-time `fromLookup` is fed
 * through SEEDED LOOKUP CONTEXT computed with {@link ContextProvider.getKey}
 * exactly as `test/infra/dns/environment-dns.test.ts` does. fast-check runs with
 * a fixed seed and a small run count.
 *
 * Secrets: the model uses only `ssm:` Secret_References with placeholder paths;
 * no secret value appears here.
 */

import { App, Stack } from 'aws-cdk-lib';
import { ContextProvider } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cxschema from 'aws-cdk-lib/cloud-assembly-schema';
import fc from 'fast-check';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import type { ValidatedModel } from '../../../src/metadata/schema.js';
import { EnvironmentStack } from '../../../src/infra/environment-stack.js';
import { HostedZoneMismatchError } from '../../../src/shared/errors.js';

/** Fixed synthesis environment so account/region never vary across runs. */
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ROOT_DOMAIN = 'example.org';

/**
 * Fixed fast-check seed and small run counts. Each run is a real CDK synth, so
 * cases that synthesize a full template (eight record sets) use a smaller count
 * than the mismatch case, which throws before any template is produced.
 */
const SEED = 0x5eed;
/** Run count for tests that produce a full template (expensive synth). */
const NUM_RUNS_SYNTH = 10;
/** Run count for the mismatch test, which throws before synthesizing records. */
const NUM_RUNS_THROW = 25;

/** Per-test timeout: a full synth per run needs more than the 5s default. */
const TEST_TIMEOUT_MS = 60_000;

/** The prefix some AWS APIs prepend to a hosted zone id. */
const HOSTED_ZONE_PREFIX = '/hostedzone/';

/** Strip a single leading `/hostedzone/` prefix, mirroring `zone-check.ts`. */
function normalizeZoneId(id: string): string {
  return id.startsWith(HOSTED_ZONE_PREFIX) ? id.slice(HOSTED_ZONE_PREFIX.length) : id;
}

/**
 * A two-forum (Discourse + Flarum) `route53-existing` metadata document with
 * the given declared hosted zone id, serialized to YAML. Placeholder `ssm:`
 * references only.
 */
function metadataYaml(declaredId: string): string {
  const doc: Record<string, unknown> = {
    version: 1,
    environment: {
      name: 'community-test',
      region: REGION,
      availabilityZone: `${REGION}a`,
      dnsMode: 'route53-existing',
      hostedZoneId: declaredId,
      rootDomain: ROOT_DOMAIN,
      adminEmail: 'ops@example.org',
      sshAllowedCidrs: ['203.0.113.0/24'],
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

/** Load a validated model for a `route53-existing` document with this declared id. */
function modelFor(declaredId: string): ValidatedModel {
  return loadMetadata(metadataYaml(declaredId), createDefaultRegistry());
}

/** An {@link App} with Lambda bundling disabled so synth needs no esbuild. */
function createApp(): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

/**
 * Seed the `hosted-zone` lookup context so `fromLookup` resolves offline to the
 * given value. The key depends only on the provider, the domain, `privateZone`
 * and the stack's account/region, so a throwaway stack computes the same key
 * the real stack will read.
 */
function seedHostedZoneLookup(app: App, value: Record<string, string>): void {
  const keyScope = new Stack(createApp(), 'KeyScope', {
    env: { account: ACCOUNT, region: REGION },
  });
  const { key } = ContextProvider.getKey(keyScope, {
    provider: cxschema.ContextProvider.HOSTED_ZONE_PROVIDER,
    props: { domainName: ROOT_DOMAIN, privateZone: false },
  });
  app.node.setContext(key, value);
}

/**
 * Build an {@link EnvironmentStack} for a `route53-existing` model with the
 * given declared id, optionally seeding the looked-up zone value before the
 * stack is instantiated (the lookup resolves while the construct tree is built).
 */
function buildStack(
  declaredId: string,
  options: { lookupValue?: Record<string, string> } = {},
): EnvironmentStack {
  const app = createApp();
  const model = modelFor(declaredId);
  if (options.lookupValue !== undefined) {
    seedHostedZoneLookup(app, options.lookupValue);
  }
  return new EnvironmentStack(app, 'TestStack', {
    model,
    registry: createDefaultRegistry(),
    env: { account: ACCOUNT, region: REGION },
  });
}

/**
 * Generator for a valid bare hosted zone id matching the loader pattern
 * `^Z[A-Z0-9]+$`: a leading `Z` followed by 1–20 uppercase-alphanumeric chars.
 */
const bareZoneIdArb: fc.Arbitrary<string> = fc
  .stringMatching(/^[A-Z0-9]{1,20}$/)
  .map((rest) => `Z${rest}`);

/**
 * How to present a looked-up id to the lookup: bare, or with the
 * `/hostedzone/` prefix. The declared id written to YAML is always bare (the
 * loader rejects a prefixed `hostedZoneId`), so only the looked-up side varies
 * — which still exercises the `/hostedzone/` normalization in the comparison.
 */
const prefixArb: fc.Arbitrary<(id: string) => string> = fc.constantFrom(
  (id: string) => id,
  (id: string) => `${HOSTED_ZONE_PREFIX}${id}`,
);

describe('Property 30: hosted zone lookup validation precedes every record', () => {
  it(
    'matching looked-up id (bare or /hostedzone/-prefixed) synthesizes the eight record sets',
    () => {
      fc.assert(
        fc.property(bareZoneIdArb, prefixArb, (bareId, lookupForm) => {
          // The declared id must be bare to pass the loader's `^Z[A-Z0-9]+$`
          // pattern; the looked-up id may be bare or `/hostedzone/`-prefixed, and
          // normalization must treat the two forms of the same id as equal.
          const declaredId = bareId;
          const lookedUpId = lookupForm(bareId);

          const stack = buildStack(declaredId, {
            lookupValue: { Id: lookedUpId, Name: ROOT_DOMAIN },
          });
          const template = Template.fromStack(stack);

          // 2 forum A records + DKIM CNAMEs (3) + MX (1) + SPF/DMARC TXT (2) = 8.
          template.resourceCountIs('AWS::Route53::RecordSet', 8);
          // No hosted zone resource is ever declared in route53-existing mode.
          template.resourceCountIs('AWS::Route53::HostedZone', 0);

          // Every record set references the declared literal id (normalized bare).
          const recordSets = template.findResources('AWS::Route53::RecordSet');
          for (const resource of Object.values(recordSets)) {
            const props = (resource as { Properties: { HostedZoneId: unknown } }).Properties;
            expect(props.HostedZoneId).toBe(declaredId);
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS_SYNTH },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'differing looked-up id throws HostedZoneMismatchError before any record is created',
    () => {
      fc.assert(
        fc.property(
          bareZoneIdArb,
          bareZoneIdArb,
          prefixArb,
          (declaredBare, otherBare, lookupForm) => {
            // Only interesting when the normalized ids genuinely differ.
            fc.pre(normalizeZoneId(declaredBare) !== normalizeZoneId(otherBare));

            const lookedUpId = lookupForm(otherBare);

            let caught: unknown;
            let template: Template | undefined;
            try {
              const stack = buildStack(declaredBare, {
                lookupValue: { Id: lookedUpId, Name: ROOT_DOMAIN },
              });
              // The lookup resolves while the tree is built, so the throw happens
              // in buildStack; produce the template to be certain and to confirm
              // no record set was created when the check somehow did not throw.
              template = Template.fromStack(stack);
            } catch (error) {
              caught = error;
            }

            expect(caught).toBeInstanceOf(HostedZoneMismatchError);
            const mismatch = caught as HostedZoneMismatchError;
            // Error carries the normalized bare ids and the root domain.
            expect(mismatch.declaredId).toBe(normalizeZoneId(declaredBare));
            expect(mismatch.lookedUpId).toBe(normalizeZoneId(otherBare));
            expect(mismatch.rootDomain).toBe(ROOT_DOMAIN);
            // Message names all three (Req 12.6).
            expect(mismatch.message).toContain(normalizeZoneId(declaredBare));
            expect(mismatch.message).toContain(normalizeZoneId(otherBare));
            expect(mismatch.message).toContain(ROOT_DOMAIN);
            // The throw preceded record creation: no template was produced.
            expect(template).toBeUndefined();
          },
        ),
        { seed: SEED, numRuns: NUM_RUNS_THROW },
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not throw for the DUMMY first-pass sentinel (validation skipped)',
    () => {
      fc.assert(
        fc.property(bareZoneIdArb, (declaredBare) => {
          // No lookup context seeded: fromLookup returns the DUMMY sentinel on the
          // first pass, which must not be treated as a mismatch. Synthesis then
          // proceeds (the toolkit would run the lookup and synthesize again).
          expect(() => {
            const stack = buildStack(declaredBare);
            Template.fromStack(stack);
          }).not.toThrow();
        }),
        { seed: SEED, numRuns: NUM_RUNS_SYNTH },
      );
    },
    TEST_TIMEOUT_MS,
  );
});
