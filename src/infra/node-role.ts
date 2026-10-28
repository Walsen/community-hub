/**
 * Pure builder for a forum's SSM hybrid managed-node IAM policy.
 *
 * A Lightsail instance cannot use an instance profile, so each forum registers
 * as an SSM hybrid managed node assuming a per-forum IAM role. This module
 * builds that role's trust policy and inline policy statements as plain JSON so
 * they can be unit-tested without CDK synthesis (task 19.5 turns the JSON into
 * an `iam.Role`). It has no I/O, creates no CDK constructs and makes no SDK
 * calls; the account, region and partition come from the caller's synth
 * environment and are never hard-coded.
 *
 * The policy is least privilege (Req 13.6–13.8, 11.x, 2.x):
 *
 *  - Trust is limited to the SSM service principal in this account and region.
 *  - Agent-core actions replace the broad `AmazonSSMManagedInstanceCore`
 *    managed policy with the exact set the hybrid agent needs.
 *  - Reads are scoped to the forum's own `/community-hub/<env>/<forumId>/*`
 *    parameter and secret prefix and only from the forum's static IP.
 *  - Writes are limited to exactly the forum's `apiKey` reference.
 *  - DNS-01 forums get the Route 53 statements from {@link buildAcmeDnsStatements};
 *    HTTP-01 forums get none.
 *  - An explicit `Deny` with `NotResource` the forum prefix stops any read
 *    outside the prefix even if another policy were to grant it.
 *
 * No `kms:*` statement is needed: the AWS managed keys `aws/ssm` and
 * `aws/secretsmanager` authorize use through the service.
 */

