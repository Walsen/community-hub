import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ForumModel } from '../../src/metadata/schema.js';
import {
  buildNodePolicy,
  type NodePolicyInput,
  type NodeStatementJson,
  type NotResourceStatementJson,
} from '../../src/infra/node-role.js';
import type { PolicyStatementJson } from '../../src/infra/tls/acme-policy.js';

/**
 * Property 33: DNS-01 Route 53 permissions cover only the forum's own challenge
 * record.
 *
 * Validates: Requirements 13.6, 13.7, 10.5
 *
 * For arbitrary valid inputs, {@link buildNodePolicy} produces a node policy
 * whose Route 53 access is exactly the three scoped ACME statements, each bound
 * to the forum's static IP and to its own `_acme-challenge.<hostname>` TXT
 * record, its own hosted zone and change polling. HTTP-01 forums get no
 * `route53:` access at all. Independent of the challenge, the secret-scoping
 * statements (read prefix, write apiKey, deny outside prefix) are scoped to only
 * this forum's prefix.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x13d501;

/** Narrow a statement to the `NotResource` deny shape. */
function isNotResource(s: NodeStatementJson): s is NotResourceStatementJson {
  return 'NotResource' in s;
}

/** Narrow a statement to the resource-scoped shape. */
function isResource(s: NodeStatementJson): s is PolicyStatementJson {
  return 'Resource' in s;
}

/** Collect every action string a statement names, as a flat array. */
function actionsOf(s: NodeStatementJson): string[] {
  return typeof s.Action === 'string' ? [s.Action] : [...s.Action];
}

/** True when any action on the statement is a `route53:*` action. */
function hasRoute53Action(s: NodeStatementJson): boolean {
  return actionsOf(s).some((a) => a.startsWith('route53:'));
}

/** Build a minimal {@link ForumModel} carrying only `id` and `secrets.apiKey`. */
function forumModel(id: string, apiKeyParam: string): ForumModel {
  return {
    id,
    secrets: { apiKey: { store: 'ssm', id: apiKeyParam } },
  } as unknown as ForumModel;
}

// --- Arbitraries: valid-ish shapes for each input field. -------------------

/** Environment name: lowercase alphanumeric with internal hyphens. */
const envArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,14}[a-z0-9]$/).filter((s) => s.length >= 2);

/** Forum id: starts with a letter, lowercase alphanumeric, no hyphens. */
const forumIdArb = fc.stringMatching(/^[a-z][a-z0-9]{0,15}$/);

/** 12-digit AWS account id. */
const accountArb = fc.stringMatching(/^[0-9]{12}$/);

/** A plausible AWS region token. */
const regionArb = fc.constantFrom(
  'us-east-1',
  'us-west-2',
  'eu-west-1',
  'ap-southeast-2',
  'eu-central-1',
);

/** AWS partition. */
const partitionArb = fc.constantFrom('aws', 'aws-us-gov', 'aws-cn');

/** Route 53 hosted zone id. */
const zoneIdArb = fc.stringMatching(/^Z[A-Z0-9]{5,20}$/);

/** A fully qualified host `<subdomain>.<rootDomain>`, lowercase, no trailing dot. */
const hostnameArb = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/),
    fc.constantFrom('com', 'org', 'net', 'io', 'dev'),
  )
  .map(([sub, root, tld]) => `${sub}.${root}.${tld}`);

/** Common fields shared by both challenge variants, plus derived values. */
const commonArb = fc.record({
  env: envArb,
  forumId: forumIdArb,
  account: accountArb,
  region: regionArb,
  partition: partitionArb,
  zoneId: zoneIdArb,
  hostname: hostnameArb,
});

/**
 * Build the policy input for a DNS-01 forum. The apiKey parameter lives under
 * the forum's own prefix, matching the metadata loader's prefix rule.
 */
function dns01Input(c: {
  env: string;
  forumId: string;
  account: string;
  region: string;
  partition: string;
  zoneId: string;
  hostname: string;
}): NodePolicyInput {
  const apiKeyParam = `/community-hub/${c.env}/${c.forumId}/api-key`;
  return {
    env: c.env,
    forum: forumModel(c.forumId, apiKeyParam),
    account: c.account,
    region: c.region,
    partition: c.partition,
    challenge: 'dns-01',
    zoneId: c.zoneId,
    hostname: c.hostname,
  };
}

