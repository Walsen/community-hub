/**
 * The single CloudFormation stack for one Community Hub Environment.
 *
 * Lightsail, Route 53 and SES resources for an Environment all live here: there
 * is exactly one stack per Environment and no `crossRegionReferences`, because
 * Route 53 is global and can be declared from the Environment's own region
 * (Req 12.13). The stack wires the shared constructs in the order their
 * dependencies require and resolves engine adapters only through the injected
 * {@link EngineRegistry}, never by importing a concrete adapter (Req 7.3).
 *
 * Construction order (per the design's EnvironmentStack section):
 *
 *  1. {@link EnvironmentDns} (id `Dns`) — the zone (or lookup, or none) every
 *     record depends on.
 *  2. {@link BootstrapBroker} (id `BootstrapBroker`) — created early so its
 *     function URL is available to every forum's user data. Its per-forum
 *     `FORUMS` config and activation policies are supplied in step 6, after the
 *     forum instances exist (see the broker/forum cycle note below).
 *  3. Three shared custom-resource {@link Provider}s (`LifecycleProvider`,
 *     `SesCredentialsProvider`, `EmailRefreshProvider`), each backing a
 *     `nodejs22.x` Lambda at the matching handler entry with a least-privilege
 *     execution policy.
 *  4. {@link EnvironmentEmail} (id `Email`) — the shared SES identity,
 *     configuration set and bounce/complaint pipeline, plus email DNS records.
 *  5. One {@link ForumInstance} per forum under `Forum-<id>`, each receiving the
 *     broker URL, the DNS and email constructs and the three shared providers.
 *  6. {@link BootstrapBroker.addForums} with the per-forum descriptors collected
 *     from the forum instances, finalizing the broker.
 *
 * **Broker / forum ordering.** A forum instance needs the broker's function URL
 * (embedded in its user data), while the broker needs each forum's static-IP and
 * node-role tokens for its `FORUMS` config and IAM policies. Creating the broker
 * with `forums` in props would be a construction cycle. The broker therefore
 * builds its Lambda and function URL in its constructor (so the URL is available
 * immediately) and accepts the forum descriptors afterward through
 * {@link BootstrapBroker.addForums}, which sets the `FORUMS` environment variable
 * and the activation policies then. The handler contract is unchanged: `FORUMS`
 * is present at deploy time.
 *
 * This stack makes no SDK calls at synth; the only synth-time AWS read is CDK's
 * built-in hosted-zone lookup inside {@link EnvironmentDns}.
 */

import { Stack, type StackProps, Tags } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import type { Construct } from 'constructs';

import type { EngineRegistry } from '../engines/registry.js';
import type { EnvironmentModel, ValidatedModel } from '../metadata/schema.js';

import { BootstrapBroker, type ForumDescriptor } from './bootstrap-broker.js';
import { EnvironmentDns } from './dns/environment-dns.js';
import { EnvironmentEmail } from './email/environment-email.js';
import { ForumInstance } from './forum-instance.js';
import { handlerEntry } from './handler-entry.js';
import { constructIds } from './naming.js';

/** Tag key marking the Environment a resource belongs to. */
const TAG_ENVIRONMENT = 'community-hub:environment';

/** Props for {@link EnvironmentStack}. */
export interface EnvironmentStackProps extends StackProps {
  /** The validated, expanded metadata model for this Environment. */
  readonly model: ValidatedModel;
  /** The engine registry used to resolve each forum's adapter. */
  readonly registry: EngineRegistry;
}

/**
 * The single stack for one Community Hub Environment: its DNS, bootstrap broker,
 * shared SES email resources, shared custom-resource providers and one
 * {@link ForumInstance} per forum.
 */
