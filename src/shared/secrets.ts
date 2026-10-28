/**
 * Runtime resolution of Secret_References to their values.
 *
 * A {@link SecretResolver} turns a {@link SecretReference} (a location in a
 * Secret_Store, carried through metadata) into the secret value it points at.
 * Values are read lazily, at the edge of the Seeder, and never flow back into
 * the {@link import('../metadata/schema.js').ValidatedModel}, templates, logs or
 * CLI output.
 *
 * The AWS SDK v3 clients are injected so tests fake them; this module never
 * constructs a client. Every resolved value is registered with the injected
 * {@link Redactor} before it is returned, so any later accidental logging of
 * the value is redacted. Resolution failures surface as
 * {@link SecretResolutionError}, which names the reference and a coarse reason
 * but never the attempted value.
 */

import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { type SecretReference, formatSecretReference } from '../metadata/secret-ref.js';
import { SecretResolutionError, type SecretResolutionReason } from './errors.js';
import { type Redactor } from './logger.js';

/**
 * Resolves a {@link SecretReference} to its secret value. The returned promise
 * rejects with a {@link SecretResolutionError} when the reference cannot be
 * resolved.
 */
export type SecretResolver = (ref: SecretReference) => Promise<string>;

/** The subset of {@link SSMClient} the resolver depends on. */
type SsmClient = Pick<SSMClient, 'send'>;

/** The subset of {@link SecretsManagerClient} the resolver depends on. */
type SecretsManagerClientLike = Pick<SecretsManagerClient, 'send'>;

/** Injected dependencies for {@link createAwsSecretResolver}. */
export interface AwsSecretResolverDeps {
  /** SSM client used for `ssm:` references. */
  readonly ssm: SsmClient;
  /** Secrets Manager client used for `secretsmanager:` references. */
  readonly secretsManager: SecretsManagerClientLike;
  /** Resolved values are registered here before they are returned. */
  readonly redactor: Redactor;
}

/** AWS error `name`s that mean the secret does not exist. */
const NOT_FOUND_ERROR_NAMES = new Set(['ParameterNotFound', 'ResourceNotFoundException']);

/** AWS error `name`s that mean the caller is not allowed to read the secret. */
const ACCESS_DENIED_ERROR_NAMES = new Set(['AccessDeniedException']);

/**
 * Create a {@link SecretResolver} backed by AWS SSM Parameter Store and Secrets
 * Manager.
 *
 * An `ssm:` reference is read with `GetParameter` and `WithDecryption: true`; a
 * `secretsmanager:` reference is read with `GetSecretValue` and requires a
 * `SecretString` (binary secrets are treated as empty). Each reference is
 * resolved at most once per resolver instance: results are cached by
 * `store:id`, and an in-flight resolution is shared so concurrent callers do
 * not issue duplicate reads. Every resolved value is registered with the
 * injected {@link Redactor} before it is returned.
 *
 * All failures map to {@link SecretResolutionError} with the reference name and
 * a coarse reason (`not_found`, `access_denied`, `empty` or `unknown`); the
 * attempted value is never placed on the error.
 *
 * @param deps - Injected SDK clients and the redactor.
 * @returns A resolver function keyed to a single run's cache.
 */
export function createAwsSecretResolver(deps: AwsSecretResolverDeps): SecretResolver {
  const { ssm, secretsManager, redactor } = deps;
  const cache = new Map<string, Promise<string>>();

  const resolveOnce = async (ref: SecretReference): Promise<string> => {
    const reference = formatSecretReference(ref);
    let value: string | undefined;
    try {
      value =
        ref.store === 'ssm'
          ? await readSsm(ssm, ref.id)
          : await readSecretsManager(secretsManager, ref.id);
    } catch (error) {
      throw new SecretResolutionError({ reference, reason: classifyError(error) });
    }
    if (value === undefined || value.length === 0) {
      throw new SecretResolutionError({ reference, reason: 'empty' });
    }
    // Register before returning so the value is redacted everywhere from now on.
    redactor.register(value);
    return value;
  };

  return (ref: SecretReference): Promise<string> => {
    const key = formatSecretReference(ref);
    const existing = cache.get(key);
    if (existing !== undefined) {
      return existing;
    }
    // Cache the in-flight promise so concurrent callers share one read. A
    // rejected resolution is evicted so a later call can retry.
    const pending = resolveOnce(ref).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, pending);
    return pending;
  };
}

/** Read and decrypt an SSM parameter value. */
async function readSsm(client: SsmClient, name: string): Promise<string | undefined> {
  const output = await client.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return output.Parameter?.Value;
}

/** Read a Secrets Manager secret's `SecretString`. */
async function readSecretsManager(
  client: SecretsManagerClientLike,
  secretId: string,
): Promise<string | undefined> {
  const output = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  return output.SecretString;
}

/** Map an AWS SDK error to a {@link SecretResolutionReason}. */
function classifyError(error: unknown): SecretResolutionReason {
  const name = awsErrorName(error);
  if (name !== undefined && NOT_FOUND_ERROR_NAMES.has(name)) {
    return 'not_found';
  }
  if (name !== undefined && ACCESS_DENIED_ERROR_NAMES.has(name)) {
    return 'access_denied';
  }
  return 'unknown';
}

/** Extract the AWS SDK error `name` without echoing any message body. */
function awsErrorName(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'name' in error) {
    const { name } = error;
    if (typeof name === 'string') {
      return name;
    }
  }
  return undefined;
}
