/**
 * L3 construct for one forum's SES sending identity.
 *
 * Every forum sends mail as its own, unique Sender_Address through the
 * Environment's shared SES identity and configuration set. This construct owns
 * the per-forum half of that: an IAM user scoped to send only as that address,
 * plus the two custom resources that manage the user's SMTP credentials and
 * refresh the running instance when they change (Req 11.7, 11.8, 11.15, 11.16,
 * 11.17).
 *
 *  - an {@link User} named `names.sesUser(env, forumId)` under the Environment's
 *    SES user path, with no console password and no managed policies. Its single
 *    inline policy comes from the pure {@link buildSesSenderPolicy} builder,
 *    attached statement by statement through {@link PolicyStatement.fromJson};
 *  - a `Credentials` custom resource backed by the shared per-Environment
 *    SES-credentials provider, which creates the user's IAM access key, derives
 *    the SMTP password and publishes both to SSM. Its `rotationCounter` property
 *    drives rotation: a bump replaces the resource and issues a new key. It
 *    depends on the user so the user exists before a key is created;
 *  - a `Refresh` custom resource backed by the shared per-Environment
 *    email-refresh provider, keyed on the current `accessKeyId`, which tells the
 *    running instance to pull the new credentials from SSM. It depends on the
 *    credentials so the refresh follows the key change.
 *
 * Both providers are created once per Environment in the stack and passed in;
 * this construct never creates its own. It makes no SDK calls at synth and no
 * secret value ever reaches a resource property: the credentials resource holds
 * the secret only in Lambda memory and returns the non-secret access key id.
 */

import { CustomResource, Stack, Tags } from 'aws-cdk-lib';
import { PolicyStatement, User } from 'aws-cdk-lib/aws-iam';
import type { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

import type { EnvironmentModel } from '../../metadata/schema.js';
import { names } from '../naming.js';

import type { EnvironmentEmail } from './environment-email.js';
import { buildSesSenderPolicy } from './sender-policy.js';

/** The per-forum fields {@link SesSender} needs from the validated model. */
export interface SesSenderForum {
  /** The forum's unique id, used in the IAM user name and resource properties. */
  readonly id: string;
  /** The forum's fully expanded Sender_Address (`<local>@<mailDomain>`). */
  readonly senderAddress: string;
  /** Rotation counter; a bump replaces the credentials resource to rotate keys. */
  readonly credentialRotation: number;
}

/** Props for {@link SesSender}. */
export interface SesSenderProps {
  /** The validated Environment block (name, region, mail domain). */
  readonly environment: EnvironmentModel;
  /** The forum this sending identity belongs to. */
  readonly forum: SesSenderForum;
  /** The Environment's shared SES identity, configuration set and topic. */
  readonly email: EnvironmentEmail;
  /** Shared per-Environment provider backing the SES credentials custom resource. */
  readonly credentialsProvider: Provider;
  /** Shared per-Environment provider backing the email-refresh custom resource. */
  readonly refreshProvider: Provider;
}

/**
 * One forum's SES IAM user, inline send policy and credential/refresh custom
 * resources.
 *
 * Exposes {@link user}, {@link credentials}, {@link accessKeyId} and
 * {@link refreshStatus} so the owning forum construct can depend on the
 * credentials (its instance must not boot before the SMTP parameters exist) and
 * surface the refresh outcome as a stack output.
 */
export class SesSender extends Construct {
  /** The forum's SES sender IAM user. */
  readonly user: User;

  /** The custom resource that manages the user's SMTP credentials in SSM. */
  readonly credentials: CustomResource;

  /** The non-secret SES SMTP access key id the forum currently resolves to. */
  readonly accessKeyId: string;

  /** The email-refresh outcome, surfaced through the refresh resource's `Data`. */
  readonly refreshStatus: string;

  constructor(scope: Construct, id: string, props: SesSenderProps) {
    super(scope, id);

    const { environment, forum, email, credentialsProvider, refreshProvider } = props;
    const stack = Stack.of(this);

    // IAM user scoped to this forum, under the Environment's SES user path. No
    // console password, no managed policies: only the inline send policy below.
    const user = new User(this, 'User', {
      userName: names.sesUser(environment.name, forum.id),
      path: names.sesUserPath(environment.name),
    });
    this.user = user;

    // Inline least-privilege send policy: allow sending only as this forum's
    // own Sender_Address on the Environment's identity and configuration set.
    const statements = buildSesSenderPolicy({
      partition: stack.partition,
      region: environment.region,
      account: stack.account,
      mailDomain: environment.mailDomain,
      configurationSetName: email.configurationSetName,
      senderAddress: forum.senderAddress,
    });
    for (const statement of statements) {
      user.addToPolicy(PolicyStatement.fromJson(statement));
    }

    // SES SMTP credentials: creates the IAM access key, derives the SMTP
    // password and publishes both to SSM. The rotation counter drives rotation.
    const credentials = new CustomResource(this, 'Credentials', {
      serviceToken: credentialsProvider.serviceToken,
      properties: {
        environment: environment.name,
        forumId: forum.id,
        rotationCounter: forum.credentialRotation,
      },
    });
    // The user must exist before a key can be created for it.
    credentials.node.addDependency(user);
    this.credentials = credentials;
    this.accessKeyId = credentials.getAttString('AccessKeyId');

    // Email refresh: keyed on the current access key id, it tells the running
    // instance to pull the new credentials. It must follow the key change.
    const refresh = new CustomResource(this, 'Refresh', {
      serviceToken: refreshProvider.serviceToken,
      properties: {
        environment: environment.name,
        forumId: forum.id,
        accessKeyId: this.accessKeyId,
      },
    });
    refresh.node.addDependency(credentials);
    this.refreshStatus = refresh.getAttString('RefreshStatus');

    Tags.of(this).add('community-hub:environment', environment.name);
    Tags.of(this).add('community-hub:forum', forum.id);
  }
}
