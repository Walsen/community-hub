/**
 * Unit tests for the forum lifecycle custom-resource handler
 * (`src/infra/handlers/forum-lifecycle.ts`).
 *
 * Both phases are driven through their injectable factories
 * ({@link createForumLifecycleOnEvent}, {@link createForumLifecycleIsComplete})
 * with fake Lightsail and SSM clients ({@link createFakeAwsClient},
 * {@link queueResponses}), a fixed clock, and a real {@link Redactor} feeding a
 * capturing {@link Logger}. No real AWS, no network, no real timers.
 *
 * Coverage follows the testing steering `infra/handlers/*` row for the
 * lifecycle final snapshot: Create/Update no-ops issue no mutating calls;
 * the Delete happy path snapshots then deregisters the managed node and deletes
 * its activation in order with the right request shapes; an already-gone
 * instance (and a missing snapshot on the poll) is tolerated; a snapshot
 * `error` state throws a typed {@link ForumLifecycleError}; and no secret
 * reaches the logs, `Data`, or errors.
 */

import { describe, expect, it } from 'vitest';
import {
  CreateInstanceSnapshotCommand,
  GetInstanceSnapshotCommand,
  type LightsailClient,
} from '@aws-sdk/client-lightsail';
import {
  DeleteActivationCommand,
  DeregisterManagedInstanceCommand,
  DescribeActivationsCommand,
  DescribeInstanceInformationCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';

import {
  ForumLifecycleError,
  createForumLifecycleIsComplete,
  createForumLifecycleOnEvent,
  type IsCompleteResponse,
  type LifecycleEvent,
  type OnEventResponse,
} from '../../../src/infra/handlers/forum-lifecycle.js';
import { Redactor, createLogger, type Logger } from '../../../src/shared/logger.js';
import { names } from '../../../src/infra/naming.js';
import { createFakeAwsClient, queueResponses, type FakeBehaviors } from '../../support/fake-aws.js';

const ENV = 'community-prod';
const FORUM_ID = 'main';
const INSTANCE_NAME = names.instance(ENV, FORUM_ID);
const PHYSICAL_ID = `${ENV}-${FORUM_ID}-lifecycle`;

/** A fixed clock so the snapshot name stamp is deterministic. */
const NOW = new Date('2024-01-02T03:04:05.678Z');
/** The deterministic final snapshot name derived from NOW. */
const SNAPSHOT_NAME = names.finalSnapshot(ENV, FORUM_ID, '20240102030405');

const ACTIVATION_ID = 'test-activation-id';
const MANAGED_INSTANCE_ID = 'mi-0123456789abcdef0';

/** The plain, non-secret resource properties the custom resource carries. */
const RESOURCE_PROPERTIES = {
  environment: ENV,
  forumId: FORUM_ID,
  instanceName: INSTANCE_NAME,
} as const;

/** A capturing log sink plus the lines it collected. */
interface CapturedLogger {
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly lines: string[];
}

/** Build a logger that records every serialized line for inspection. */
function captureLogger(): CapturedLogger {
  const lines: string[] = [];
  const redactor = new Redactor();
  const logger = createLogger({
    sink: { write: (line) => lines.push(line) },
    redactor,
  });
  return { logger, redactor, lines };
}

/** An AWS SDK error whose `name` marks the resource as already gone. */
function notFoundError(name = 'NotFoundException'): Error {
  return Object.assign(new Error('resource not found: body should never be logged'), { name });
}

/** Build both phase handlers over shared fake clients and a captured logger. */
function build(behaviors: { readonly lightsail?: FakeBehaviors; readonly ssm?: FakeBehaviors }): {
  onEvent: (e: LifecycleEvent) => Promise<OnEventResponse>;
  isComplete: (e: LifecycleEvent) => Promise<IsCompleteResponse>;
  lightsail: ReturnType<typeof createFakeAwsClient>;
  ssm: ReturnType<typeof createFakeAwsClient>;
  log: CapturedLogger;
} {
  const lightsail = createFakeAwsClient(behaviors.lightsail ?? {});
  const ssm = createFakeAwsClient(behaviors.ssm ?? {});
  const log = captureLogger();
  const lightsailDep: Pick<LightsailClient, 'send'> = lightsail;
  const ssmDep: Pick<SSMClient, 'send'> = ssm;
  const deps = {
    lightsail: lightsailDep,
    ssm: ssmDep,
    now: () => NOW,
    logger: log.logger,
    redactor: log.redactor,
  };
  return {
    onEvent: createForumLifecycleOnEvent(deps),
    isComplete: createForumLifecycleIsComplete(deps),
    lightsail,
    ssm,
    log,
  };
}

/** A lifecycle event of the given request type carrying the resource properties. */
function event(
  requestType: LifecycleEvent['RequestType'],
  extra?: { readonly Data?: Readonly<Record<string, string>> },
): LifecycleEvent {
  // The handler reads an undeclared `Data` field off the event (the provider
  // framework merges onEvent's Data into the isComplete event), so the test
  // event carries it alongside the declared LifecycleEvent fields.
  const withData: LifecycleEvent & { readonly Data?: Readonly<Record<string, string>> } = {
    RequestType: requestType,
    PhysicalResourceId: PHYSICAL_ID,
    ResourceProperties: RESOURCE_PROPERTIES,
    ...(extra?.Data === undefined ? {} : { Data: extra.Data }),
  };
  return withData;
}

/** SSM behaviors for a clean managed-node teardown on Delete. */
function teardownSsm(): FakeBehaviors {
  return {
    DescribeActivationsCommand: { ActivationList: [{ ActivationId: ACTIVATION_ID }] },
    DescribeInstanceInformationCommand: {
      InstanceInformationList: [{ InstanceId: MANAGED_INSTANCE_ID }],
    },
    DeregisterManagedInstanceCommand: {},
    DeleteActivationCommand: {},
  };
}

describe('createForumLifecycleOnEvent', () => {
  describe('Create and Update are no-ops', () => {
    it.each(['Create', 'Update'] as const)(
      'returns the deterministic physical id and issues no mutating calls (%s)',
      async (requestType) => {
        const { onEvent, lightsail, ssm } = build({});

        const res = await onEvent(event(requestType));

        expect(res.PhysicalResourceId).toBe(PHYSICAL_ID);
        expect(res.Data).toBeUndefined();
        expect(lightsail.calls).toHaveLength(0);
        expect(ssm.calls).toHaveLength(0);
      },
    );
  });

  describe('Delete happy path', () => {
    it('creates the final snapshot with the deterministic name and env/forum tags', async () => {
      const { onEvent, lightsail, ssm } = build({
        lightsail: { CreateInstanceSnapshotCommand: {} },
      });

      const res = await onEvent(event('Delete'));

      expect(res.PhysicalResourceId).toBe(PHYSICAL_ID);
      expect(res.Data).toEqual({ SnapshotName: SNAPSHOT_NAME });

      expect(lightsail.countFor('CreateInstanceSnapshotCommand')).toBe(1);
      const [call] = lightsail.callsFor('CreateInstanceSnapshotCommand');
      const input = call?.input as {
        instanceName: string;
        instanceSnapshotName: string;
        tags: { key: string; value: string }[];
      };
      expect(input.instanceName).toBe(INSTANCE_NAME);
      expect(input.instanceSnapshotName).toBe(SNAPSHOT_NAME);
      expect(input.tags).toEqual([
        { key: 'community-hub:environment', value: ENV },
        { key: 'community-hub:forum', value: FORUM_ID },
      ]);

      // onEvent never touches SSM; teardown is the isComplete phase.
      expect(ssm.calls).toHaveLength(0);
    });
  });

  describe('instance already gone', () => {
    it('tolerates a NotFoundException on CreateInstanceSnapshot and reports no snapshot', async () => {
      const { onEvent, lightsail } = build({
        lightsail: { CreateInstanceSnapshotCommand: notFoundError('DoesNotExist') },
      });

      const res = await onEvent(event('Delete'));

      // No Data means isComplete has nothing to poll and finishes immediately.
      expect(res.PhysicalResourceId).toBe(PHYSICAL_ID);
      expect(res.Data).toBeUndefined();
      expect(lightsail.countFor('CreateInstanceSnapshotCommand')).toBe(1);
    });
  });

  describe('non-not-found snapshot failure', () => {
    it('throws a typed ForumLifecycleError carrying operation and error name only', async () => {
      const sdkError = Object.assign(new Error('throttled: body must not surface'), {
        name: 'ThrottlingException',
      });
      const { onEvent } = build({
        lightsail: { CreateInstanceSnapshotCommand: sdkError },
      });

      await expect(onEvent(event('Delete'))).rejects.toMatchObject({
        name: 'ForumLifecycleError',
        forumId: FORUM_ID,
        operation: 'CreateInstanceSnapshot',
        awsErrorName: 'ThrottlingException',
      });
    });
  });
});

describe('createForumLifecycleIsComplete', () => {
  describe('Create and Update', () => {
    it.each(['Create', 'Update'] as const)(
      'reports complete immediately with no calls (%s)',
      async (requestType) => {
        const { isComplete, lightsail, ssm } = build({});

        const res = await isComplete(event(requestType));

        expect(res.IsComplete).toBe(true);
        expect(lightsail.calls).toHaveLength(0);
        expect(ssm.calls).toHaveLength(0);
      },
    );
  });

  describe('Delete happy path', () => {
    it('polls the snapshot pending then available, then tears down the managed node in order', async () => {
      const { isComplete, lightsail, ssm } = build({
        lightsail: {
          GetInstanceSnapshotCommand: queueResponses([
            { instanceSnapshot: { state: 'pending' } },
            { instanceSnapshot: { state: 'available' } },
          ]),
        },
        ssm: teardownSsm(),
      });

      const del = event('Delete', { Data: { SnapshotName: SNAPSHOT_NAME } });

      // First poll: snapshot still pending, nothing torn down yet.
      const first = await isComplete(del);
      expect(first.IsComplete).toBe(false);
      expect(ssm.calls).toHaveLength(0);

      // Second poll: snapshot available, teardown runs and the delete completes.
      const second = await isComplete(del);
      expect(second.IsComplete).toBe(true);

      // Snapshot poll request shape.
      const [getCall] = lightsail.callsFor('GetInstanceSnapshotCommand');
      expect((getCall?.input as { instanceSnapshotName: string }).instanceSnapshotName).toBe(
        SNAPSHOT_NAME,
      );
      expect(lightsail.countFor('GetInstanceSnapshotCommand')).toBe(2);

      // Teardown issued exactly once each, in order:
      // DescribeActivations -> DescribeInstanceInformation -> Deregister -> DeleteActivation.
      expect(ssm.countFor('DescribeActivationsCommand')).toBe(1);
      expect(ssm.countFor('DescribeInstanceInformationCommand')).toBe(1);
      expect(ssm.countFor('DeregisterManagedInstanceCommand')).toBe(1);
      expect(ssm.countFor('DeleteActivationCommand')).toBe(1);
      expect(ssm.calls.map((c) => c.command)).toEqual([
        'DescribeActivationsCommand',
        'DescribeInstanceInformationCommand',
        'DeregisterManagedInstanceCommand',
        'DeleteActivationCommand',
      ]);

      // Request shapes for the teardown calls.
      const [describeAct] = ssm.callsFor('DescribeActivationsCommand');
      expect(
        (describeAct?.input as { Filters: { FilterKey: string; FilterValues: string[] }[] })
          .Filters,
      ).toEqual([
        { FilterKey: 'DefaultInstanceName', FilterValues: [names.activationName(ENV, FORUM_ID)] },
      ]);

      const [describeInfo] = ssm.callsFor('DescribeInstanceInformationCommand');
      expect(
        (describeInfo?.input as { Filters: { Key: string; Values: string[] }[] }).Filters,
      ).toEqual([{ Key: 'ActivationIds', Values: [ACTIVATION_ID] }]);

      const [deregister] = ssm.callsFor('DeregisterManagedInstanceCommand');
      expect((deregister?.input as { InstanceId: string }).InstanceId).toBe(MANAGED_INSTANCE_ID);

      const [deleteAct] = ssm.callsFor('DeleteActivationCommand');
      expect((deleteAct?.input as { ActivationId: string }).ActivationId).toBe(ACTIVATION_ID);
    });

    it('completes without polling when onEvent recorded no snapshot name', async () => {
      const { isComplete, lightsail, ssm } = build({ ssm: teardownSsm() });

      // No Data: the instance was already gone, so there is nothing to wait for.
      const res = await isComplete(event('Delete'));

      expect(res.IsComplete).toBe(true);
      expect(lightsail.calls).toHaveLength(0);
      // Teardown still runs best-effort.
      expect(ssm.countFor('DeleteActivationCommand')).toBe(1);
    });
  });

  describe('snapshot or instance already gone on the poll', () => {
    it('treats a NotFoundException on GetInstanceSnapshot as complete and still tears down', async () => {
      const { isComplete, ssm } = build({
        lightsail: { GetInstanceSnapshotCommand: notFoundError() },
        ssm: teardownSsm(),
      });

      const res = await isComplete(event('Delete', { Data: { SnapshotName: SNAPSHOT_NAME } }));

      expect(res.IsComplete).toBe(true);
      expect(ssm.countFor('DeregisterManagedInstanceCommand')).toBe(1);
      expect(ssm.countFor('DeleteActivationCommand')).toBe(1);
    });
  });

  describe('snapshot error state', () => {
    it('throws a typed ForumLifecycleError and does not tear down the node', async () => {
      const { isComplete, ssm } = build({
        lightsail: { GetInstanceSnapshotCommand: { instanceSnapshot: { state: 'error' } } },
        ssm: teardownSsm(),
      });

      await expect(
        isComplete(event('Delete', { Data: { SnapshotName: SNAPSHOT_NAME } })),
      ).rejects.toMatchObject({
        name: 'ForumLifecycleError',
        forumId: FORUM_ID,
        operation: 'GetInstanceSnapshot',
        awsErrorName: 'SnapshotError',
      });

      // The error state short-circuits before any SSM teardown.
      expect(ssm.calls).toHaveLength(0);
    });
  });
});

describe('secret hygiene and error shape', () => {
  it('logs the AWS error name but never a response body on failure', async () => {
    const sdkError = Object.assign(new Error('secret-ish body that must never be logged'), {
      name: 'ThrottlingException',
    });
    const { onEvent, log } = build({
      lightsail: { CreateInstanceSnapshotCommand: sdkError },
    });

    await expect(onEvent(event('Delete'))).rejects.toBeInstanceOf(ForumLifecycleError);

    const combined = log.lines.join('\n');
    expect(combined).toContain('ThrottlingException');
    expect(combined).not.toContain('secret-ish body that must never be logged');
  });

  it('carries only operation name and error code on the thrown error', async () => {
    const sdkError = Object.assign(new Error('do not surface this'), { name: 'AccessDenied' });
    const { isComplete } = build({
      lightsail: { GetInstanceSnapshotCommand: sdkError },
      ssm: teardownSsm(),
    });

    const caught = await isComplete(
      event('Delete', { Data: { SnapshotName: SNAPSHOT_NAME } }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(ForumLifecycleError);
    const err = caught as ForumLifecycleError;
    expect(err.operation).toBe('GetInstanceSnapshot');
    expect(err.awsErrorName).toBe('AccessDenied');
    // The message is built from identifiers only, never the SDK body.
    expect(err.message).not.toContain('do not surface this');
    expect(err.message).toContain('GetInstanceSnapshot');
    expect(err.message).toContain(FORUM_ID);
  });
});

// Keep the fake-routing command names in lockstep with the handler's imports.
describe('command name invariants', () => {
  it('uses the SDK command class names the fake routes on', () => {
    expect(CreateInstanceSnapshotCommand.name).toBe('CreateInstanceSnapshotCommand');
    expect(GetInstanceSnapshotCommand.name).toBe('GetInstanceSnapshotCommand');
    expect(DescribeActivationsCommand.name).toBe('DescribeActivationsCommand');
    expect(DescribeInstanceInformationCommand.name).toBe('DescribeInstanceInformationCommand');
    expect(DeregisterManagedInstanceCommand.name).toBe('DeregisterManagedInstanceCommand');
    expect(DeleteActivationCommand.name).toBe('DeleteActivationCommand');
  });
});