export class EnvironmentStack extends Stack {
  constructor(scope: Construct, id: string, props: EnvironmentStackProps) {
    super(scope, id, props);

    const { model, registry } = props;
    const environment = model.environment;
    const env = environment.name;

    // Tag the whole stack with the Environment name (Req 3.4).
    Tags.of(this).add(TAG_ENVIRONMENT, env);

    // 1. DNS: the zone (route53), validated lookup (route53-existing) or none
    //    (external). Every record created later depends on it.
    const dns = new EnvironmentDns(this, 'Dns', { environment });

    // 2. Bootstrap broker: created early so its function URL is available to
    //    every forum's user data. FORUMS and policies are supplied in step 6.
    const broker = new BootstrapBroker(this, 'BootstrapBroker', { environment });

    // 3. Shared custom-resource providers, one per Environment, reused by every
    //    forum. Each wraps nodejs22.x Lambda(s) with a least-privilege policy.
    const lifecycleProvider = this.createLifecycleProvider();
    const credentialsProvider = this.createSesCredentialsProvider(environment);
    const refreshProvider = this.createEmailRefreshProvider(environment);

    // 4. Shared SES email resources and the email authentication DNS records.
    const email = new EnvironmentEmail(this, 'Email', { environment, dns });

    // 5. One forum instance per forum, resolving adapters only via the registry.
    const brokerDescriptors: ForumDescriptor[] = [];
    for (const forum of model.forums) {
      const adapter = registry.resolve(forum.engine);
      const forumInstance = new ForumInstance(this, constructIds.forum(forum.id), {
        environment,
        forum,
        adapter,
        dns,
        email,
        brokerUrl: broker.functionUrl.url,
        lifecycleProvider,
        credentialsProvider,
        refreshProvider,
      });
      brokerDescriptors.push(forumInstance.brokerDescriptor);
    }

    // 6. Finalize the broker now that every forum's static-IP and role tokens
    //    exist. This closes the broker/forum cycle described in the class TSDoc.
    broker.addForums(brokerDescriptors);
  }

