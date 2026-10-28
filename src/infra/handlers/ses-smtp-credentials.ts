/**
 * SES SMTP credentials custom-resource handler.
 *
 * This backs the `Forum-<forumId>/SesCredentials` custom resource: one provider
 * per Environment (`onEvent` only), one resource per forum. Its job is to manage
 * the IAM access key of the forum's SES sender user and to publish the derived
 * SMTP credentials into SSM Parameter Store, where the instance fetches them at
 * runtime. It is the only deploy-time code that ever holds a secret, and only
 * ever in Lambda memory: the IAM secret access key and the derived SMTP password
 * never appear in resource properties, `Data`, physical ids, logs or errors. The
 * custom-resource response sets `NoEcho: true` as a second line of defence.
 *
 * The physical id encodes the rotation counter and the (non-secret) access key
 * id: `${env}-${forumId}-ses-r${counter}-${accessKeyId}`. A counter bump changes
 * the id, so CloudFormation replaces the resource (Create new, then Delete old in
 * the cleanup phase), which is how rotation is driven.
 *
 * Phases:
 * - Create (first deploy, forum add, or replacement after a counter change):
 *   enforce IAM's two-key-per-user limit by deleting any key that is not the one
 *   currently named in `ses-smtp-username` (orphans of a failed run); if a slot
 *   still cannot be freed, fail with a typed {@link SesCredentialError}. Then
 *   create a key, derive the SMTP password, store password (SecureString) and
 *   username (plain String) in SSM, and label the password version with the
 *   access key id so a later refresh can restore it.
 * - Update with the same counter: no IAM or SSM calls; echo the existing id.
 * - Update with a different counter: same as Create with the new id.
 * - Delete: delete the access key named in the physical id (tolerating one that
 *   is already gone); if `ses-smtp-username` still names this key and the user
 *   has no other key, delete both parameters (tolerating already-deleted ones).
 *
 * Every SDK client, the clock, the logger and the redactor are injected so the
 * handler is unit-testable with fakes; the thin Lambda entry point at the bottom
 * builds the real dependencies.
 */

import {
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
  IAMClient,
  ListAccessKeysCommand,
  type AccessKeyMetadata,
} from '@aws-sdk/client-iam';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  LabelParameterVersionCommand,
  ParameterType,
  PutParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { stripServiceToken } from './resource-properties.js';

import { SesCredentialError } from '../../shared/errors.js';
import { deriveSesSmtpPassword } from '../email/smtp-password.js';
import { names } from '../naming.js';
import { Redactor, createLogger, type Logger } from '../../shared/logger.js';

/** Key under custom-resource `Data` carrying the non-secret SMTP access key id. */
const DATA_ACCESS_KEY_ID = 'AccessKeyId';

/**
 * AWS SDK error `name` values meaning the referenced entity is already gone. A
 * Delete that hits one of these is tolerated so a destroy is never wedged.
 */
const NOT_FOUND_ERROR_NAMES: ReadonlySet<string> = new Set(['NoSuchEntity', 'ParameterNotFound']);

/**
 * The subset of the CloudFormation custom-resource event the handler depends
 * on. The provider framework passes a richer object; only these fields are read
 * and `ResourceProperties` is validated defensively before use.
 */
export interface SesCredentialsEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties?: unknown;
}

/** Response returned from the `onEvent` phase. */
export interface SesCredentialsResponse {
  readonly PhysicalResourceId: string;
  readonly Data?: Readonly<Record<string, string>>;
  /** Always true: masks the response so no value is echoed by CloudFormation. */
  readonly NoEcho: true;
}

/**
 * Resource properties the custom resource is created with. These are plain,
 * non-secret identifiers used to derive deterministic names and the physical id.
 * `rotationCounter` arrives as a string because CloudFormation stringifies
 * custom-resource properties; it is coerced to a non-negative integer.
 */
const propsSchema = z
  .object({
    environment: z.string().min(1),
    forumId: z.string().min(1),
    rotationCounter: z.coerce.number().int().nonnegative(),
  })
  .strict();

/** Validated resource properties. */
export type SesCredentialsProps = z.infer<typeof propsSchema>;

/** Injected dependencies for {@link createSesSmtpCredentialsHandler}. */
export interface SesCredentialsDeps {
  /** IAM client used to list, create and delete the forum SES user's access keys. */
  readonly iam: Pick<IAMClient, 'send'>;
  /** SSM client used to store, label and delete the SMTP parameters. */
  readonly ssm: Pick<SSMClient, 'send'>;
  /** AWS region, required to derive the SMTP password for that region's endpoint. */
  readonly region: string;
  /** Clock, injected for determinism in tests. */
  readonly now: () => Date;
  /** Structured logger. No secret value is ever passed to it. */
  readonly logger: Logger;
  /** Redactor the secret access key and derived password are registered with. */
  readonly redactor: Redactor;
}

