/**
 * Typed errors for the Community Hub platform.
 *
 * Every error carries structured context and a stable `name` so entry points
 * can map errors to messages and exit codes. Error messages contain only
 * identifiers (references, forum ids, hostnames, operation names, HTTP status
 * codes). They never contain resolved secret values. The single exception is
 * `ForumApiError.apiMessage`, which is a forum admin API response message
 * truncated to 500 characters; request and response bodies are never otherwise
 * surfaced.
 */

/** Maximum length, in characters, of a forum API message carried on an error. */
export const MAX_API_MESSAGE_LENGTH = 500;

/**
 * Base class for all platform errors. Sets `name` to the concrete class name
 * and restores the prototype chain so `instanceof` works after transpilation.
 */
export abstract class PlatformError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Why a Secret_Reference could not be resolved from the Secret_Store. */
export type SecretResolutionReason = 'not_found' | 'access_denied' | 'empty' | 'unknown';

/**
 * A Secret_Reference could not be resolved from the Secret_Store. Names the
 * reference (`store:id`) and the reason, never the attempted value.
 */
export class SecretResolutionError extends PlatformError {
  readonly reference: string;
  readonly reason: SecretResolutionReason;

  constructor(input: { reference: string; reason: SecretResolutionReason }) {
    super(`cannot resolve secret ${input.reference} (${input.reason})`);
    this.reference = input.reference;
    this.reason = input.reason;
  }
}

/**
 * A forum admin REST API returned a non-success response. Carries the request
 * method and path, the HTTP status, the number of attempts made, and the API
 * message from the response body truncated to {@link MAX_API_MESSAGE_LENGTH}
 * characters. No other part of the request or response body is retained.
 */
export class ForumApiError extends PlatformError {
  readonly forumId: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly apiMessage: string;
  readonly attempts: number;

  constructor(input: {
    forumId: string;
    method: string;
    path: string;
    status: number;
    apiMessage: string;
    attempts: number;
  }) {
    const apiMessage = input.apiMessage.slice(0, MAX_API_MESSAGE_LENGTH);
    super(
      `forum ${input.forumId} API ${input.method} ${input.path} failed with status ${input.status} after ${input.attempts} attempt(s): ${apiMessage}`,
    );
    this.forumId = input.forumId;
    this.method = input.method;
    this.path = input.path;
    this.status = input.status;
    this.apiMessage = apiMessage;
    this.attempts = input.attempts;
  }
}

/**
 * A Forum_Instance could not be reached over HTTPS. Names the forum, the URL
 * attempted, and the underlying cause code (for example `ENOTFOUND`,
 * `ETIMEDOUT`, or a `CERT_*` TLS code).
 */
export class ForumUnreachableError extends PlatformError {
  readonly forumId: string;
  readonly url: string;
  readonly cause: string;

  constructor(input: { forumId: string; url: string; cause: string }) {
    super(`forum ${input.forumId} is unreachable at ${input.url} (${input.cause})`);
    this.forumId = input.forumId;
    this.url = input.url;
    this.cause = input.cause;
  }
}

/**
 * A Forum_Engine identifier has no Engine_Adapter in the Engine_Registry.
 * Names the unknown engine id and the known ids.
 */
export class UnknownEngineError extends PlatformError {
  readonly engineId: string;
  readonly known: readonly string[];

  constructor(input: { engineId: string; known: readonly string[] }) {
    super(`unknown engine '${input.engineId}' (known: ${input.known.join(', ')})`);
    this.engineId = input.engineId;
    this.known = input.known;
  }
}

/**
 * A `--forum` identifier does not match any Forum_Instance in the model. Names
 * the unknown forum id and the known ids.
 */
export class UnknownForumError extends PlatformError {
  readonly forumId: string;
  readonly known: readonly string[];

  constructor(input: { forumId: string; known: readonly string[] }) {
    super(`unknown forum '${input.forumId}' (known: ${input.known.join(', ')})`);
    this.forumId = input.forumId;
    this.known = input.known;
  }
}

/**
 * An AWS SES credential operation failed in a Lambda handler. Names the forum,
 * the operation (for example `CreateAccessKey`) and the AWS error `name` only.
 * The access key, SMTP password and SDK message body are never retained.
 */
export class SesCredentialError extends PlatformError {
  readonly forumId: string;
  readonly operation: string;
  readonly awsErrorName: string;

  constructor(input: { forumId: string; operation: string; awsErrorName: string }) {
    super(
      `SES credential operation ${input.operation} for forum ${input.forumId} failed (${input.awsErrorName})`,
    );
    this.forumId = input.forumId;
    this.operation = input.operation;
    this.awsErrorName = input.awsErrorName;
  }
}

/**
 * The public Route 53 hosted zone found for the root domain has an ID other
 * than the declared Hosted_Zone_ID. Reports the declared id, the looked-up id
 * and the root domain so synthesis can stop before any record is created.
 */
export class HostedZoneMismatchError extends PlatformError {
  readonly declaredId: string;
  readonly lookedUpId: string;
  readonly rootDomain: string;

  constructor(input: { declaredId: string; lookedUpId: string; rootDomain: string }) {
    super(
      `hosted zone ${input.declaredId} is not the public hosted zone for ${input.rootDomain} (found ${input.lookedUpId})`,
    );
    this.declaredId = input.declaredId;
    this.lookedUpId = input.lookedUpId;
    this.rootDomain = input.rootDomain;
  }
}
