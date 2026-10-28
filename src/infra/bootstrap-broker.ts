/**
 * L3 construct for an Environment's bootstrap broker.
 *
 * One `BootstrapBroker` runs per Environment: a `nodejs22.x` Lambda behind a
 * Lambda function URL that issues single-use, one-hour SSM hybrid activations to
 * forum instances at first boot (Req 2.6). The Lambda code lives in
 * {@link file://./handlers/bootstrap-broker.ts}; this construct only hosts it,
 * wires the non-secret `FORUMS` environment variable, and attaches a
 * least-privilege execution policy.
 *
 * **Security note (unauthenticated HTTP endpoint).** The function URL is created
 * with `authType: NONE`, so it is unauthenticated at the HTTP layer. This is
 * deliberate: a forum instance cannot carry AWS credentials before it has an SSM
 * activation (that is the chicken-and-egg problem the broker exists to solve), so
 * SigV4 (`AWS_IAM`) is not available to the caller. Authorization is instead
 * account ownership of the claimed forum: the handler verifies via `GetInstance`
 * that the forum's own Lightsail instance exists and is running, enforces one
 * registration per forum and a one-hour activation expiry, and returns generic
 * 403/404/409 statuses. (Source IP cannot be used: Lightsail NATs outbound
 * traffic away from the static IP.) The residual exposure and why it is accepted
 * are in the design doc under "Residual exposure"; the README documents this
 * endpoint as unauthenticated at the HTTP layer.
 *
 * This construct makes no SDK calls at synth. The only synth-time guard is the
 * `FORUMS` environment-variable size check below.
 */

import { Duration, Stack, Tags } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { type FunctionUrl, FunctionUrlAuthType, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

import type { EnvironmentModel } from '../metadata/schema.js';

import { handlerEntry } from './handler-entry.js';
import { names } from './naming.js';

/** Tag key marking the Environment a resource belongs to. */
const TAG_ENVIRONMENT = 'community-hub:environment';

/**
 * Maximum serialized length of the `FORUMS` environment-variable value.
 *
 * Lambda caps the total size of all environment variables and their keys at
 * 4 KB. The broker only sets `FORUMS`, and a conservative cap of 3,500 bytes
 * leaves headroom for the key name and the AWS-provided runtime variables while
 * still allowing roughly 25 forums per Environment. Synthesis fails with a clear
 * error beyond this (Req 2.6).
 */
const MAX_FORUMS_ENV_BYTES = 3_500;

/**
 * Non-secret per-forum descriptor the stack passes to the broker. It carries no
 * secret values: only the forum id, its Lightsail instance RESOURCE name, the
 * `<env>-<id>` managed-node name and the node role name the broker passes to SSM.
 * Modelled on
 * the `FORUMS` shape the handler reads from `process.env.FORUMS`.
 */
export interface ForumDescriptor {
  /** Forum id; the key under which this forum appears in the `FORUMS` map. */
  readonly forumId: string;
  /**
   * The forum's Lightsail instance RESOURCE name (deterministic, token-free).
   * The broker authorizes a claim by verifying via `GetInstance` that this
   * instance exists and is running (account ownership). Deterministic so the
   * stack never takes a GetAtt dependency on the instance (which would re-form
   * the broker -> instance -> broker user-data cycle).
   */
  readonly instanceName: string;
  /** The `<env>-<forumId>` name the registered managed node is given. */
  readonly defaultInstanceName: string;
  /**
   * The forum's SSM node role name, passed to `CreateActivation`'s `IamRole` and
   * used to build the `iam:PassRole` ARN DETERMINISTICALLY (from the stack
   * account/partition), so the broker never takes a GetAtt dependency on the
   * node role. A GetAtt here created a broker -> node-role -> static-ip ->
   * instance -> broker (user data) CloudFormation dependency cycle.
   */
  readonly roleName: string;
}

/** Props for {@link BootstrapBroker}. */
export interface BootstrapBrokerProps {
  /** The validated Environment block (name and region). */
  readonly environment: EnvironmentModel;
}

/**
 * The entry file for the broker Lambda, resolved against the source tree so the
 * path is correct under both runtimes. Points at the handler's TypeScript
 * source, whose `handler` export is the Lambda entry point. At `cdk synth` the
 * compiled module's `__dirname` is `dist/src/infra`, which emits only `.js`;
 * {@link handlerEntry} maps it back to `src/infra/handlers/bootstrap-broker.ts`
 * so esbuild can bundle the existing source (see {@link handlerEntry}).
 */
const BROKER_ENTRY = handlerEntry(__dirname, 'bootstrap-broker.ts');

/**
 * Shape of the `FORUMS` environment variable the handler parses: a map from
 * forum id to the non-secret fields it needs.
 */
interface ForumsEnvEntry {
  readonly instanceName: string;
  readonly roleName: string;
  readonly defaultInstanceName: string;
}

/**
 * Build the `FORUMS` environment JSON from the forum descriptors. Emits only the
 * non-secret fields the handler reads and throws when the serialized value would
 * exceed the Lambda environment-variable budget.
 *
 * @param env the Environment name, used only in the error message.
 * @param forums the per-forum descriptors.
 * @returns the serialized JSON to assign to the `FORUMS` environment variable.
 * @throws Error when the serialized value exceeds {@link MAX_FORUMS_ENV_BYTES}.
 */
function buildForumsEnv(env: string, forums: readonly ForumDescriptor[]): string {
  const map: Record<string, ForumsEnvEntry> = {};
  for (const forum of forums) {
    map[forum.forumId] = {
      instanceName: forum.instanceName,
      roleName: forum.roleName,
      defaultInstanceName: forum.defaultInstanceName,
    };
  }
  const serialized = JSON.stringify(map);
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > MAX_FORUMS_ENV_BYTES) {
    throw new Error(
      `bootstrap broker FORUMS config for environment ${env} is ${bytes} bytes, ` +
        `over the ${MAX_FORUMS_ENV_BYTES}-byte Lambda environment limit (about 25 forums); ` +
        'reduce the number of forums in this Environment',
    );
  }
  return serialized;
}