/** Extract an AWS SDK error `name` without echoing any message body. */
function errorName(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const { name } = error;
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
  }
  return 'UnknownError';
}

/** True when an error indicates the referenced entity no longer exists. */
function isNotFound(error: unknown): boolean {
  return NOT_FOUND_ERROR_NAMES.has(errorName(error));
}

/**
 * Validate and narrow the event's `ResourceProperties`.
 *
 * @throws SesCredentialError when the properties are missing or malformed, so a
 *   misconfigured resource surfaces a typed error rather than an unchecked
 *   property access.
 */
function parseProps(raw: unknown): SesCredentialsProps {
  const result = propsSchema.safeParse(raw);
  if (!result.success) {
    throw new SesCredentialError({
      forumId: 'unknown',
      operation: 'ParseResourceProperties',
      awsErrorName: 'InvalidResourceProperties',
    });
  }
  return result.data;
}

/** Access key id encoded in a physical id of the form `<env>-<forumId>-ses-r<n>-<keyId>`. */
function accessKeyIdFromPhysicalId(physicalId: string): string | undefined {
  const marker = '-ses-r';
  const markerIndex = physicalId.lastIndexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }
  const afterMarker = physicalId.slice(markerIndex + marker.length);
  const dashIndex = afterMarker.indexOf('-');
  if (dashIndex < 0) {
    return undefined;
  }
  const keyId = afterMarker.slice(dashIndex + 1);
  return keyId.length > 0 ? keyId : undefined;
}

/**
 * Create the `onEvent` handler from injected dependencies.
 *
 * Implements the discriminated behaviour per `RequestType` described in the
 * module header. Any SDK failure that is not a tolerated not-found becomes a
 * typed {@link SesCredentialError} carrying the operation name and AWS error
 * `name` only.
 *
 * @param deps - Injected SDK clients, region, clock, logger and redactor.
 * @returns An async `onEvent` function for the CDK Provider framework.
 */
