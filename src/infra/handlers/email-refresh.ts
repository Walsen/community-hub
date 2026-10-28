/**
 * Email-refresh custom-resource handler.
 *
 * This backs the per-forum `Forum-<forumId>/EmailRefresh` custom resource. Its
 * one job is to react to a SES SMTP credential change (rotation or rollback) by
 * telling the forum's already-running Lightsail instance to pull the new
 * credentials from SSM and reload its email configuration, so a rotation does
 * not interrupt outbound mail. The `AccessKeyId` the resource is created with
 * changes whenever the credentials handler issues a new key, which is what
 * drives the Update that triggers a refresh.
 *
 * It is wired into the CDK Provider framework, so it is split into two phases:
 *
 * - {@link createEmailRefreshOnEvent} (`onEvent`): Create reports status
 *   `initial` (the install script already configured email from the current
 *   parameters) and Delete is a no-op. Update performs the design's
 *   "restore-if-needed" step (re-putting both `ses-smtp-*` parameters from the
 *   labelled password version when the stored username no longer matches the
 *   target key, which covers rollback), waits for IAM key propagation via the
 *   injected `sleep`, checks the forum's managed node is online, and if so
 *   issues an `AWS-RunShellScript` command running `refresh-email.sh`, recording
 *   the command id under `Data` for the completion phase to poll.
 * - {@link createEmailRefreshIsComplete} (`isComplete`): when no command was
 *   sent (status `initial` or `node-offline`) it reports complete immediately;
 *   otherwise it polls `GetCommandInvocation` and maps the SSM command status to
 *   `applied` (Success) or `failed` (Failed/Cancelled/TimedOut), staying
 *   incomplete while the command is still pending.
 *
 * The resource must NEVER fail the deploy because of the instance: an offline
 * node, a failed command, or an SDK error all resolve, surfacing the outcome
 * through `Data.RefreshStatus` (a stack output) rather than throwing in a way
 * that would roll back the stack. A `failed` status means the operator runs the
 * manual refresh documented in the README. No secret value is ever handled
 * here, and every error is logged with its operation name and AWS error code
 * only, never a response body.
 *
 * The clock, sleep, logger, redactor and SSM client are injected so the handler
 * is unit-testable with fakes and never touches a real timer; the thin Lambda
 * entry points at the bottom build the real dependencies.
 */

import {
  DescribeActivationsCommand,
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SendCommandCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { stripServiceToken } from './resource-properties.js';

import { Redactor, createLogger, type Logger } from '../../shared/logger.js';
import { names } from '../naming.js';

/** SSM Run Command document used to run the refresh script on the node. */
const RUN_SHELL_SCRIPT_DOCUMENT = 'AWS-RunShellScript';
/** Absolute path of the refresh script dropped on the instance by the install script. */
const REFRESH_SCRIPT_PATH = '/opt/community-hub/bin/refresh-email.sh';
/** Run Command execution timeout, in seconds. Matches the provider total timeout budget. */
const COMMAND_TIMEOUT_SECONDS = 1500;
/** Delay, in milliseconds, allowing a freshly created IAM access key to propagate. */
const KEY_PROPAGATION_DELAY_MS = 10_000;
/** SSM `PingStatus` value meaning the managed node is reachable. */
const PING_STATUS_ONLINE = 'Online';
/** Key under custom-resource `Data` carrying the refresh outcome. */
const DATA_REFRESH_STATUS = 'RefreshStatus';
/** Key under custom-resource `Data` carrying the issued Run Command id. */
const DATA_COMMAND_ID = 'CommandId';

/**
 * Outcome of a refresh, surfaced through `Data.RefreshStatus`:
 * - `initial`: first deploy; the install script configured email, nothing to do.
 * - `applied`: the refresh command ran on the node and succeeded.
 * - `node-offline`: the node was not registered or not online; refresh skipped.
 * - `failed`: the refresh command ran but did not succeed.
 */
export type RefreshStatus = 'initial' | 'applied' | 'node-offline' | 'failed';

/**
 * The subset of the CloudFormation custom-resource event the handler depends
 * on. The provider framework passes a richer object; only these fields are
 * read, and `ResourceProperties` is validated defensively before use.
 */
export interface EmailRefreshEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties?: unknown;
  readonly Data?: unknown;
}