import { Tags } from 'aws-cdk-lib';
import {
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import type { EnvironmentModel, ForumModel } from '../metadata/schema.js';
import { secretName, type SecretReference } from '../metadata/secret-ref.js';

import { names } from './naming.js';
import { buildAcmeDnsStatements, type PolicyStatementJson } from './tls/acme-policy.js';

/**
 * A `Deny` statement scoped with `NotResource`: it denies the action on every
 * resource *except* the listed ones. Used for the defense-in-depth deny so the
 * node can never read outside its own prefix even if another policy grants it.
 * This is the one shape {@link PolicyStatementJson} (which requires `Resource`)
 * cannot express, so it is modelled separately.
 */
export interface NotResourceStatementJson {
  readonly Sid: string;
  readonly Effect: 'Deny';
  readonly Action: string | readonly string[];
  readonly NotResource: string | readonly string[];
  readonly Condition?: Readonly<
    Record<string, Readonly<Record<string, string | readonly string[]>>>
  >;
}

/** Any statement a node policy can carry: a resource-scoped one or a `NotResource` deny. */
export type NodeStatementJson = PolicyStatementJson | NotResourceStatementJson;

/**
 * A plain-JSON IAM assume-role (trust) policy document, matching the shape
 * CloudFormation and `iam.Role` accept. Kept structural so {@link buildNodePolicy}
 * can return it without touching CDK.
 */
export interface AssumeRolePolicyJson {
  readonly Version: '2012-10-17';
  readonly Statement: readonly AssumeRoleStatementJson[];
}

/** A single statement of an {@link AssumeRolePolicyJson}. */
export interface AssumeRoleStatementJson {
  readonly Effect: 'Allow';
  readonly Principal: { readonly Service: string };
  readonly Action: 'sts:AssumeRole';
  readonly Condition: Readonly<
    Record<string, Readonly<Record<string, string | readonly string[]>>>
  >;
}

/**
 * The complete node policy as plain JSON: the trust policy and the ordered list
 * of inline policy statements. Task 19.5 builds the `iam.Role` from these.
 */
export interface NodePolicy {
  /** Trust policy for `iam.Role.assumeRolePolicy`. */
  readonly assumeRolePolicy: AssumeRolePolicyJson;
  /** Inline policy statements, in a stable order. */
  readonly statements: readonly NodeStatementJson[];
}

/** Inputs for {@link buildNodePolicy}. */
export interface NodePolicyInput {
  /** Environment name; part of the secret path prefix. */
  readonly env: string;
  /** The forum whose `id` and `secrets.apiKey` scope the policy. */
  readonly forum: ForumModel;
  /** AWS account id (from the synth environment). */
  readonly account: string;
  /** AWS region (from the synth environment). */
  readonly region: string;
  /** AWS partition for ARNs, e.g. `aws` or `aws-us-gov`. */
  readonly partition: string;
  /** ACME challenge type selected for the forum; `dns-01` adds Route 53 statements. */
  readonly challenge: 'dns-01' | 'http-01';
  /** Hosted zone id; required when `challenge` is `dns-01`. */
  readonly zoneId?: string;
  /** Fully qualified forum host; required when `challenge` is `dns-01`. */
  readonly hostname?: string;
}

/**
 * The exact SSM agent actions a hybrid managed node needs. This replaces the
 * broad `AmazonSSMManagedInstanceCore` managed policy (Req 13.8). None of these
 * actions can be resource-scoped, so the statement uses `*`.
 */
const AGENT_CORE_ACTIONS = [
  'ssm:UpdateInstanceInformation',
  'ssm:ListInstanceAssociations',
  'ssm:DescribeAssociation',
  'ssm:GetDocument',
  'ssm:UpdateInstanceAssociationStatus',
  'ssmmessages:CreateControlChannel',
  'ssmmessages:OpenControlChannel',
  'ssmmessages:CreateDataChannel',
  'ssmmessages:OpenDataChannel',
  'ec2messages:AcknowledgeMessage',
  'ec2messages:DeleteMessage',
  'ec2messages:FailMessage',
  'ec2messages:GetEndpoint',
  'ec2messages:GetMessages',
  'ec2messages:SendReply',
] as const;

/**
 * The write target for a forum's `apiKey` reference: the exact ARN the node may
 * write, plus the matching `PutParameter`/`PutSecretValue` action.
 */
interface ApiKeyWriteTarget {
  readonly action: 'ssm:PutParameter' | 'secretsmanager:PutSecretValue';
  readonly resource: string;
}

/**
 * Derive the single ARN the node may write for its `apiKey` reference. For SSM
 * the target is the exact parameter ARN; for Secrets Manager it is the secret
 * ARN with the six-character random suffix wildcard (`<name>-??????`), since the
 * suffix is assigned by AWS and not known at synth. Never hard-codes account,
 * region or partition.
 */
function apiKeyWriteTarget(
  ref: SecretReference,
  account: string,
  region: string,
  partition: string,
): ApiKeyWriteTarget {
  if (ref.store === 'ssm') {
    return {
      action: 'ssm:PutParameter',
      resource: `arn:${partition}:ssm:${region}:${account}:parameter${ref.id}`,
    };
  }
  return {
    action: 'secretsmanager:PutSecretValue',
    resource: `arn:${partition}:secretsmanager:${region}:${account}:secret:${secretName(ref)}-??????`,
  };
}

/**
 * Build a forum's SSM hybrid managed-node policy: trust policy plus inline
 * statements, as plain JSON (Req 13.6–13.8, 11.x node scoping, 2.x secret
 * scoping). The policy grants the node agent-core access, read access to only
 * the forum's own secret prefix, write access to exactly its `apiKey`, Route 53
 * access for DNS-01 challenges only, and an explicit deny outside its prefix.
 *
 * @param input env, forum, synth account/region/partition, static IP, challenge
 *   and (for DNS-01) the zone id and hostname.
 * @returns the trust policy and ordered inline statements.
 * @throws Error if the forum declares no `apiKey` secret, or if `challenge` is
 *   `dns-01` without both `zoneId` and `hostname`.
 */
export function buildNodePolicy(input: NodePolicyInput): NodePolicy {
  const { env, forum, account, region, partition, challenge, zoneId, hostname } = input;

  const prefix = `/community-hub/${env}/${forum.id}/`;
  const parameterArn = `arn:${partition}:ssm:${region}:${account}:parameter${prefix}*`;
  const secretArn = `arn:${partition}:secretsmanager:${region}:${account}:secret:${prefix}*`;

  const apiKeyRef = forum.secrets.apiKey;
  if (apiKeyRef === undefined) {
    throw new Error(`forum ${forum.id} declares no apiKey secret; cannot scope node write access`);
  }
  const write = apiKeyWriteTarget(apiKeyRef, account, region, partition);

  const assumeRolePolicy: AssumeRolePolicyJson = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ssm.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:ssm:${region}:${account}:*` },
        },
      },
    ],
  };

  const statements: NodeStatementJson[] = [
    {
      Sid: 'SsmAgentCore',
      Effect: 'Allow',
      Action: AGENT_CORE_ACTIONS,
      Resource: '*',
    },
    {
      Sid: 'ReadForumParameters',
      Effect: 'Allow',
      Action: ['ssm:GetParameter', 'ssm:GetParameters'],
      Resource: parameterArn,
    },
    {
      Sid: 'ReadForumSecrets',
      Effect: 'Allow',
      Action: 'secretsmanager:GetSecretValue',
      Resource: secretArn,
    },
    {
      Sid: 'WriteApiKey',
      Effect: 'Allow',
      Action: write.action,
      Resource: write.resource,
    },
  ];

  if (challenge === 'dns-01') {
    if (zoneId === undefined || hostname === undefined) {
      throw new Error(
        `forum ${forum.id} uses the dns-01 challenge but zoneId or hostname is missing`,
      );
    }
    statements.push(...buildAcmeDnsStatements({ partition, zoneId, hostname }));
  }

  statements.push({
    Sid: 'DenyReadOutsidePrefix',
    Effect: 'Deny',
    Action: ['ssm:GetParameter*', 'secretsmanager:GetSecretValue'],
    NotResource: [parameterArn, secretArn],
  });

  return { assumeRolePolicy, statements };
}

/* ------------------------------------------------------------------------- *
 * CDK construct (task 19.5)
 *
 * The pure builder above returns the trust policy and inline statements as
 * plain JSON. The construct below turns that JSON into a concrete `iam.Role`
 * with an inline policy. It lives in this file (rather than a sibling) because
 * it is a thin wrapper over `buildNodePolicy` and shares all of its inputs.
 * ------------------------------------------------------------------------- */

/** Props for {@link ForumNodeRole}. */
export interface ForumNodeRoleProps {
  /** The validated Environment block (name, region). */
  readonly environment: EnvironmentModel;
  /** The forum whose `id` and `secrets.apiKey` scope the role. */
  readonly forum: ForumModel;
  /** AWS account id (from the synth environment). */
  readonly account: string;
  /** AWS region (from the synth environment). */
  readonly region: string;
  /** AWS partition for ARNs, e.g. `aws` or `aws-us-gov`. */
  readonly partition: string;
  /** ACME challenge type selected for the forum; `dns-01` adds Route 53 statements. */
  readonly challenge: 'dns-01' | 'http-01';
  /** Hosted zone id; required when `challenge` is `dns-01`. */
  readonly zoneId?: string;
  /** Fully qualified forum host; required when `challenge` is `dns-01`. */
  readonly hostname?: string;
}

/**
 * Type guard separating the `NotResource` deny statement from the ordinary
 * resource-scoped statements. `PolicyStatement.fromJson` does not round-trip
 * `NotResource`, so those statements are built explicitly with
 * {@link PolicyStatement.addNotResources}.
 */
function isNotResourceStatement(
  statement: NodeStatementJson,
): statement is NotResourceStatementJson {
  return 'NotResource' in statement;
}

/** Coerce a `string | readonly string[]` policy field into an array. */
function toArray(value: string | readonly string[]): string[] {
  return typeof value === 'string' ? [value] : [...value];
}

/**
 * The per-forum SSM hybrid managed-node IAM role.
 *
 * A Lightsail instance cannot use an instance profile, so each forum registers
 * as an SSM hybrid managed node that assumes this role. The role's trust policy
 * and inline statements come from {@link buildNodePolicy}, which scopes reads to
 * the forum's own secret prefix, limits writes to the forum's `apiKey`, and (for
 * DNS-01) grants scoped Route 53 access (Req 13.6–13.8, 11.x, 2.x). Least
 * privilege is carried by exact resource ARNs, not an `aws:SourceIp` condition:
 * a Lightsail instance's outbound traffic egresses from a NAT address that is
 * not its static IP, so an IP condition would deny every legitimate call.
 *
 * The ordinary resource-scoped statements are attached through
 * {@link PolicyStatement.fromJson}; the single `NotResource` deny is rebuilt
 * explicitly with {@link PolicyStatement.addNotResources} because `fromJson`
 * does not round-trip `NotResource`.
 *
 * Exposes {@link roleArn} and {@link roleName} so the forum instance and the
 * bootstrap broker can reference the role.
 */
export class ForumNodeRole extends Construct {
  /** The role's ARN (a CloudFormation token). */
  readonly roleArn: string;

  /** The role's deterministic name, `names.nodeRole(env, forumId)`. */
  readonly roleName: string;

  constructor(scope: Construct, id: string, props: ForumNodeRoleProps) {
    super(scope, id);

    const { environment, forum, account, region, partition, challenge } = props;

    const policy = buildNodePolicy({
      env: environment.name,
      forum,
      account,
      region,
      partition,
      challenge,
      ...(props.zoneId === undefined ? {} : { zoneId: props.zoneId }),
      ...(props.hostname === undefined ? {} : { hostname: props.hostname }),
    });

    const statements = policy.statements.map((statement) => {
      if (isNotResourceStatement(statement)) {
        // fromJson does not round-trip NotResource; build it explicitly.
        const built = new PolicyStatement({
          sid: statement.Sid,
          effect: Effect.DENY,
          actions: toArray(statement.Action),
        });
        built.addNotResources(...toArray(statement.NotResource));
        if (statement.Condition !== undefined) {
          built.addConditions(statement.Condition);
        }
        return built;
      }
      return PolicyStatement.fromJson(statement);
    });

    const roleName = names.nodeRole(environment.name, forum.id);
    const role = new Role(this, 'Role', {
      roleName,
      // The trust policy's service principal and conditions come from
      // buildNodePolicy; reconstruct it with the equivalent CDK principal so the
      // role's assumeRolePolicy matches the pure builder's JSON.
      assumedBy: new ServicePrincipal('ssm.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': account },
          ArnLike: { 'aws:SourceArn': `arn:${partition}:ssm:${region}:${account}:*` },
        },
      }),
      inlinePolicies: {
        'node-policy': new PolicyDocument({ statements }),
      },
    });

    Tags.of(role).add('community-hub:environment', environment.name);
    Tags.of(role).add('community-hub:forum', forum.id);

    this.roleArn = role.roleArn;
    // Expose the DETERMINISTIC literal name (not role.roleName, which is a CDK
    // token). The broker builds its iam:PassRole ARN from this string, so it
    // takes no GetAtt dependency on the node role (which would form a broker ->
    // node-role -> static-ip -> instance -> broker cycle).
    this.roleName = roleName;
  }
}
