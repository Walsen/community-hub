/**
 * Property test for the Environment's email authentication DNS record set
 * (task 19.11, Property 24).
 *
 * **Validates: Requirements 11.3, 11.4, 11.5**
 *
 * Property 24 states that the email DNS record set is COMPLETE and PLACED by
 * DNS mode. Two facets are exercised:
 *
 *  1. **The pure builder.** For arbitrary `{mailDomain, mailFromDomain, region,
 *     adminEmail, dmarcPolicy, dkim}`, {@link buildEmailDnsRecords} always
 *     returns exactly the six records in their fixed order with their fixed ids
 *     and types; every name is absolute (trailing dot); the DKIM CNAMEs carry
 *     the token targets; the MX is priority 10 at `feedback-smtp.<region>.
 *     amazonses.com`; the SPF TXT is the amazonses include; and the DMARC TXT
 *     sits at `_dmarc.<mailDomain>` with the generated policy. These are
 *     asserted directly over generated inputs (Req 11.3, 11.4, 11.5).
 *
 *  2. **Placement by DNS mode.** A full {@link EnvironmentStack} is synthesized
 *     from a loader-built model for a randomly chosen `dnsMode` and a mail
 *     domain that is either the root domain or a subdomain of it (respecting the
 *     loader's mail rule). In `route53` and `route53-existing` the six email
 *     records become `AWS::Route53::RecordSet`s in the zone; in `external` no
 *     `AWS::Route53::*` resource exists and the eighteen `Email<id>Name/Type/
 *     Value` outputs are present, with values matching {@link displayValue}, TXT
 *     quoted once and DKIM names ending in a dot (Req 11.3, 11.4).
 *
 * Determinism (per the testing steering): `numRuns` is small and the seed is
 * fixed at `0x5eed`, so any counterexample is reproducible. Lambda bundling is
 * skipped by seeding `aws:cdk:bundling-stacks: []` on the {@link App} so synthesis
 * needs no esbuild, Docker or network, and the `route53-existing` hosted-zone
 * lookup is fed through seeded lookup context (no network read). Only `ssm:`
 * placeholder Secret_References appear; no secret value is used.
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
import {
  buildEmailDnsRecords,
  displayValue,
  type DkimToken,
  type EmailDnsRecord,
} from '../../../src/infra/email/email-dns-records.js';

/** Small run count for the pure builder: the property is structural. */
const NUM_RUNS = 40;
/**
 * Fewer runs per mode for the placement property: each case synthesizes a full
 * {@link EnvironmentStack}, so a handful of domains per mode (5 × 3 modes = 15
 * synths) exercises every branch without a slow suite.
 */
const SYNTH_NUM_RUNS = 5;
/** Generous per-test timeout for the synth-heavy placement property (ms). */
const SYNTH_TEST_TIMEOUT = 120_000;
/** Fixed seed so any failure is reproducible. */
const SEED = 0x5eed;

/** The six email record ids in their fixed builder order. */
const EMAIL_RECORD_IDS = ['Dkim1', 'Dkim2', 'Dkim3', 'MailFromMx', 'MailFromSpf', 'Dmarc'] as const;

/** Fixed synthesis environment so account/region tokens stay stable. */
const ACCOUNT = '123456789012';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A single DNS label: lowercase letters/digits, 1–12 chars, no leading digit worry. */
const label = fc
  .stringMatching(/^[a-z][a-z0-9]{0,11}$/)
  .filter((s) => s.length >= 1 && s.length <= 12);

/** A root domain `<label>.<tld>` with a lowercase alphabetic TLD. */
const rootDomainArb: fc.Arbitrary<string> = fc
  .tuple(label, fc.constantFrom('org', 'com', 'net'))
  .map(([name, tld]) => `${name}.${tld}`);

/** A DKIM token: a plausible selector name and target under the amazonses domain. */
const dkimTokenArb: fc.Arbitrary<DkimToken> = fc.record({
  name: label.map((s) => `${s}._domainkey.example.org`),
  value: label.map((s) => `${s}.dkim.amazonses.com`),
});

/** A DMARC policy value. */
const dmarcArb: fc.Arbitrary<'none' | 'quarantine' | 'reject'> = fc.constantFrom(
  'none',
  'quarantine',
  'reject',
);