describe('Property 33: DNS-01 Route 53 permissions cover only the forum own challenge record', () => {
  it('grants exactly the three scoped ACME statements for dns-01 (Req 13.6, 13.7)', () => {
    fc.assert(
      fc.property(commonArb, (c) => {
        const input = dns01Input(c);
        const { statements } = buildNodePolicy(input);

        const route53 = statements.filter(hasRoute53Action);
        const sids = route53.map((s) => s.Sid).sort();
        expect(sids).toEqual(['AcmeDns01Change', 'AcmeDns01GetChange', 'AcmeDns01ReadZone']);

        const zoneArn = `arn:${c.partition}:route53:::hostedzone/${c.zoneId}`;

        const change = route53.find((s) => s.Sid === 'AcmeDns01Change');
        expect(change).toBeDefined();
        expect(isResource(change!)).toBe(true);
        const changeStmt = change as PolicyStatementJson;
        expect(changeStmt.Resource).toBe(zoneArn);
        expect(actionsOf(changeStmt)).toEqual(['route53:ChangeResourceRecordSets']);
        const cond = changeStmt.Condition!;
        expect(cond['ForAllValues:StringEquals']).toEqual({
          'route53:ChangeResourceRecordSetsNormalizedRecordNames': [
            `_acme-challenge.${c.hostname}`,
          ],
          'route53:ChangeResourceRecordSetsRecordTypes': ['TXT'],
          'route53:ChangeResourceRecordSetsActions': ['UPSERT', 'DELETE'],
        });
        // No aws:SourceIp condition: the instance egresses from a NAT address.
        expect(cond.IpAddress).toBeUndefined();

        const readZone = route53.find((s) => s.Sid === 'AcmeDns01ReadZone');
        expect(readZone).toBeDefined();
        const readStmt = readZone as PolicyStatementJson;
        expect(readStmt.Resource).toBe(zoneArn);
        expect(actionsOf(readStmt)).toEqual(['route53:ListResourceRecordSets']);
        expect(readStmt.Condition).toBeUndefined();

        const getChange = route53.find((s) => s.Sid === 'AcmeDns01GetChange');
        expect(getChange).toBeDefined();
        const getStmt = getChange as PolicyStatementJson;
        expect(getStmt.Resource).toBe(`arn:${c.partition}:route53:::change/*`);
        expect(actionsOf(getStmt)).toEqual(['route53:GetChange']);
        expect(getStmt.Condition).toBeUndefined();
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('scopes every route53 statement to this forum zone/record with no aws:SourceIp (Req 13.6, 13.7)', () => {
    fc.assert(
      fc.property(commonArb, (c) => {
        const input = dns01Input(c);
        const { statements } = buildNodePolicy(input);

        const zoneArn = `arn:${c.partition}:route53:::hostedzone/${c.zoneId}`;
        const changeArn = `arn:${c.partition}:route53:::change/*`;

        for (const s of statements.filter(hasRoute53Action)) {
          // No route53 statement carries an aws:SourceIp condition (the instance
          // egresses from a NAT address, not its static IP).
          expect(s.Condition?.IpAddress).toBeUndefined();
          // No route53 statement may reference any zone/record other than this
          // forum's own zone ARN (or change/* for polling).
          expect(isResource(s)).toBe(true);
          const resource = (s as PolicyStatementJson).Resource;
          const resources = typeof resource === 'string' ? [resource] : [...resource];
          for (const r of resources) {
            expect(r === zoneArn || r === changeArn).toBe(true);
          }
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('grants zero route53 access for http-01 forums (Req 13.6, 13.7)', () => {
    fc.assert(
      fc.property(
        fc.record({
          env: envArb,
          forumId: forumIdArb,
          account: accountArb,
          region: regionArb,
          partition: partitionArb,
        }),
        (c) => {
          const apiKeyParam = `/community-hub/${c.env}/${c.forumId}/api-key`;
          const input: NodePolicyInput = {
            env: c.env,
            forum: forumModel(c.forumId, apiKeyParam),
            account: c.account,
            region: c.region,
            partition: c.partition,
            challenge: 'http-01',
          };
          const { statements } = buildNodePolicy(input);

          // No statement names any route53 action, anywhere.
          expect(statements.some(hasRoute53Action)).toBe(false);
          const everyAction = statements.flatMap(actionsOf);
          expect(everyAction.some((a) => a.startsWith('route53:'))).toBe(false);
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('scopes secret read/write/deny to only this forum prefix for any challenge (Req 13.6, 10.5)', () => {
    fc.assert(
      fc.property(
        commonArb,
        fc.constantFrom<'dns-01' | 'http-01'>('dns-01', 'http-01'),
        (c, challenge) => {
          const apiKeyParam = `/community-hub/${c.env}/${c.forumId}/api-key`;
          const prefix = `/community-hub/${c.env}/${c.forumId}/`;
          const parameterArn = `arn:${c.partition}:ssm:${c.region}:${c.account}:parameter${prefix}*`;
          const secretArn = `arn:${c.partition}:secretsmanager:${c.region}:${c.account}:secret:${prefix}*`;
          const writeArn = `arn:${c.partition}:ssm:${c.region}:${c.account}:parameter${apiKeyParam}`;

          const input: NodePolicyInput =
            challenge === 'dns-01'
              ? dns01Input(c)
              : {
                  env: c.env,
                  forum: forumModel(c.forumId, apiKeyParam),
                  account: c.account,
                  region: c.region,
                  partition: c.partition,
                  challenge: 'http-01',
                };

          const { statements } = buildNodePolicy(input);

          // Reads are scoped to exactly this forum's parameter/secret prefix.
          const readParams = statements.find((s) => s.Sid === 'ReadForumParameters');
          expect(readParams).toBeDefined();
          expect((readParams as PolicyStatementJson).Resource).toBe(parameterArn);
          const readSecrets = statements.find((s) => s.Sid === 'ReadForumSecrets');
          expect(readSecrets).toBeDefined();
          expect((readSecrets as PolicyStatementJson).Resource).toBe(secretArn);

          // Write targets exactly the apiKey ARN.
          const write = statements.find((s) => s.Sid === 'WriteApiKey');
          expect(write).toBeDefined();
          expect((write as PolicyStatementJson).Resource).toBe(writeArn);

          // The deny's NotResource is exactly the forum's two prefix ARNs.
          const deny = statements.find(isNotResource);
          expect(deny).toBeDefined();
          const notResource = deny!.NotResource;
          const notResources = typeof notResource === 'string' ? [notResource] : [...notResource];
          expect([...notResources].sort()).toEqual([parameterArn, secretArn].sort());
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });
});
