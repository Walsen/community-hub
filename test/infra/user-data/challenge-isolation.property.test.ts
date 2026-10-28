import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { TlsSupport } from '../../../src/engines/engine-adapter.js';
import type { ForumModel } from '../../../src/metadata/schema.js';
import { buildNodePolicy, type NodePolicyInput } from '../../../src/infra/node-role.js';
import { isRoute53Mode, selectChallenge, type DnsMode } from '../../../src/infra/tls/challenge.js';
import { composeInnerScript, composeUserData } from '../../../src/infra/user-data/compose.js';
import { renderTlsScript } from '../../../src/infra/user-data/tls.js';

/**
 * Property 31: Challenge selection and HTTP-01 isolation.
 *
 * Validates: Requirements 13.3, 13.4, 13.5
 *
 * Ties together the four layers that a forum's challenge type flows through:
 * {@link selectChallenge} (the decision), {@link renderTlsScript} (the TLS
 * user-data section), {@link composeInnerScript} (the composed install script
 * header), and {@link buildNodePolicy} (the node IAM policy). The property is
 * CONSISTENCY across all four: a forum that resolves to `http-01` never gets any
 * Route 53 access — not in the TLS script, not in the compose header, and not in
 * its node policy. A forum that resolves to `dns-01` gets Route 53 in all three.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x31a7c0;

// --- Minimal shapes -------------------------------------------------------

/** A minimal {@link TlsSupport}; only `dns01` affects challenge selection. */
function tlsSupport(dns01: boolean): TlsSupport {
  return {
    dns01,
    certPaths: { fullchain: '/etc/ssl/fullchain.pem', privkey: '/etc/ssl/privkey.pem' },
    reloadCommand: 'systemctl reload forum',
    http01Webroot: '/var/www/acme',
  };
}

/** A minimal {@link ForumModel} carrying only `id` and `secrets.apiKey`. */
function forumModel(id: string, apiKeyParam: string): ForumModel {
  return {
    id,
    secrets: { apiKey: { store: 'ssm', id: apiKeyParam } },
  } as unknown as ForumModel;
}

/** Collect every action string a node-policy statement names, as a flat array. */
function actionsOf(action: string | readonly string[]): string[] {
  return typeof action === 'string' ? [action] : [...action];
}

// --- Arbitraries ----------------------------------------------------------

const dnsModeArb = fc.constantFrom<DnsMode>('route53', 'route53-existing', 'external');

const envArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,14}[a-z0-9]$/).filter((s) => s.length >= 2);
const forumIdArb = fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/);
const accountArb = fc.stringMatching(/^[0-9]{12}$/);
const regionArb = fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1', 'ap-southeast-2');
const partitionArb = fc.constantFrom('aws', 'aws-us-gov', 'aws-cn');
const zoneIdArb = fc.stringMatching(/^Z[A-Z0-9]{5,20}$/);

const hostnameArb = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/),
    fc.constantFrom('com', 'org', 'net', 'io', 'dev'),
  )
  .map(([sub, root, tld]) => `${sub}.${root}.${tld}`);

const scenarioArb = fc.record({
  dnsMode: dnsModeArb,
  dns01: fc.boolean(),
  env: envArb,
  forumId: forumIdArb,
  account: accountArb,
  region: regionArb,
  partition: partitionArb,
  zoneId: zoneIdArb,
  hostname: hostnameArb,
  staging: fc.boolean(),
  adminEmail: fc.constantFrom('ops@example.org', 'admin@example.net', 'hub@example.io'),
});

type Scenario = {
  dnsMode: DnsMode;
  dns01: boolean;
  env: string;
  forumId: string;
  account: string;
  region: string;
  partition: string;
  zoneId: string;
  hostname: string;
  staging: boolean;
  adminEmail: string;
};

/** Render all three layers for a scenario, from a single `selectChallenge` call. */
function renderLayers(c: Scenario) {
  const tls = tlsSupport(c.dns01);
  const challenge = selectChallenge(c.dnsMode, tls);
  const apiKeyParam = `/community-hub/${c.env}/${c.forumId}/api-key`;

  const tlsScript = renderTlsScript({
    hostname: c.hostname,
    adminEmail: c.adminEmail,
    challenge,
    staging: c.staging,
    tls,
  });

  const composeInput = {
    env: c.env,
    forumId: c.forumId,
    region: c.region,
    hostname: c.hostname,
    adminEmail: c.adminEmail,
    brokerUrl: 'https://broker.example.internal/activation',
    ...(challenge === 'dns-01' ? { hostedZoneId: c.zoneId } : {}),
    challenge,
    staging: c.staging,
    tls,
    adapterScript: '# adapter install script\nissue_certificate\n',
  };
  const innerScript = composeInnerScript(composeInput);
  // The self-extracting wrapper carries the token-valued CH_HOSTED_ZONE_ID as a
  // plaintext `export` (the gzipped inner script never declares it).
  const wrapper = composeUserData(composeInput);

  const nodeInput: NodePolicyInput =
    challenge === 'dns-01'
      ? {
          env: c.env,
          forum: forumModel(c.forumId, apiKeyParam),
          account: c.account,
          region: c.region,
          partition: c.partition,
          challenge,
          zoneId: c.zoneId,
          hostname: c.hostname,
        }
      : {
          env: c.env,
          forum: forumModel(c.forumId, apiKeyParam),
          account: c.account,
          region: c.region,
          partition: c.partition,
          challenge,
        };
  const nodePolicy = buildNodePolicy(nodeInput);
  const everyNodeAction = nodePolicy.statements.flatMap((s) => actionsOf(s.Action));

  return { tls, challenge, tlsScript, innerScript, wrapper, nodePolicy, everyNodeAction };
}