/** An AWS region string shape (used only inside the host name assertion). */
const regionArb = fc.constantFrom('us-east-1', 'eu-west-1', 'us-west-2', 'ap-southeast-2');

/** Inputs for the pure {@link buildEmailDnsRecords}. */
const builderInputArb = fc.record({
  mailDomain: rootDomainArb,
  mailFromDomain: rootDomainArb.map((d) => `mail.${d}`),
  region: regionArb,
  adminEmail: fc.tuple(label, rootDomainArb).map(([local, domain]) => `${local}@${domain}`),
  dmarcPolicy: dmarcArb,
  dkim: fc.tuple(dkimTokenArb, dkimTokenArb, dkimTokenArb),
});

type DnsMode = 'route53' | 'route53-existing' | 'external';

/**
 * A mail domain built from a root domain. The mail domain is either the root
 * domain itself or a single-label subdomain of it, which is the exact space the
 * loader's mail rule accepts. The DNS mode is iterated explicitly (see below) so
 * every mode is covered deterministically rather than left to sampling.
 */
const domainsArb = fc.record({
  rootDomain: rootDomainArb,
  subLabel: fc.option(label, { nil: undefined }),
});

/** Every DNS mode, so the placement property covers all three deterministically. */
const DNS_MODES: readonly DnsMode[] = ['route53', 'route53-existing', 'external'];

// ---------------------------------------------------------------------------
// Synth harness (mirrors test/infra/dns/environment-dns.test.ts)
// ---------------------------------------------------------------------------

/** The declared/looked-up hosted zone id for `route53-existing`. */
const DECLARED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

/** Serialize a one-forum metadata document for the given mode and domains. */
function metadataYaml(dnsMode: DnsMode, rootDomain: string, mailDomain: string): string {
  const doc: Record<string, unknown> = {
    version: 1,
    environment: {
      name: 'community-test',
      region: 'us-east-1',
      availabilityZone: 'us-east-1a',
      dnsMode,
      rootDomain,
      mailDomain,
      adminEmail: `ops@${rootDomain}`,
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
    ],
  };
  return stringify(doc);
}

/** Create an {@link App} with Lambda bundling disabled. */
function createApp(): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

/**
 * Seed the `HostedZone.fromLookup` context so the `route53-existing` lookup
 * resolves offline to a zone matching the declared id. The lookup key depends
 * only on the provider, root domain, `privateZone` and the account/region, so a
 * throwaway stack computes the same key.
 */
function seedHostedZoneLookup(app: App, rootDomain: string): void {
  const keyScope = new Stack(createApp(), 'KeyScope', {
    env: { account: ACCOUNT, region: 'us-east-1' },
  });
  const { key } = ContextProvider.getKey(keyScope, {
    provider: cxschema.ContextProvider.HOSTED_ZONE_PROVIDER,
    props: { domainName: rootDomain, privateZone: false },
  });
  app.node.setContext(key, { Id: DECLARED_ZONE_ID, Name: rootDomain });
}