/**
 * Bootstrap broker for an Environment: a `nodejs22.x` Lambda with a function URL
 * that hands out single-use SSM activations to forum instances.
 *
 * Exposes {@link function_} and {@link functionUrl} so the stack can reference
 * them and emit the broker URL as an output.
 *
 * **Construction order.** The Lambda and its function URL are created in the
 * constructor so {@link functionUrl}.`url` is available to every
 * {@link import('./forum-instance.js').ForumInstance} (its user data embeds the
 * broker URL). The per-forum `FORUMS` configuration and the activation IAM
 * policies — both of which depend on per-forum tokens (static IP, role ARN) that
 * only exist once the forum instances are created — are supplied afterward via
 * {@link addForums}. This breaks the broker ↔ forum dependency cycle while
 * keeping the handler contract intact: `FORUMS` is populated at deploy time.
 */
export class BootstrapBroker extends Construct {
  /** The broker Lambda function. */
  readonly function_: NodejsFunction;

  /** The broker's Lambda function URL. Unauthenticated at the HTTP layer. */
  readonly functionUrl: FunctionUrl;

  /** The Environment name, retained for {@link addForums}'s error message. */
  private readonly environmentName: string;

  /** Guards against {@link addForums} being called more than once. */
  private forumsConfigured = false;

  constructor(scope: Construct, id: string, props: BootstrapBrokerProps) {
    super(scope, id);

    const { environment } = props;
    const env = environment.name;
    this.environmentName = env;

    const fn = new NodejsFunction(this, 'Function', {
      functionName: names.broker(env),
      runtime: Runtime.NODEJS_22_X,
      entry: BROKER_ENTRY,
      handler: 'handler',
      timeout: Duration.seconds(30),
    });

    // authType: NONE — unauthenticated at the HTTP layer by design (see the
    // class TSDoc and README). Authorization is the handler's per-forum instance
    // ownership check; forum instances have no AWS credentials to sign with.
    const url = fn.addFunctionUrl({ authType: FunctionUrlAuthType.NONE });

    Tags.of(this).add(TAG_ENVIRONMENT, env);

    this.function_ = fn;
    this.functionUrl = url;
  }