/** Response returned from the `onEvent` phase. */
export interface OnEventResponse {
  readonly PhysicalResourceId: string;
  readonly Data?: Readonly<Record<string, string>>;
}

/** Response returned from the `isComplete` phase. */
export interface IsCompleteResponse {
  readonly IsComplete: boolean;
  readonly Data?: Readonly<Record<string, string>>;
}

/**
 * Resource properties the custom resource is created with. These are plain,
 * non-secret identifiers. `accessKeyId` is the SES access key id the forum's
 * credentials should currently resolve to; it changes on each rotation, which
 * is what drives the Update that triggers a refresh.
 */
const propsSchema = z
  .object({
    environment: z.string().min(1),
    forumId: z.string().min(1),
    accessKeyId: z.string().min(1),
  })
  .strict();

/** Validated resource properties. */
export type EmailRefreshProps = z.infer<typeof propsSchema>;

/** Injected dependencies shared by both refresh phases. */
export interface EmailRefreshDeps {
  /** SSM client used for the restore, node lookup and Run Command calls. */
  readonly ssm: Pick<SSMClient, 'send'>;
  /** Injected sleep so IAM key-propagation waits never use a real timer in tests. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Clock, injected so behaviour is deterministic in tests. */
  readonly now: () => Date;
  /** Structured logger. No secret value is ever passed to it. */
  readonly logger: Logger;
  /** Redactor backing the logger; no secrets are registered by this handler. */
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

/**
 * Validate and narrow the event's `ResourceProperties`, returning `undefined`
 * when they are missing or malformed. A misconfigured resource must not fail
 * the deploy, so the caller treats `undefined` as a non-fatal outcome rather
 * than throwing.
 */
function parseProps(raw: unknown): EmailRefreshProps | undefined {
  const result = propsSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/** Deterministic physical resource id for a forum's email-refresh resource. */
function physicalId(props: EmailRefreshProps): string {
  return `${props.environment}-${props.forumId}-email-refresh`;
}

/** Build the `Data` bag for a status with no outstanding command. */
function statusData(status: RefreshStatus): Readonly<Record<string, string>> {
  return { [DATA_REFRESH_STATUS]: status };
}

/**
 * Restore the two `ses-smtp-*` parameters to the target access key when the
 * stored username no longer matches it. This covers rollback, where
 * CloudFormation updates this resource back to the previous key id before the
 * newer credentials are deleted: the labelled password version lets the old
 * password be re-put so the node can fetch a consistent username/password pair.
 *
 * Best-effort and non-fatal: any SDK failure is logged with its operation name
 * and error code and swallowed, because the refresh must never fail the deploy.
 */
async function restoreIfNeeded(deps: EmailRefreshDeps, props: EmailRefreshProps): Promise<void> {
  const { ssm, logger } = deps;
  const usernameParam = names.sesParameter(props.environment, props.forumId, 'username');
  const passwordParam = names.sesParameter(props.environment, props.forumId, 'password');

  try {
    const current = await ssm.send(new GetParameterCommand({ Name: usernameParam }));
    const storedUsername = current.Parameter?.Value;
    if (storedUsername === props.accessKeyId) {
      return;
    }

    // The stored username points at a different key; re-put both parameters from
    // the password version labelled with the target access key id.
    const labelled = await ssm.send(
      new GetParameterCommand({
        Name: `${passwordParam}:${props.accessKeyId}`,
        WithDecryption: true,
      }),
    );
    const password = labelled.Parameter?.Value;
    if (password === undefined || password.length === 0) {
      logger.error('labelled password version missing during restore', {
        environment: props.environment,
        forumId: props.forumId,
        operation: 'GetParameter',
      });
      return;
    }
    // The password is a secret; register it before any further log call.
    deps.redactor.register(password);

    await ssm.send(
      new PutParameterCommand({
        Name: passwordParam,
        Type: 'SecureString',
        Overwrite: true,
        Value: password,
      }),
    );
    await ssm.send(
      new PutParameterCommand({
        Name: usernameParam,
        Type: 'String',
        Overwrite: true,
        Value: props.accessKeyId,
      }),
    );
    logger.info('restored ses-smtp parameters to target key', {
      environment: props.environment,
      forumId: props.forumId,
    });
  } catch (error) {
    logger.error('restoring ses-smtp parameters failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation: 'RestoreSesParameters',
      errorName: errorName(error),
    });
  }
}

/**
 * Resolve the forum's online managed-node instance id, or `undefined` when no
 * node is registered or none is online. Non-fatal: an SDK failure is logged and
 * treated as "no online node" so the refresh degrades to `node-offline` rather
 * than failing the deploy.
 */
async function findOnlineNode(
  deps: EmailRefreshDeps,
  props: EmailRefreshProps,
): Promise<string | undefined> {
  const { ssm, logger } = deps;
  const defaultInstanceName = names.activationName(props.environment, props.forumId);

  try {
    const activationIds: string[] = [];
    let activationToken: string | undefined;
    do {
      const output = await ssm.send(
        new DescribeActivationsCommand({
          Filters: [{ FilterKey: 'DefaultInstanceName', FilterValues: [defaultInstanceName] }],
          ...(activationToken === undefined ? {} : { NextToken: activationToken }),
        }),
      );
      for (const activation of output.ActivationList ?? []) {
        if (typeof activation.ActivationId === 'string' && activation.ActivationId.length > 0) {
          activationIds.push(activation.ActivationId);
        }
      }
      activationToken = output.NextToken;
    } while (activationToken !== undefined && activationToken.length > 0);

    if (activationIds.length === 0) {
      return undefined;
    }

    let infoToken: string | undefined;
    do {
      const output = await ssm.send(
        new DescribeInstanceInformationCommand({
          Filters: [{ Key: 'ActivationIds', Values: activationIds }],
          ...(infoToken === undefined ? {} : { NextToken: infoToken }),
        }),
      );
      for (const info of output.InstanceInformationList ?? []) {
        if (
          info.PingStatus === PING_STATUS_ONLINE &&
          typeof info.InstanceId === 'string' &&
          info.InstanceId.length > 0
        ) {
          return info.InstanceId;
        }
      }
      infoToken = output.NextToken;
    } while (infoToken !== undefined && infoToken.length > 0);

    return undefined;
  } catch (error) {
    logger.error('locating managed node failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation: 'DescribeManagedNode',
      errorName: errorName(error),
    });
    return undefined;
  }
}