/** Build and synthesize the stack template for a mode and domains. */
function synthTemplate(dnsMode: DnsMode, rootDomain: string, mailDomain: string): Template {
  const registry = createDefaultRegistry();
  const model: ValidatedModel = loadMetadata(
    metadataYaml(dnsMode, rootDomain, mailDomain),
    registry,
  );
  const app = createApp();
  if (dnsMode === 'route53-existing') {
    seedHostedZoneLookup(app, rootDomain);
  }
  const stack = new EnvironmentStack(app, 'TestStack', {
    model,
    registry,
    env: { account: ACCOUNT, region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

// ---------------------------------------------------------------------------
// Property 24a: the pure builder is complete and well-formed
// ---------------------------------------------------------------------------

describe('Property 24: email DNS record set is complete (pure builder)', () => {
  it('always returns exactly six records in the fixed order with the fixed ids and types', () => {
    fc.assert(
      fc.property(builderInputArb, (input) => {
        const records = buildEmailDnsRecords(input);

        // Exactly six, in the fixed order, with the fixed ids.
        expect(records).toHaveLength(6);
        expect(records.map((r) => r.id)).toEqual([...EMAIL_RECORD_IDS]);

        // Fixed types per id.
        const expectedTypes: Record<string, EmailDnsRecord['type']> = {
          Dkim1: 'CNAME',
          Dkim2: 'CNAME',
          Dkim3: 'CNAME',
          MailFromMx: 'MX',
          MailFromSpf: 'TXT',
          Dmarc: 'TXT',
        };
        const byId = recordsById(records);
        for (const id of EMAIL_RECORD_IDS) {
          expect(byId[id]?.type).toBe(expectedTypes[id]);
        }

        // Every name is absolute (exactly one trailing dot, no double dot).
        for (const record of records) {
          expect(record.name.endsWith('.')).toBe(true);
          expect(record.name.endsWith('..')).toBe(false);
        }
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });

  it('builds DKIM CNAMEs, the MAIL FROM MX/SPF and the DMARC TXT from the inputs', () => {
    fc.assert(
      fc.property(builderInputArb, (input) => {
        const records = buildEmailDnsRecords(input);
        const byId = recordsById(records);

        // DKIM CNAMEs carry the token target, made absolute.
        const tokens = input.dkim;
        const dkimExpectations: readonly [string, string][] = [
          ['Dkim1', tokens[0].value],
          ['Dkim2', tokens[1].value],
          ['Dkim3', tokens[2].value],
        ];
        for (const [id, value] of dkimExpectations) {
          const record = byId[id];
          if (record === undefined || record.type !== 'CNAME') {
            throw new Error(`expected ${id} to be a CNAME`);
          }
          expect(record.target).toBe(`${value}.`);
        }

        // MX: priority 10 at feedback-smtp.<region>.amazonses.com, at the MAIL FROM domain.
        const mx = byId.MailFromMx;
        if (mx === undefined || mx.type !== 'MX') {
          throw new Error('expected MailFromMx to be an MX');
        }
        expect(mx.priority).toBe(10);
        expect(mx.host).toBe(`feedback-smtp.${input.region}.amazonses.com`);
        expect(mx.name).toBe(`${input.mailFromDomain}.`);

        // SPF TXT: amazonses include at the MAIL FROM domain.
        const spf = byId.MailFromSpf;
        if (spf === undefined || spf.type !== 'TXT') {
          throw new Error('expected MailFromSpf to be a TXT');
        }
        expect(spf.name).toBe(`${input.mailFromDomain}.`);
        expect(spf.text).toBe('v=spf1 include:amazonses.com ~all');

        // DMARC TXT: _dmarc.<mailDomain> with the generated policy and rua.
        const dmarc = byId.Dmarc;
        if (dmarc === undefined || dmarc.type !== 'TXT') {
          throw new Error('expected Dmarc to be a TXT');
        }
        expect(dmarc.name).toBe(`_dmarc.${input.mailDomain}.`);
        expect(dmarc.text).toBe(`v=DMARC1; p=${input.dmarcPolicy}; rua=mailto:${input.adminEmail}`);
      }),
      { numRuns: NUM_RUNS, seed: SEED },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 24b: placement by DNS mode
// ---------------------------------------------------------------------------

describe('Property 24: email DNS record set is placed by DNS mode (synth)', () => {
  it(
    'places all six email records per mode (zone record sets vs outputs)',
    () => {
      for (const dnsMode of DNS_MODES) {
        fc.assert(
          fc.property(domainsArb, ({ rootDomain, subLabel }) => {
            const mailDomain = subLabel === undefined ? rootDomain : `${subLabel}.${rootDomain}`;
            const template = synthTemplate(dnsMode, rootDomain, mailDomain);

            if (dnsMode === 'external') {
              // No Route 53 resources at all in external mode.
              template.resourceCountIs('AWS::Route53::HostedZone', 0);
              template.resourceCountIs('AWS::Route53::RecordSet', 0);

              const allOutputs =
                (template.toJSON() as { Outputs?: Record<string, { Value: unknown }> }).Outputs ??
                {};

              // The eighteen Email<id>{Name,Type,Value} outputs are all present.
              for (const id of EMAIL_RECORD_IDS) {
                for (const suffix of ['Name', 'Type', 'Value'] as const) {
                  const matching = Object.keys(allOutputs).filter((name) =>
                    name.includes(`Email${id}${suffix}`),
                  );
                  expect(matching).toHaveLength(1);
                }
              }

              // The pure builder gives the expected display values; the TXT outputs
              // are quoted once (plain text, no embedded quotes) and DKIM names end
              // with a dot. Compare the deterministic (non-DKIM-token) values.
              const records = buildEmailDnsRecords({
                mailDomain,
                mailFromDomain: `mail.${mailDomain}`,
                region: 'us-east-1',
                adminEmail: `ops@${rootDomain}`,
                dmarcPolicy: 'none',
                dkim: PLACEHOLDER_DKIM,
              });
              const byId = recordsById(records);

              const valueOf = (id: string): unknown => {
                const entry = Object.entries(allOutputs).find(([name]) =>
                  name.includes(`Email${id}Value`),
                );
                return entry?.[1].Value;
              };
              const expectDisplay = (id: string): void => {
                const record = byId[id];
                if (record === undefined) {
                  throw new Error(`missing record ${id}`);
                }
                expect(valueOf(id)).toBe(displayValue(record));
              };

              // SPF and DMARC values are plain text: quoted exactly once by the
              // display value (so the stored value carries no double-quote).
              expectDisplay('MailFromSpf');
              expectDisplay('Dmarc');
              expect(String(valueOf('MailFromSpf'))).not.toContain('"');
              expect(String(valueOf('Dmarc'))).not.toContain('"');

              // MX display value is "10 feedback-smtp...".
              expectDisplay('MailFromMx');
              expect(String(valueOf('MailFromMx')).startsWith('10 ')).toBe(true);

              // DKIM names are absolute: the rendered Name output is an Fn::Join
              // whose final literal is '.'.
              const dkimNameEntry = Object.entries(allOutputs).find(([name]) =>
                name.includes('EmailDkim1Name'),
              );
              const dkimName = dkimNameEntry?.[1].Value as { 'Fn::Join'?: [string, unknown[]] };
              expect(dkimName['Fn::Join']).toBeDefined();
              const parts = (dkimName['Fn::Join'] as [string, unknown[]])[1];
              expect(parts[parts.length - 1]).toBe('.');
            } else {
              // Route 53 modes: the six email records are record sets in the zone.
              // One forum A record + 3 DKIM CNAME + 1 MX + 2 TXT = 6 email + 1 = 7.
              template.resourceCountIs('AWS::Route53::RecordSet', 7);

              const recordSets = template.findResources('AWS::Route53::RecordSet');
              const byType = (t: string): unknown[] =>
                Object.values(recordSets).filter(
                  (r) => (r as { Properties: { Type: string } }).Properties.Type === t,
                );
              // 3 CNAME (DKIM) + 1 MX + 1 A (forum) + the two TXT records.
              expect(byType('CNAME')).toHaveLength(3);
              expect(byType('MX')).toHaveLength(1);
              expect(byType('TXT')).toHaveLength(2);
              expect(byType('A')).toHaveLength(1);

              // No email Name/Type/Value outputs leak into the Route 53 modes.
              const allOutputs =
                (template.toJSON() as { Outputs?: Record<string, unknown> }).Outputs ?? {};
              const emailValueOutputs = Object.keys(allOutputs).filter((name) =>
                /Email(Dkim[123]|MailFromMx|MailFromSpf|Dmarc)(Name|Type|Value)/.test(name),
              );
              expect(emailValueOutputs).toHaveLength(0);
            }
          }),
          { numRuns: SYNTH_NUM_RUNS, seed: SEED },
        );
      }
    },
    SYNTH_TEST_TIMEOUT,
  );
});

/** Index records by their fixed id. Values may be absent for a missing id. */
function recordsById(records: readonly EmailDnsRecord[]): Partial<Record<string, EmailDnsRecord>> {
  const map: Record<string, EmailDnsRecord> = {};
  for (const record of records) {
    map[record.id] = record;
  }
  return map;
}

/** A fixed DKIM token triple used only to compute expected display values. */
const PLACEHOLDER_DKIM: readonly [DkimToken, DkimToken, DkimToken] = [
  { name: 'a._domainkey.example.org', value: 'a.dkim.amazonses.com' },
  { name: 'b._domainkey.example.org', value: 'b.dkim.amazonses.com' },
  { name: 'c._domainkey.example.org', value: 'c.dkim.amazonses.com' },
];
