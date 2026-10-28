/**
 * Forum lifecycle custom-resource handler.
 *
 * This backs the `Forum-<forumId>/Lifecycle` custom resource, which depends on
 * the forum's Lightsail instance so CloudFormation runs it before the instance
 * is deleted, both on `cdk destroy` and when a single forum is removed from the
 * metadata. Its one job is to take a final *manual* Lightsail snapshot before
 * the instance disappears, because automatic snapshots are deleted together
 * with the instance while manual snapshots survive the stack delete.
 *
 * It is wired into the CDK Provider framework, so it is split into two phases:
 *
 * - {@link createForumLifecycleOnEvent} (`onEvent`): for Create and Update it is
 *   a no-op that only echoes the physical resource id; for Delete it issues
 *   `CreateInstanceSnapshot` and records the chosen snapshot name in the
 *   response `Data` so the completion phase knows what to poll.
 * - {@link createForumLifecycleIsComplete} (`isComplete`): for Create and Update
 *   it reports complete immediately; for Delete it polls `GetInstanceSnapshot`
 *   until the snapshot is `available`, then deregisters the forum's SSM hybrid
 *   managed node(s) and deletes their activations.
 *
 * A destroy must never be wedged by an already-deleted instance: if the source
 * instance (or the snapshot) no longer exists, the handler logs and reports the
 * delete complete rather than failing the stack delete. No secret value is ever
 * handled here, and every error is logged with its operation name and error
 * code only, never a response body.
 *
 * The clock, logger, redactor and both SDK clients are injected so the handler
 * is unit-testable with fakes; the thin Lambda entry points at the bottom build
 * the real dependencies.
 */