/**
 * Create the `onEvent` phase of the email-refresh handler.
 *
 * Create reports `initial` and Delete is a no-op; both are terminal and need no
 * polling. Update restores the parameters if needed, waits for key propagation,
 * finds the forum's online node and, when one is found, issues the refresh
 * command and records its id under `Data` for {@link createEmailRefreshIsComplete}
 * to poll. When no node is online it reports `node-offline`. Nothing here throws
 * in a way that rolls back the stack: malformed properties and SDK failures all
 * resolve with a status.
 *
 * @param deps - Injected SSM client, sleep, clock, logger and redactor.
 * @returns An async `onEvent` function for the CDK Provider framework.
 */
export function createEmailRefreshOnEvent(
  deps: EmailRefreshDeps,
): (event: EmailRefreshEvent) => Promise<OnEventResponse> {
  const { ssm, sleep, logger } = deps;

  return async (event: EmailRefreshEvent): Promise<OnEventResponse> => {
    const props = parseProps(stripServiceToken(event.ResourceProperties));
    if (props === undefined) {
      logger.error('email refresh received malformed resource properties', {
        operation: 'ParseResourceProperties',
      });
      const id =
        typeof event.PhysicalResourceId === 'string' && event.PhysicalResourceId.length > 0
          ? event.PhysicalResourceId
          : 'email-refresh-unknown';
      return { PhysicalResourceId: id, Data: statusData('failed') };
    }

    const id = physicalId(props);
    const requestType = event.RequestType;

    switch (requestType) {
      case 'Create': {
        logger.info('email refresh initial, no action', {
          environment: props.environment,
          forumId: props.forumId,
        });
        return { PhysicalResourceId: id, Data: statusData('initial') };
      }
      case 'Delete': {
        return { PhysicalResourceId: id, Data: statusData('initial') };
      }
      case 'Update': {
        await restoreIfNeeded(deps, props);
        // Allow the (possibly brand-new) IAM access key to propagate before the
        // node tries to send with it. Injected sleep: never a real timer.
        await sleep(KEY_PROPAGATION_DELAY_MS);

        const instanceId = await findOnlineNode(deps, props);
        if (instanceId === undefined) {
          logger.info('no online node, skipping refresh', {
            environment: props.environment,
            forumId: props.forumId,
          });
          return { PhysicalResourceId: id, Data: statusData('node-offline') };
        }

        try {
          const output = await ssm.send(
            new SendCommandCommand({
              DocumentName: RUN_SHELL_SCRIPT_DOCUMENT,
              InstanceIds: [instanceId],
              TimeoutSeconds: COMMAND_TIMEOUT_SECONDS,
              Parameters: { commands: [REFRESH_SCRIPT_PATH] },
            }),
          );
          const commandId = output.Command?.CommandId;
          if (commandId === undefined || commandId.length === 0) {
            logger.error('send command returned no command id', {
              environment: props.environment,
              forumId: props.forumId,
              operation: 'SendCommand',
            });
            return { PhysicalResourceId: id, Data: statusData('failed') };
          }
          logger.info('refresh command dispatched', {
            environment: props.environment,
            forumId: props.forumId,
            instanceId,
            commandId,
          });
          return {
            PhysicalResourceId: id,
            Data: {
              [DATA_REFRESH_STATUS]: 'applied',
              [DATA_COMMAND_ID]: commandId,
              InstanceId: instanceId,
            },
          };
        } catch (error) {
          logger.error('dispatching refresh command failed', {
            environment: props.environment,
            forumId: props.forumId,
            operation: 'SendCommand',
            errorName: errorName(error),
          });
          return { PhysicalResourceId: id, Data: statusData('failed') };
        }
      }
      default: {
        const exhaustive: never = requestType;
        logger.error('email refresh received unknown request type', {
          environment: props.environment,
          forumId: props.forumId,
          requestType: String(exhaustive),
        });
        return { PhysicalResourceId: id, Data: statusData('failed') };
      }
    }
  };
}

