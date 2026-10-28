import { describe, expect, it } from 'vitest';

import type { ForumModel } from '../../src/metadata/schema.js';
import type { SecretReference } from '../../src/metadata/secret-ref.js';
import {
  buildNodePolicy,
  type NodePolicyInput,
  type NodeStatementJson,
  type NotResourceStatementJson,
} from '../../src/infra/node-role.js';
import type { PolicyStatementJson } from '../../src/infra/tls/acme-policy.js';

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const PARTITION = 'aws';
const ENV = 'community-prod';
const FORUM_ID = 'main';
const ZONE_ID = 'Z0123456789ABCDEFGHIJ';
const HOSTNAME = 'forum.example.org';

/**
 * Build a minimal ForumModel carrying only the fields buildNodePolicy reads
 * (`id` and `secrets.apiKey`). The cast keeps the test independent of the rest
 * of the metadata shape.
 */
function forum(apiKey: SecretReference | undefined): ForumModel {
  return { id: FORUM_ID, secrets: { apiKey } } as unknown as ForumModel;
}

const SSM_API_KEY: SecretReference = {
  store: 'ssm',
  id: `/community-hub/${ENV}/${FORUM_ID}/api-key`,
};
const SM_API_KEY: SecretReference = {
  store: 'secretsmanager',
  id: `/community-hub/${ENV}/${FORUM_ID}/api-key`,
};

function input(overrides: Partial<NodePolicyInput> = {}): NodePolicyInput {
  return {
    env: ENV,
    forum: forum(SSM_API_KEY),
    account: ACCOUNT,
    region: REGION,
    partition: PARTITION,
    challenge: 'http-01',
    ...overrides,
  };
}

function statementBySid(statements: readonly NodeStatementJson[], sid: string): NodeStatementJson {
  const found = statements.find((s) => s.Sid === sid);
  expect(found, `expected a statement with Sid ${sid}`).toBeDefined();
  return found as NodeStatementJson;
}

/** Flatten every statement's `Action` into a single string array. */
function allActions(statements: readonly NodeStatementJson[]): string[] {
  const actions: string[] = [];
  for (const statement of statements) {
    const { Action } = statement;
    if (typeof Action === 'string') {
      actions.push(Action);
    } else {
      actions.push(...Action);
    }
  }
  return actions;
}

const parameterArn = `arn:${PARTITION}:ssm:${REGION}:${ACCOUNT}:parameter/community-hub/${ENV}/${FORUM_ID}/*`;
const secretArn = `arn:${PARTITION}:secretsmanager:${REGION}:${ACCOUNT}:secret:/community-hub/${ENV}/${FORUM_ID}/*`;

describe('buildNodePolicy trust policy', () => {
  it('trusts only the SSM service principal scoped to this account and region', () => {
    const { assumeRolePolicy } = buildNodePolicy(input());

    expect(assumeRolePolicy.Version).toBe('2012-10-17');
    expect(assumeRolePolicy.Statement).toHaveLength(1);
    const [statement] = assumeRolePolicy.Statement;

    expect(statement?.Effect).toBe('Allow');
    expect(statement?.Principal).toEqual({ Service: 'ssm.amazonaws.com' });
    expect(statement?.Action).toBe('sts:AssumeRole');
    expect(statement?.Condition).toEqual({
      StringEquals: { 'aws:SourceAccount': ACCOUNT },
      ArnLike: { 'aws:SourceArn': `arn:${PARTITION}:ssm:${REGION}:${ACCOUNT}:*` },
    });
  });
});

describe('buildNodePolicy read statements', () => {
  it('scopes parameter and secret reads to the forum prefix with no aws:SourceIp condition', () => {
    const { statements } = buildNodePolicy(input());

    const params = statementBySid(statements, 'ReadForumParameters') as PolicyStatementJson;
    expect(params.Effect).toBe('Allow');
    expect(params.Action).toEqual(['ssm:GetParameter', 'ssm:GetParameters']);
    expect(params.Resource).toBe(parameterArn);
    // No aws:SourceIp: a Lightsail instance egresses from a NAT address, not its
    // static IP, so an IP condition would deny every legitimate call.
    expect(params.Condition).toBeUndefined();

    const secrets = statementBySid(statements, 'ReadForumSecrets') as PolicyStatementJson;
    expect(secrets.Effect).toBe('Allow');
    expect(secrets.Action).toBe('secretsmanager:GetSecretValue');
    expect(secrets.Resource).toBe(secretArn);
    expect(secrets.Condition).toBeUndefined();
  });
});