import {
  CreateInstanceSnapshotCommand,
  GetInstanceSnapshotCommand,
  LightsailClient,
} from '@aws-sdk/client-lightsail';
import {
  DeleteActivationCommand,
  DeregisterManagedInstanceCommand,
  DescribeActivationsCommand,
  DescribeInstanceInformationCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import { z } from 'zod';

import { stripServiceToken } from './resource-properties.js';

import { PlatformError } from '../../shared/errors.js';
import { Redactor, createLogger, type Logger } from '../../shared/logger.js';
import { names } from '../naming.js';

/** Tag key marking the Environment a resource belongs to. */
const TAG_ENVIRONMENT = 'community-hub:environment';
/** Tag key marking the forum a resource belongs to. */
const TAG_FORUM = 'community-hub:forum';
/** Lightsail snapshot state meaning the snapshot has finished and is retained. */
const SNAPSHOT_STATE_AVAILABLE = 'available';
/** Lightsail snapshot state meaning the snapshot failed to complete. */
const SNAPSHOT_STATE_ERROR = 'error';
/** Key under custom-resource `Data` carrying the final snapshot name. */
const DATA_SNAPSHOT_NAME = 'SnapshotName';

/**
 * AWS SDK error `name` values meaning the referenced resource is already gone.
 * A Delete that hits one of these is treated as complete so an already-deleted
 * instance can never block a stack destroy.
 */
const NOT_FOUND_ERROR_NAMES: ReadonlySet<string> = new Set([
  'NotFoundException',
  'DoesNotExist',
  'ResourceNotFoundException',
]);

/**
 * The subset of the CloudFormation custom-resource event the handler depends
 * on. The provider framework passes a richer object; only these fields are
 * read, and `ResourceProperties` is validated defensively before use.
 */
export interface LifecycleEvent {
  readonly RequestType: 'Create' | 'Update' | 'Delete';
  readonly PhysicalResourceId?: string;
  readonly ResourceProperties?: unknown;
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
 * non-secret identifiers used to derive deterministic names.
 */
const propsSchema = z
  .object({
    environment: z.string().min(1),
    forumId: z.string().min(1),
    instanceName: z.string().min(1),
  })
  .strict();

/** Validated resource properties. */
export type LifecycleProps = z.infer<typeof propsSchema>;

/** Injected dependencies shared by both lifecycle phases. */
export interface LifecycleDeps {
  /** Lightsail client used to create and poll the final snapshot. */
  readonly lightsail: Pick<LightsailClient, 'send'>;
  /** SSM client used to deregister the managed node and delete its activations. */
  readonly ssm: Pick<SSMClient, 'send'>;
  /** Clock, injected so snapshot naming is deterministic in tests. */
  readonly now: () => Date;
  /** Structured logger. No secret value is ever passed to it. */
  readonly logger: Logger;
  /** Redactor backing the logger; no secrets are registered by this handler. */
  readonly redactor: Redactor;
}

/** A lifecycle operation failed. Carries the operation name and AWS error code only. */
export class ForumLifecycleError extends PlatformError {
  readonly forumId: string;
  readonly operation: string;
  readonly awsErrorName: string;

  constructor(input: { forumId: string; operation: string; awsErrorName: string }) {
    super(
      `forum lifecycle operation ${input.operation} for forum ${input.forumId} failed (${input.awsErrorName})`,
    );
    this.forumId = input.forumId;
    this.operation = input.operation;
    this.awsErrorName = input.awsErrorName;
  }
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

/** True when an error indicates the referenced resource no longer exists. */
function isNotFound(error: unknown): boolean {
  return NOT_FOUND_ERROR_NAMES.has(errorName(error));
}

/**
 * Validate and narrow the event's `ResourceProperties`.
 *
 * @throws ForumLifecycleError when the properties are missing or malformed, so
 *   a misconfigured resource surfaces a typed error rather than an unchecked
 *   property access.
 */
function parseProps(raw: unknown): LifecycleProps {
  const result = propsSchema.safeParse(raw);
  if (!result.success) {
    throw new ForumLifecycleError({
      forumId: 'unknown',
      operation: 'ParseResourceProperties',
      awsErrorName: 'InvalidResourceProperties',
    });
  }
  return result.data;
}

/** Deterministic physical resource id for a forum's lifecycle resource. */
function physicalId(props: LifecycleProps): string {
  return `${props.environment}-${props.forumId}-lifecycle`;
}

/** Format the current time as a compact UTC `yyyymmddHHMMss` stamp for a snapshot name. */
function snapshotStamp(now: Date): string {
  const iso = now.toISOString(); // e.g. 2024-01-02T03:04:05.678Z
  return iso.slice(0, 19).replace(/[-:T]/g, '');
}

/**
 * Create the `onEvent` phase of the lifecycle handler.
 *
 * Create and Update return the physical id with nothing else to do. Delete
 * issues `CreateInstanceSnapshot` with the deterministic final snapshot name
 * and returns that name under `Data` so {@link createForumLifecycleIsComplete}
 * can poll it. If the instance is already gone, the snapshot step is skipped
 * and the delete proceeds to completion.
 *
 * @param deps - Injected SDK clients, clock, logger and redactor.
 * @returns An async `onEvent` function for the CDK Provider framework.
 */
export function createForumLifecycleOnEvent(
  deps: LifecycleDeps,
): (event: LifecycleEvent) => Promise<OnEventResponse> {
  const { lightsail, now, logger } = deps;

  return async (event: LifecycleEvent): Promise<OnEventResponse> => {
    const props = parseProps(stripServiceToken(event.ResourceProperties));
    const id = physicalId(props);
    const requestType = event.RequestType;

    switch (requestType) {
      case 'Create':
      case 'Update': {
        logger.info('lifecycle no-op', {
          environment: props.environment,
          forumId: props.forumId,
          requestType,
        });
        return { PhysicalResourceId: id };
      }
      case 'Delete': {
        const snapshotName = names.finalSnapshot(
          props.environment,
          props.forumId,
          snapshotStamp(now()),
        );
        try {
          await lightsail.send(
            new CreateInstanceSnapshotCommand({
              instanceName: props.instanceName,
              instanceSnapshotName: snapshotName,
              tags: [
                { key: TAG_ENVIRONMENT, value: props.environment },
                { key: TAG_FORUM, value: props.forumId },
              ],
            }),
          );
          logger.info('final snapshot requested', {
            environment: props.environment,
            forumId: props.forumId,
            snapshotName,
          });
          return { PhysicalResourceId: id, Data: { [DATA_SNAPSHOT_NAME]: snapshotName } };
        } catch (error) {
          if (isNotFound(error)) {
            // The instance is already gone; nothing to snapshot. Reporting no
            // snapshot name tells isComplete to finish the delete immediately.
            logger.info('instance already gone, skipping final snapshot', {
              environment: props.environment,
              forumId: props.forumId,
              errorName: errorName(error),
            });
            return { PhysicalResourceId: id };
          }
          logger.error('final snapshot request failed', {
            environment: props.environment,
            forumId: props.forumId,
            operation: 'CreateInstanceSnapshot',
            errorName: errorName(error),
          });
          throw new ForumLifecycleError({
            forumId: props.forumId,
            operation: 'CreateInstanceSnapshot',
            awsErrorName: errorName(error),
          });
        }
      }
      default: {
        const exhaustive: never = requestType;
        throw new ForumLifecycleError({
          forumId: props.forumId,
          operation: 'OnEvent',
          awsErrorName: `UnknownRequestType:${String(exhaustive)}`,
        });
      }
    }
  };
}

/**
 * Create the `isComplete` phase of the lifecycle handler.
 *
 * Create and Update are always complete. Delete is complete when there is no
 * pending snapshot to wait for; otherwise it polls `GetInstanceSnapshot` and
 * reports `IsComplete: false` while the snapshot is still `pending`. Once the
 * snapshot is `available` (or the snapshot has itself gone missing), it
 * deregisters the forum's SSM hybrid managed node(s) and deletes their
 * activations, then reports complete.
 *
 * @param deps - Injected SDK clients, clock, logger and redactor.
 * @returns An async `isComplete` function for the CDK Provider framework.
 */
export function createForumLifecycleIsComplete(
  deps: LifecycleDeps,
): (event: LifecycleEvent) => Promise<IsCompleteResponse> {
  const { lightsail, ssm, logger } = deps;

  return async (event: LifecycleEvent): Promise<IsCompleteResponse> => {
    const props = parseProps(stripServiceToken(event.ResourceProperties));
    const requestType = event.RequestType;

    switch (requestType) {
      case 'Create':
      case 'Update': {
        return { IsComplete: true };
      }
      case 'Delete': {
        const snapshotName = readSnapshotName(event.ResourceProperties, event);
        if (snapshotName !== undefined) {
          const ready = await isSnapshotReady(lightsail, logger, props, snapshotName);
          if (!ready) {
            return { IsComplete: false };
          }
        }
        await cleanUpManagedNode(ssm, logger, props);
        return { IsComplete: true };
      }
      default: {
        const exhaustive: never = requestType;
        throw new ForumLifecycleError({
          forumId: props.forumId,
          operation: 'IsComplete',
          awsErrorName: `UnknownRequestType:${String(exhaustive)}`,
        });
      }
    }
  };
}

/**
 * Read the snapshot name the `onEvent` phase recorded under `Data`. The provider
 * framework merges `onEvent`'s `Data` into the `isComplete` event; a missing
 * name means there is no snapshot to wait for (the instance was already gone).
 */
function readSnapshotName(raw: unknown, event: LifecycleEvent): string | undefined {
  const fromData = extractSnapshotNameFromData(event);
  if (fromData !== undefined) {
    return fromData;
  }
  // Fall back to the properties bag in case the framework surfaced Data there.
  return extractSnapshotNameFromData({ ResourceProperties: raw } as LifecycleEvent);
}

/** Pull the recorded snapshot name out of an event's `Data` field, if present. */
function extractSnapshotNameFromData(event: LifecycleEvent): string | undefined {
  const container = event as { readonly Data?: unknown };
  const data = container.Data;
  if (data !== null && typeof data === 'object' && DATA_SNAPSHOT_NAME in data) {
    const value = (data as Record<string, unknown>)[DATA_SNAPSHOT_NAME];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/**
 * Poll a single `GetInstanceSnapshot` call. Returns true when the snapshot is
 * `available` or has gone missing (nothing left to wait for), false while it is
 * still `pending`. Throws on an `error` state or an unexpected SDK failure.
 */
async function isSnapshotReady(
  lightsail: Pick<LightsailClient, 'send'>,
  logger: Logger,
  props: LifecycleProps,
  snapshotName: string,
): Promise<boolean> {
  try {
    const output = await lightsail.send(
      new GetInstanceSnapshotCommand({ instanceSnapshotName: snapshotName }),
    );
    const state = output.instanceSnapshot?.state;
    if (state === SNAPSHOT_STATE_AVAILABLE) {
      logger.info('final snapshot available', {
        environment: props.environment,
        forumId: props.forumId,
        snapshotName,
      });
      return true;
    }
    if (state === SNAPSHOT_STATE_ERROR) {
      logger.error('final snapshot entered error state', {
        environment: props.environment,
        forumId: props.forumId,
        snapshotName,
      });
      throw new ForumLifecycleError({
        forumId: props.forumId,
        operation: 'GetInstanceSnapshot',
        awsErrorName: 'SnapshotError',
      });
    }
    return false;
  } catch (error) {
    if (error instanceof ForumLifecycleError) {
      throw error;
    }
    if (isNotFound(error)) {
      // Snapshot source vanished; do not wedge the delete.
      logger.info('final snapshot not found, treating delete as complete', {
        environment: props.environment,
        forumId: props.forumId,
        snapshotName,
        errorName: errorName(error),
      });
      return true;
    }
    logger.error('polling final snapshot failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation: 'GetInstanceSnapshot',
      errorName: errorName(error),
    });
    throw new ForumLifecycleError({
      forumId: props.forumId,
      operation: 'GetInstanceSnapshot',
      awsErrorName: errorName(error),
    });
  }
}

/**
 * Deregister any SSM hybrid managed node registered with this forum's
 * activations and delete those activations. Scoped to the forum's default
 * instance name so one forum never touches another's managed node. Best-effort:
 * a missing activation or node is tolerated so the delete is never blocked.
 */
async function cleanUpManagedNode(
  ssm: Pick<SSMClient, 'send'>,
  logger: Logger,
  props: LifecycleProps,
): Promise<void> {
  const defaultInstanceName = names.activationName(props.environment, props.forumId);

  let activationIds: string[];
  try {
    activationIds = await listActivationIds(ssm, defaultInstanceName);
  } catch (error) {
    logger.error('listing activations failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation: 'DescribeActivations',
      errorName: errorName(error),
    });
    throw new ForumLifecycleError({
      forumId: props.forumId,
      operation: 'DescribeActivations',
      awsErrorName: errorName(error),
    });
  }

  if (activationIds.length === 0) {
    logger.info('no activations to clean up', {
      environment: props.environment,
      forumId: props.forumId,
    });
    return;
  }

  const managedInstanceIds = await listManagedInstanceIds(ssm, logger, props, activationIds);
  for (const instanceId of managedInstanceIds) {
    await deregisterNode(ssm, logger, props, instanceId);
  }
  for (const activationId of activationIds) {
    await deleteActivation(ssm, logger, props, activationId);
  }
}

/** List every activation id scoped to a forum's default instance name, following pagination. */
async function listActivationIds(
  ssm: Pick<SSMClient, 'send'>,
  defaultInstanceName: string,
): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;
  do {
    const output = await ssm.send(
      new DescribeActivationsCommand({
        Filters: [{ FilterKey: 'DefaultInstanceName', FilterValues: [defaultInstanceName] }],
        ...(nextToken === undefined ? {} : { NextToken: nextToken }),
      }),
    );
    for (const activation of output.ActivationList ?? []) {
      if (typeof activation.ActivationId === 'string' && activation.ActivationId.length > 0) {
        ids.push(activation.ActivationId);
      }
    }
    nextToken = output.NextToken;
  } while (nextToken !== undefined && nextToken.length > 0);
  return ids;
}

/** List managed-node instance ids registered against the given activation ids, following pagination. */
async function listManagedInstanceIds(
  ssm: Pick<SSMClient, 'send'>,
  logger: Logger,
  props: LifecycleProps,
  activationIds: string[],
): Promise<string[]> {
  const ids: string[] = [];
  let nextToken: string | undefined;
  try {
    do {
      const output = await ssm.send(
        new DescribeInstanceInformationCommand({
          Filters: [{ Key: 'ActivationIds', Values: activationIds }],
          ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }),
      );
      for (const info of output.InstanceInformationList ?? []) {
        if (typeof info.InstanceId === 'string' && info.InstanceId.length > 0) {
          ids.push(info.InstanceId);
        }
      }
      nextToken = output.NextToken;
    } while (nextToken !== undefined && nextToken.length > 0);
  } catch (error) {
    logger.error('describing managed nodes failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation: 'DescribeInstanceInformation',
      errorName: errorName(error),
    });
    throw new ForumLifecycleError({
      forumId: props.forumId,
      operation: 'DescribeInstanceInformation',
      awsErrorName: errorName(error),
    });
  }
  return ids;
}

/** Deregister one managed node, tolerating one that is already gone. */
async function deregisterNode(
  ssm: Pick<SSMClient, 'send'>,
  logger: Logger,
  props: LifecycleProps,
  instanceId: string,
): Promise<void> {
  try {
    await ssm.send(new DeregisterManagedInstanceCommand({ InstanceId: instanceId }));
    logger.info('deregistered managed node', {
      environment: props.environment,
      forumId: props.forumId,
      instanceId,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    logger.error('deregistering managed node failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation: 'DeregisterManagedInstance',
      errorName: errorName(error),
    });
    throw new ForumLifecycleError({
      forumId: props.forumId,
      operation: 'DeregisterManagedInstance',
      awsErrorName: errorName(error),
    });
  }
}

/** Delete one activation, tolerating one that is already gone. */
async function deleteActivation(
  ssm: Pick<SSMClient, 'send'>,
  logger: Logger,
  props: LifecycleProps,
  activationId: string,
): Promise<void> {
  try {
    await ssm.send(new DeleteActivationCommand({ ActivationId: activationId }));
    logger.info('deleted activation', {
      environment: props.environment,
      forumId: props.forumId,
      activationId,
    });
  } catch (error) {
    if (isNotFound(error)) {
      return;
    }
    logger.error('deleting activation failed', {
      environment: props.environment,
      forumId: props.forumId,
      operation: 'DeleteActivation',
      errorName: errorName(error),
    });
    throw new ForumLifecycleError({
      forumId: props.forumId,
      operation: 'DeleteActivation',
      awsErrorName: errorName(error),
    });
  }
}

/** Build the real injected dependencies from the Lambda environment. */
function buildDeps(): LifecycleDeps {
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
    lightsail: new LightsailClient({}),
    ssm: new SSMClient({}),
    now: () => new Date(),
    logger,
    redactor,
  };
}

/** Lambda `onEvent` entry point for the CDK Provider framework. */
export async function onEvent(event: LifecycleEvent): Promise<OnEventResponse> {
  return createForumLifecycleOnEvent(buildDeps())(event);
}

/** Lambda `isComplete` entry point for the CDK Provider framework. */
export async function isComplete(event: LifecycleEvent): Promise<IsCompleteResponse> {
  return createForumLifecycleIsComplete(buildDeps())(event);
}