/** SSM Run Command invocation statuses that are terminal and successful. */
const COMMAND_SUCCESS = 'Success';
/** SSM Run Command invocation statuses that are terminal and unsuccessful. */
const COMMAND_TERMINAL_FAILURE: ReadonlySet<string> = new Set(['Cancelled', 'TimedOut', 'Failed']);

/**
 * Read the command id the `onEvent` phase recorded under `Data`. The provider
 * framework merges `onEvent`'s `Data` into the `isComplete` event; a missing id
 * means no command was sent (status `initial` or `node-offline`), so there is
 * nothing to poll.
 */
function readCommandId(event: EmailRefreshEvent): string | undefined {
  const data = event.Data;
  if (data !== null && typeof data === 'object' && DATA_COMMAND_ID in data) {
    const value = (data as Record<string, unknown>)[DATA_COMMAND_ID];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** Read the instance id the `onEvent` phase recorded under `Data`, if any. */
function readInstanceId(event: EmailRefreshEvent): string | undefined {
  const data = event.Data;
  if (data !== null && typeof data === 'object' && 'InstanceId' in data) {
    const value = (data as Record<string, unknown>).InstanceId;
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Create the `isComplete` phase of the email-refresh handler.
 *
 * When `onEvent` sent a refresh command (a command id is present under `Data`)
 * this polls `GetCommandInvocation`: a `Success` status completes with
 * `applied`, a `Cancelled`/`TimedOut`/`Failed` status completes with `failed`,
 * and any still-pending status reports `IsComplete: false`. When no command was
 * sent (Create/Delete, or an Update that found no online node or already failed)
 * the recorded status is terminal, so it reports complete immediately. A failed
 * command never fails the deploy; the outcome is surfaced through `Data` only.
 *
 * @param deps - Injected SSM client, sleep, clock, logger and redactor.
 * @returns An async `isComplete` function for the CDK Provider framework.
 */
export function createEmailRefreshIsComplete(
  deps: EmailRefreshDeps,
): (event: EmailRefreshEvent) => Promise<IsCompleteResponse> {
  const { ssm, logger } = deps;

  return async (event: EmailRefreshEvent): Promise<IsCompleteResponse> => {
    const props = parseProps(stripServiceToken(event.ResourceProperties));

    const commandId = readCommandId(event);
    if (commandId === undefined) {
      // No command was dispatched; the status recorded by onEvent is terminal.
      return { IsComplete: true };
    }

    const instanceId = readInstanceId(event);
    if (instanceId === undefined) {
      logger.error('command id present without instance id, treating as failed', {
        ...(props === undefined ? {} : { environment: props.environment, forumId: props.forumId }),
        operation: 'GetCommandInvocation',
      });
      return { IsComplete: true, Data: statusData('failed') };
    }

    try {
      const output = await ssm.send(
        new GetCommandInvocationCommand({ CommandId: commandId, InstanceId: instanceId }),
      );
      const status = output.Status;
      if (status === COMMAND_SUCCESS) {
        logger.info('refresh command succeeded', {
          ...(props === undefined
            ? {}
            : { environment: props.environment, forumId: props.forumId }),
          commandId,
        });
        return { IsComplete: true, Data: statusData('applied') };
      }
      if (typeof status === 'string' && COMMAND_TERMINAL_FAILURE.has(status)) {
        logger.error('refresh command did not succeed', {
          ...(props === undefined
            ? {}
            : { environment: props.environment, forumId: props.forumId }),
          commandId,
          commandStatus: status,
        });
        return { IsComplete: true, Data: statusData('failed') };
      }
      // Pending, InProgress, Delayed or an unknown non-terminal status: keep polling.
      return { IsComplete: false };
    } catch (error) {
      // Polling itself failed; do not wedge or roll back the deploy.
      logger.error('polling refresh command failed', {
        ...(props === undefined ? {} : { environment: props.environment, forumId: props.forumId }),
        operation: 'GetCommandInvocation',
        errorName: errorName(error),
      });
      return { IsComplete: true, Data: statusData('failed') };
    }
  };
}

/** Build the real injected dependencies from the Lambda environment. */
function buildDeps(): EmailRefreshDeps {
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
    ssm: new SSMClient({}),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    now: () => new Date(),
    logger,
    redactor,
  };
}

/** Lambda `onEvent` entry point for the CDK Provider framework. */
export async function onEvent(event: EmailRefreshEvent): Promise<OnEventResponse> {
  return createEmailRefreshOnEvent(buildDeps())(event);
}

/** Lambda `isComplete` entry point for the CDK Provider framework. */
export async function isComplete(event: EmailRefreshEvent): Promise<IsCompleteResponse> {
  return createEmailRefreshIsComplete(buildDeps())(event);
}