describe('buildNodePolicy write statement', () => {
  it('writes an SSM apiKey via ssm:PutParameter on the exact parameter ARN', () => {
    const { statements } = buildNodePolicy(input({ forum: forum(SSM_API_KEY) }));

    const write = statementBySid(statements, 'WriteApiKey') as PolicyStatementJson;
    expect(write.Effect).toBe('Allow');
    expect(write.Action).toBe('ssm:PutParameter');
    expect(write.Resource).toBe(
      `arn:${PARTITION}:ssm:${REGION}:${ACCOUNT}:parameter/community-hub/${ENV}/${FORUM_ID}/api-key`,
    );
    expect(write.Condition).toBeUndefined();
  });

  it('writes a Secrets Manager apiKey via secretsmanager:PutSecretValue with the -?????? suffix', () => {
    const { statements } = buildNodePolicy(input({ forum: forum(SM_API_KEY) }));

    const write = statementBySid(statements, 'WriteApiKey') as PolicyStatementJson;
    expect(write.Effect).toBe('Allow');
    expect(write.Action).toBe('secretsmanager:PutSecretValue');
    expect(write.Resource).toBe(
      `arn:${PARTITION}:secretsmanager:${REGION}:${ACCOUNT}:secret:/community-hub/${ENV}/${FORUM_ID}/api-key-??????`,
    );
    expect(write.Condition).toBeUndefined();
  });
});

describe('buildNodePolicy deny statement', () => {
  it('denies reads outside the forum prefix via NotResource', () => {
    const { statements } = buildNodePolicy(input());

    const deny = statementBySid(statements, 'DenyReadOutsidePrefix') as NotResourceStatementJson;
    expect(deny.Effect).toBe('Deny');
    expect(deny.Action).toEqual(['ssm:GetParameter*', 'secretsmanager:GetSecretValue']);
    expect(deny.NotResource).toEqual([parameterArn, secretArn]);
  });
});

describe('buildNodePolicy ACME DNS-01 statements', () => {
  it('adds the three scoped Route 53 statements for a dns-01 forum', () => {
    const { statements } = buildNodePolicy(
      input({ challenge: 'dns-01', zoneId: ZONE_ID, hostname: HOSTNAME }),
    );

    const change = statementBySid(statements, 'AcmeDns01Change') as PolicyStatementJson;
    expect(change.Action).toBe('route53:ChangeResourceRecordSets');

    const readZone = statementBySid(statements, 'AcmeDns01ReadZone') as PolicyStatementJson;
    expect(readZone.Action).toBe('route53:ListResourceRecordSets');

    const getChange = statementBySid(statements, 'AcmeDns01GetChange') as PolicyStatementJson;
    expect(getChange.Action).toBe('route53:GetChange');

    // None of the Route 53 statements carry an aws:SourceIp condition (the
    // instance egresses from a NAT address, not its static IP).
    expect(change.Condition?.IpAddress).toBeUndefined();
    expect(readZone.Condition).toBeUndefined();
    expect(getChange.Condition).toBeUndefined();

    // Exactly these three route53 actions, no ListHostedZones*.
    const route53Actions = allActions(statements).filter((a) => a.startsWith('route53:'));
    expect(new Set(route53Actions)).toEqual(
      new Set([
        'route53:ChangeResourceRecordSets',
        'route53:ListResourceRecordSets',
        'route53:GetChange',
      ]),
    );
  });

  it('adds no route53 statements for an http-01 forum', () => {
    const { statements } = buildNodePolicy(input({ challenge: 'http-01' }));

    const route53Statements = statements.filter((s) => s.Sid.startsWith('AcmeDns01'));
    expect(route53Statements).toHaveLength(0);

    const route53Actions = allActions(statements).filter((a) => a.startsWith('route53:'));
    expect(route53Actions).toEqual([]);
  });
});

describe('buildNodePolicy least privilege', () => {
  it('references no AmazonSSMManagedInstanceCore managed policy and no kms action', () => {
    const { statements, assumeRolePolicy } = buildNodePolicy(
      input({ challenge: 'dns-01', zoneId: ZONE_ID, hostname: HOSTNAME }),
    );

    const serialized = JSON.stringify({ statements, assumeRolePolicy });
    expect(serialized).not.toContain('AmazonSSMManagedInstanceCore');
    expect(serialized).not.toContain('kms:');
  });
});

describe('buildNodePolicy validation', () => {
  it('throws when the forum declares no apiKey secret', () => {
    expect(() => buildNodePolicy(input({ forum: forum(undefined) }))).toThrow(/no apiKey secret/);
  });

  it('throws for a dns-01 challenge without zoneId', () => {
    expect(() => buildNodePolicy(input({ challenge: 'dns-01', hostname: HOSTNAME }))).toThrow(
      /zoneId or hostname is missing/,
    );
  });

  it('throws for a dns-01 challenge without hostname', () => {
    expect(() => buildNodePolicy(input({ challenge: 'dns-01', zoneId: ZONE_ID }))).toThrow(
      /zoneId or hostname is missing/,
    );
  });
});