  /**
   * Supply the per-forum descriptors once the forum instances exist.
   *
   * Sets the non-secret `FORUMS` environment variable (with the synth-time size
   * guard) and attaches the two least-privilege activation policies scoped to
   * the forums' default-instance names and node-role ARNs. Called once, after
   * the {@link import('./forum-instance.js').ForumInstance}s are created, so the
   * static-IP and role-ARN tokens are available — resolving the broker ↔ forum
   * cycle without changing what the handler reads at deploy time.
   *
   * @param forums the non-secret per-forum descriptors.
   * @throws Error if called more than once, or if the serialized `FORUMS` value
   * exceeds {@link MAX_FORUMS_ENV_BYTES}.
   */
  addForums(forums: readonly ForumDescriptor[]): void {
    if (this.forumsConfigured) {
      throw new Error('BootstrapBroker.addForums must be called exactly once');
    }
    this.forumsConfigured = true;

    // Synth-time guard: fail clearly before the 4 KB Lambda env limit is hit.
    const forumsEnv = buildForumsEnv(this.environmentName, forums);
    this.function_.addEnvironment('FORUMS', forumsEnv);

    // Build each node-role ARN from its deterministic name + this stack's
    // account/partition rather than a GetAtt, so the PassRole grant creates no
    // dependency on the node-role resources (which would re-form the cycle).
    const stack = Stack.of(this);
    const activationRoleArns = forums.map((forum) =>
      stack.formatArn({
        service: 'iam',
        region: '',
        resource: 'role',
        resourceName: forum.roleName,
      }),
    );

    // The broker authorizes a claim by verifying via `GetInstance` that the
    // forum's own Lightsail instance exists and is running (account ownership).
    // Per the Lightsail Service Authorization Reference, `lightsail:GetInstance`
    // is a Read action that supports NO resource type: it can only be granted on
    // `Resource: "*"`. Scoping it to a specific ARN yields AccessDenied at call
    // time (scoping the earlier GetStaticIp cost a 30-minute broker-claim
    // timeout on a real deploy). `*` is therefore the tightest grant IAM permits;
    // the broker only ever calls it for the forum ids baked into its FORUMS
    // config, so the blast radius is read-only instance metadata in this account.
    this.function_.addToRolePolicy(
      new PolicyStatement({
        sid: 'VerifyForumInstanceOwnership',
        effect: Effect.ALLOW,
        actions: ['lightsail:GetInstance'],
        resources: ['*'],
      }),
    );

    // SSM activation lifecycle. CreateActivation / DeleteActivation /
    // DescribeActivations / DescribeInstanceInformation / AddTagsToResource do
    // NOT support resource-level ARNs or an `ssm:DefaultInstanceName` condition
    // key (that key does not exist). An earlier version guarded all five with
    // `StringEquals ssm:DefaultInstanceName`, which denied the very first call
    // (DescribeActivations) at runtime — a real broker-claim 500. These are
    // account-wide management actions granted on `Resource: "*"`; the handler
    // scopes them functionally by always filtering/creating on the
    // `<env>-<forumId>` DefaultInstanceName and tagging every activation with
    // this Environment. The broker only ever acts on the forum ids baked into
    // its FORUMS config, so the blast radius is this Environment's activations.
    this.function_.addToRolePolicy(
      new PolicyStatement({
        sid: 'ManageForumActivations',
        effect: Effect.ALLOW,
        actions: [
          'ssm:CreateActivation',
          'ssm:DeleteActivation',
          'ssm:DescribeActivations',
          'ssm:DescribeInstanceInformation',
          'ssm:AddTagsToResource',
        ],
        resources: ['*'],
      }),
    );

    // The broker may pass only the per-forum node roles, and only to SSM, so a
    // leaked activation can never be used to register a node under any other role.
    this.function_.addToRolePolicy(
      new PolicyStatement({
        sid: 'PassNodeRolesToSsm',
        effect: Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: activationRoleArns,
        conditions: {
          StringEquals: { 'iam:PassedToService': 'ssm.amazonaws.com' },
        },
      }),
    );
  }
}