  /**
   * Build the shared forum-lifecycle provider (`LifecycleProvider`). The handler
   * takes a final manual snapshot and deregisters managed nodes/activations when
   * a forum instance is deleted, so its role needs Lightsail snapshot actions and
   * the SSM activation/node actions, which are not resource-scopable.
   */
  private createLifecycleProvider(): Provider {
    const onEvent = new NodejsFunction(this, 'LifecycleOnEvent', {
      runtime: Runtime.NODEJS_22_X,
      entry: handlerEntry(__dirname, 'forum-lifecycle.ts'),
      handler: 'onEvent',
    });
    const isComplete = new NodejsFunction(this, 'LifecycleIsComplete', {
      runtime: Runtime.NODEJS_22_X,
      entry: handlerEntry(__dirname, 'forum-lifecycle.ts'),
      handler: 'isComplete',
    });

    const lifecyclePolicy = new PolicyStatement({
      sid: 'ForumLifecycle',
      effect: Effect.ALLOW,
      actions: [
        'lightsail:CreateInstanceSnapshot',
        // Required because the handler tags the final snapshot on create;
        // Lightsail checks lightsail:TagResource for tag-on-create.
        'lightsail:TagResource',
        'lightsail:GetInstanceSnapshot',
        'ssm:DescribeActivations',
        'ssm:DescribeInstanceInformation',
        'ssm:DeregisterManagedInstance',
        'ssm:DeleteActivation',
      ],
      // Lightsail and these SSM actions cannot be resource-scoped by ARN.
      resources: ['*'],
    });
    onEvent.addToRolePolicy(lifecyclePolicy);
    isComplete.addToRolePolicy(lifecyclePolicy);

    return new Provider(this, 'LifecycleProvider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
    });
  }

  /**
   * Build the shared SES-credentials provider (`SesCredentialsProvider`). The
   * handler manages each forum's IAM access key and the SSM SMTP parameters, so
   * its role needs access-key actions scoped to the Environment's SES user path
   * and parameter actions scoped to the Environment's parameter prefix.
   */
  private createSesCredentialsProvider(environment: EnvironmentModel): Provider {
    const onEvent = new NodejsFunction(this, 'SesCredentialsOnEvent', {
      runtime: Runtime.NODEJS_22_X,
      entry: handlerEntry(__dirname, 'ses-smtp-credentials.ts'),
      handler: 'onEvent',
    });

    const userArn = this.formatArn({
      service: 'iam',
      region: '',
      resource: 'user',
      resourceName: `community-hub/${environment.name}/*`,
    });
    onEvent.addToRolePolicy(
      new PolicyStatement({
        sid: 'ManageSesUserKeys',
        effect: Effect.ALLOW,
        actions: ['iam:ListAccessKeys', 'iam:CreateAccessKey', 'iam:DeleteAccessKey'],
        resources: [userArn],
      }),
    );

    const parameterArn = this.formatArn({
      service: 'ssm',
      region: environment.region,
      resource: 'parameter',
      resourceName: `community-hub/${environment.name}/*`,
    });
    onEvent.addToRolePolicy(
      new PolicyStatement({
        sid: 'ManageSesSmtpParameters',
        effect: Effect.ALLOW,
        actions: [
          'ssm:PutParameter',
          'ssm:GetParameter',
          'ssm:DeleteParameter',
          'ssm:LabelParameterVersion',
        ],
        resources: [parameterArn],
      }),
    );

    return new Provider(this, 'SesCredentialsProvider', {
      onEventHandler: onEvent,
    });
  }

  /**
   * Build the shared email-refresh provider (`EmailRefreshProvider`). The handler
   * restores the SMTP parameters, finds the forum's online managed node and runs
   * the refresh script via Run Command, so its role needs SSM parameter actions
   * on the Environment prefix, the node-discovery actions and `SendCommand`
   * scoped to the `AWS-RunShellScript` document plus `GetCommandInvocation`.
   */
  private createEmailRefreshProvider(environment: EnvironmentModel): Provider {
    const onEvent = new NodejsFunction(this, 'EmailRefreshOnEvent', {
      runtime: Runtime.NODEJS_22_X,
      entry: handlerEntry(__dirname, 'email-refresh.ts'),
      handler: 'onEvent',
    });
    const isComplete = new NodejsFunction(this, 'EmailRefreshIsComplete', {
      runtime: Runtime.NODEJS_22_X,
      entry: handlerEntry(__dirname, 'email-refresh.ts'),
      handler: 'isComplete',
    });

    const parameterArn = this.formatArn({
      service: 'ssm',
      region: environment.region,
      resource: 'parameter',
      resourceName: `community-hub/${environment.name}/*`,
    });
    const parameterPolicy = new PolicyStatement({
      sid: 'RefreshSmtpParameters',
      effect: Effect.ALLOW,
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [parameterArn],
    });

    // Node discovery cannot be resource-scoped by ARN.
    const discoveryPolicy = new PolicyStatement({
      sid: 'DiscoverForumNode',
      effect: Effect.ALLOW,
      actions: ['ssm:DescribeActivations', 'ssm:DescribeInstanceInformation'],
      resources: ['*'],
    });

    const runShellScriptArn = this.formatArn({
      service: 'ssm',
      region: environment.region,
      account: 'aws',
      resource: 'document',
      resourceName: 'AWS-RunShellScript',
    });
    const sendCommandPolicy = new PolicyStatement({
      sid: 'RunRefreshScript',
      effect: Effect.ALLOW,
      actions: ['ssm:SendCommand'],
      resources: [
        runShellScriptArn,
        this.formatArn({ service: 'ssm', resource: 'managed-instance', resourceName: '*' }),
      ],
    });

    // GetCommandInvocation has no resource type; it is scoped at the command level.
    const invocationPolicy = new PolicyStatement({
      sid: 'PollRefreshCommand',
      effect: Effect.ALLOW,
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    });

    for (const fn of [onEvent, isComplete]) {
      fn.addToRolePolicy(parameterPolicy);
      fn.addToRolePolicy(discoveryPolicy);
      fn.addToRolePolicy(sendCommandPolicy);
      fn.addToRolePolicy(invocationPolicy);
    }

    return new Provider(this, 'EmailRefreshProvider', {
      onEventHandler: onEvent,
      isCompleteHandler: isComplete,
    });
  }
}