export function createSesSmtpCredentialsHandler(
  deps: SesCredentialsDeps,
): (event: SesCredentialsEvent) => Promise<SesCredentialsResponse> {
  const { iam, ssm, region, logger, redactor } = deps;

  return async (event: SesCredentialsEvent): Promise<SesCredentialsResponse> => {
    const requestType = event.RequestType;

    switch (requestType) {
      case 'Create':
        return provision(parseProps(stripServiceToken(event.ResourceProperties)));
      case 'Update': {
        const props = parseProps(stripServiceToken(event.ResourceProperties));
        const desiredId = physicalIdForNewKey(props, event.PhysicalResourceId);
        // Same counter means the physical id would be unchanged; do nothing.
        if (event.PhysicalResourceId !== undefined && desiredId === event.PhysicalResourceId) {
          logger.info('ses credentials update no-op (same counter)', {
            environment: props.environment,
            forumId: props.forumId,
            rotationCounter: props.rotationCounter,
          });
          return { PhysicalResourceId: event.PhysicalResourceId, NoEcho: true };
        }
        return provision(props);
      }
      case 'Delete':
        return destroy(
          parseProps(stripServiceToken(event.ResourceProperties)),
          event.PhysicalResourceId,
        );
      default: {
        const exhaustive: never = requestType;
        throw new SesCredentialError({
          forumId: 'unknown',
          operation: 'OnEvent',
          awsErrorName: `UnknownRequestType:${String(exhaustive)}`,
        });
      }
    }
  };

  /**
   * Compute what the physical id would be if a counter change forced a new key.
   * Only the counter is knowable here; when the counter matches the one encoded
   * in the current physical id, we reuse that exact id (so the no-op compares
   * equal). The counter is encoded as `-ses-r<counter>-`.
   */
  function physicalIdForNewKey(
    props: SesCredentialsProps,
    currentPhysicalId: string | undefined,
  ): string | undefined {
    if (currentPhysicalId === undefined) {
      return undefined;
    }
    const prefix = `${props.environment}-${props.forumId}-ses-r${props.rotationCounter}-`;
    return currentPhysicalId.startsWith(prefix) ? currentPhysicalId : `${prefix}pending`;
  }

  /**
   * Create a fresh access key, derive its SMTP password and publish both to SSM,
   * freeing an IAM key slot first if the two-key limit is already reached.
   */
  async function provision(props: SesCredentialsProps): Promise<SesCredentialsResponse> {
    const userName = names.sesUser(props.environment, props.forumId);
    const usernameParam = names.sesParameter(props.environment, props.forumId, 'username');
    const passwordParam = names.sesParameter(props.environment, props.forumId, 'password');

    await freeKeySlotIfNeeded(props, userName, usernameParam);

    const created = await createAccessKey(props, userName);
    const physicalId = names.sesCredentialsPhysicalId(
      props.environment,
      props.forumId,
      props.rotationCounter,
      created.accessKeyId,
    );

    await putParameters(props, passwordParam, usernameParam, created.accessKeyId, created.password);

    logger.info('ses credentials provisioned', {
      environment: props.environment,
      forumId: props.forumId,
      rotationCounter: props.rotationCounter,
      accessKeyId: created.accessKeyId,
    });
    return {
      PhysicalResourceId: physicalId,
      Data: { [DATA_ACCESS_KEY_ID]: created.accessKeyId },
      NoEcho: true,
    };
  }

  /**
   * Enforce IAM's two-access-key-per-user limit. When the user already has two
   * keys, delete any key that is not the one currently named in
   * `ses-smtp-username` (an orphan of a failed run). If no slot can be freed
   * safely, fail with a typed error.
   */
  async function freeKeySlotIfNeeded(
    props: SesCredentialsProps,
    userName: string,
    usernameParam: string,
  ): Promise<void> {
    const keys = await listAccessKeys(props, userName);
    if (keys.length < 2) {
      return;
    }

    const currentKeyId = await readParameterValue(usernameParam);
    const deletable = keys
      .map((key) => key.AccessKeyId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .filter((id) => id !== currentKeyId);

    if (deletable.length === 0) {
      logger.error('ses user already has two active access keys', {
        environment: props.environment,
        forumId: props.forumId,
        userName,
      });
      throw new SesCredentialError({
        forumId: props.forumId,
        operation: 'ListAccessKeys',
        awsErrorName: 'TwoAccessKeyLimit',
      });
    }

    for (const id of deletable) {
      await deleteAccessKey(props, userName, id);
    }
  }

  /** List the forum SES user's access keys, following pagination. */
  async function listAccessKeys(
    props: SesCredentialsProps,
    userName: string,
  ): Promise<AccessKeyMetadata[]> {
    const metadata: AccessKeyMetadata[] = [];
    let marker: string | undefined;
    try {
      do {
        const output = await iam.send(
          new ListAccessKeysCommand({
            UserName: userName,
            ...(marker === undefined ? {} : { Marker: marker }),
          }),
        );
        for (const key of output.AccessKeyMetadata ?? []) {
          metadata.push(key);
        }
        marker = output.IsTruncated === true ? output.Marker : undefined;
      } while (marker !== undefined && marker.length > 0);
    } catch (error) {
      throw credentialError(props, 'ListAccessKeys', error);
    }
    return metadata;
  }

  /**
   * Create one access key, register its secret and derived SMTP password with
   * the redactor immediately, and return the non-secret access key id together
   * with the derived password. The password is carried only in memory; the
   * caller stores it and never logs it.
   */
  async function createAccessKey(
    props: SesCredentialsProps,
    userName: string,
  ): Promise<{ accessKeyId: string; password: string }> {
    let accessKeyId: string | undefined;
    let secretAccessKey: string | undefined;
    try {
      const output = await iam.send(new CreateAccessKeyCommand({ UserName: userName }));
      accessKeyId = output.AccessKey?.AccessKeyId;
      secretAccessKey = output.AccessKey?.SecretAccessKey;
    } catch (error) {
      throw credentialError(props, 'CreateAccessKey', error);
    }
    if (
      typeof accessKeyId !== 'string' ||
      accessKeyId.length === 0 ||
      typeof secretAccessKey !== 'string' ||
      secretAccessKey.length === 0
    ) {
      throw new SesCredentialError({
        forumId: props.forumId,
        operation: 'CreateAccessKey',
        awsErrorName: 'MissingAccessKeyMaterial',
      });
    }
    // Register the secret (and the derived password) with the redactor before
    // any further log call so neither can ever leak.
    redactor.register(secretAccessKey);
    const password = deriveSesSmtpPassword(secretAccessKey, region);
    redactor.register(password);
    return { accessKeyId, password };
  }

  /**
   * Store the SMTP password (SecureString, AWS managed key) and username (plain
   * String), labelling the password version with the access key id so a later
   * refresh can restore the matching password.
   */
  async function putParameters(
    props: SesCredentialsProps,
    passwordParam: string,
    usernameParam: string,
    accessKeyId: string,
    password: string,
  ): Promise<void> {
    try {
      const putPassword = await ssm.send(
        new PutParameterCommand({
          Name: passwordParam,
          Value: password,
          Type: ParameterType.SECURE_STRING,
          Overwrite: true,
        }),
      );
      const version = putPassword.Version;
      if (typeof version === 'number') {
        await ssm.send(
          new LabelParameterVersionCommand({
            Name: passwordParam,
            ParameterVersion: version,
            Labels: [accessKeyId],
          }),
        );
      }
      await ssm.send(
        new PutParameterCommand({
          Name: usernameParam,
          Value: accessKeyId,
          Type: ParameterType.STRING,
          Overwrite: true,
        }),
      );
    } catch (error) {
      throw credentialError(props, 'PutParameter', error);
    }
  }

  /** Read a parameter value, returning `undefined` when it does not exist. */
  async function readParameterValue(name: string): Promise<string | undefined> {
    try {
      const output = await ssm.send(new GetParameterCommand({ Name: name }));
      return output.Parameter?.Value;
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
  }

  /** Delete one access key, tolerating one that is already gone. */
  async function deleteAccessKey(
    props: SesCredentialsProps,
    userName: string,
    accessKeyId: string,
  ): Promise<void> {
    try {
      await iam.send(new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId }));
      logger.info('deleted ses access key', {
        environment: props.environment,
        forumId: props.forumId,
        accessKeyId,
      });
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw credentialError(props, 'DeleteAccessKey', error);
    }
  }

  /**
   * Delete the access key named in the physical id and, when the stored username
   * still names that key and the user has no other key, delete both parameters.
   * Tolerates already-deleted keys and parameters so a destroy is never wedged.
   */
  async function destroy(
    props: SesCredentialsProps,
    physicalId: string | undefined,
  ): Promise<SesCredentialsResponse> {
    const id = physicalId ?? '';
    const accessKeyId = physicalId === undefined ? undefined : accessKeyIdFromPhysicalId(id);
    const userName = names.sesUser(props.environment, props.forumId);
    const usernameParam = names.sesParameter(props.environment, props.forumId, 'username');
    const passwordParam = names.sesParameter(props.environment, props.forumId, 'password');

    if (accessKeyId === undefined) {
      logger.info('ses credentials delete without a key id, nothing to do', {
        environment: props.environment,
        forumId: props.forumId,
      });
      return { PhysicalResourceId: id, NoEcho: true };
    }

    await deleteAccessKey(props, userName, accessKeyId);

    const currentKeyId = await readParameterValue(usernameParam);
    const remainingKeys = await listAccessKeys(props, userName);
    if (currentKeyId === accessKeyId && remainingKeys.length === 0) {
      await deleteParameter(props, passwordParam);
      await deleteParameter(props, usernameParam);
    } else {
      logger.info('ses parameters belong to a newer key, leaving them', {
        environment: props.environment,
        forumId: props.forumId,
        accessKeyId,
      });
    }

    return { PhysicalResourceId: id, NoEcho: true };
  }

  /** Delete one parameter, tolerating one that is already gone. */
  async function deleteParameter(props: SesCredentialsProps, name: string): Promise<void> {
    try {
      await ssm.send(new DeleteParameterCommand({ Name: name }));
    } catch (error) {
      if (isNotFound(error)) {
        return;
      }
      throw credentialError(props, 'DeleteParameter', error);
    }
  }

  /** Build a typed error from an operation name and the AWS error `name` only. */
  function credentialError(
    props: SesCredentialsProps,
    operation: string,
    error: unknown,
  ): SesCredentialError {
    logger.error('ses credential operation failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation,
      errorName: errorName(error),
    });
    return new SesCredentialError({
      forumId: props.forumId,
      operation,
      awsErrorName: errorName(error),
    });
  }
}

/** Build the real injected dependencies from the Lambda environment. */
function buildDeps(): SesCredentialsDeps {
  const redactor = new Redactor();
  const logger = createLogger({
    sink: {
      write: (line) => {
        process.stdout.write(`${line}\n`);
      },
    },
    redactor,
  });
  return {
    iam: new IAMClient({}),
    ssm: new SSMClient({}),
    region: process.env.AWS_REGION ?? '',
    now: () => new Date(),
    logger,
    redactor,
  };
}

/** Lambda `onEvent` entry point for the CDK Provider framework. */
export async function onEvent(event: SesCredentialsEvent): Promise<SesCredentialsResponse> {
  return createSesSmtpCredentialsHandler(buildDeps())(event);
}