describe('Property 31: challenge selection and HTTP-01 isolation', () => {
  it('selectChallenge is dns-01 iff (Route 53 mode AND engine dns01), else http-01 (Req 13.3, 13.4, 13.5)', () => {
    fc.assert(
      fc.property(dnsModeArb, fc.boolean(), (dnsMode, dns01) => {
        const challenge = selectChallenge(dnsMode, tlsSupport(dns01));
        const expectDns01 = isRoute53Mode(dnsMode) && dns01;
        expect(challenge).toBe(expectDns01 ? 'dns-01' : 'http-01');
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('http-01 forums get NO Route 53 in the TLS script, compose header, or node policy (Req 13.5)', () => {
    fc.assert(
      fc.property(scenarioArb, (c) => {
        const { challenge, tlsScript, innerScript, everyNodeAction } = renderLayers(c);
        fc.pre(challenge === 'http-01');

        // TLS user-data script: no route53 lego flag, no AWS route53 env vars,
        // and no reference to the DNS-01-only hosted-zone header variable.
        expect(tlsScript).not.toContain('--dns route53');
        expect(tlsScript).not.toContain('AWS_HOSTED_ZONE_ID');
        expect(tlsScript).not.toContain('CH_HOSTED_ZONE_ID');

        // Compose header: no `readonly CH_HOSTED_ZONE_ID=` declaration. (The
        // prelude's descriptive comment names the variable as DNS-01-only, which
        // is not a Route 53 grant; the load-bearing invariant is that no header
        // line declares the zone id for an http-01 forum.)
        expect(innerScript).not.toMatch(/readonly CH_HOSTED_ZONE_ID=/);

        // Node policy: zero route53 actions.
        expect(everyNodeAction.some((a) => a.startsWith('route53:'))).toBe(false);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('dns-01 forums get Route 53 in the TLS script, compose header, and node policy (Req 13.3, 13.4)', () => {
    fc.assert(
      fc.property(scenarioArb, (c) => {
        const { challenge, tlsScript, innerScript, wrapper, nodePolicy, everyNodeAction } =
          renderLayers(c);
        fc.pre(challenge === 'dns-01');

        // TLS user-data script: route53 lego provider and the route53 env var.
        expect(tlsScript).toContain('--dns route53');
        expect(tlsScript).toContain('AWS_HOSTED_ZONE_ID=${CH_HOSTED_ZONE_ID}');

        // The gzipped inner script never declares the (token-valued) zone id;
        // the plaintext wrapper exports it with this forum's zone id.
        expect(innerScript).not.toMatch(/readonly CH_HOSTED_ZONE_ID=/);
        expect(wrapper).toContain(`export CH_HOSTED_ZONE_ID='${c.zoneId}'`);

        // Node policy: the three scoped ACME statements, each route53-only.
        const route53Sids = nodePolicy.statements
          .filter((s) => actionsOf(s.Action).some((a) => a.startsWith('route53:')))
          .map((s) => s.Sid)
          .sort();
        expect(route53Sids).toEqual(['AcmeDns01Change', 'AcmeDns01GetChange', 'AcmeDns01ReadZone']);
        // The change statement is scoped to _acme-challenge.<hostname>.
        const change = nodePolicy.statements.find((s) => s.Sid === 'AcmeDns01Change');
        expect(change).toBeDefined();
        expect(
          change!.Condition!['ForAllValues:StringEquals']![
            'route53:ChangeResourceRecordSetsNormalizedRecordNames'
          ],
        ).toEqual([`_acme-challenge.${c.hostname}`]);
        // And route53 access exists.
        expect(everyNodeAction.some((a) => a.startsWith('route53:'))).toBe(true);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('consistency: all four layers agree on the challenge for any scenario (Req 13.3, 13.4, 13.5)', () => {
    fc.assert(
      fc.property(scenarioArb, (c) => {
        const { challenge, tlsScript, wrapper, everyNodeAction } = renderLayers(c);
        const hasRoute53InTls = tlsScript.includes('--dns route53');
        // DNS-01 forums get a non-empty CH_HOSTED_ZONE_ID export in the wrapper;
        // HTTP-01 forums get an empty one.
        const hasZoneInHeader = /export CH_HOSTED_ZONE_ID='[^']+'/.test(wrapper);
        const hasRoute53InPolicy = everyNodeAction.some((a) => a.startsWith('route53:'));

        const isDns01 = challenge === 'dns-01';
        // Every layer's Route 53 presence equals whether the challenge is dns-01.
        expect(hasRoute53InTls).toBe(isDns01);
        expect(hasZoneInHeader).toBe(isDns01);
        expect(hasRoute53InPolicy).toBe(isDns01);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});
