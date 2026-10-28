/**
 * Unit tests for the email-refresh custom-resource handler
 * (`src/infra/handlers/email-refresh.ts`).
 *
 * The two phases are driven through their injectable factories
 * ({@link createEmailRefreshOnEvent}, {@link createEmailRefreshIsComplete}) with
 * a fake SSM client ({@link createFakeAwsClient}), a fixed clock, an injected
 * `sleep` that is a no-op spy (it never starts a real timer), and a real
 * {@link Redactor} feeding a capturing {@link Logger}. Events are built with
 * {@link makeCfnEvent}. No real AWS, no network, no real timers.
 *
 * Coverage follows the testing steering `infra/handlers/*` row for email
 * refresh ("email refresh statuses; no secret in logs/Data/errors"): the full
 * `RefreshStatus` surface — `initial` (Create/Delete), `node-offline`,
 * `applied`, `failed` — plus the restore-if-needed branch (username match vs
 * mismatch re-put from the labelled version), the injected-sleep key
 * propagation wait, the Run Command request shape, the completion poll
 * (InProgress then Success, and Failed), the never-fails-the-deploy guarantees
 * (malformed properties and SDK errors resolve rather than throw), and secret
 * hygiene: a restored password is registered with the redactor and never
 * appears in captured logs.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DescribeActivationsCommand,
  DescribeInstanceInformationCommand,
  GetCommandInvocationCommand,
  GetParameterCommand,
  PutParameterCommand,
  SendCommandCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';

import {
  createEmailRefreshIsComplete,
  createEmailRefreshOnEvent,
  type EmailRefreshEvent,
  type IsCompleteResponse,
  type OnEventResponse,
} from '../../../src/infra/handlers/email-refresh.js';
import { names } from '../../../src/infra/naming.js';
import { Redactor, createLogger, type Logger } from '../../../src/shared/logger.js';
import { createFakeAwsClient, queueResponses, type FakeBehaviors } from '../../support/fake-aws.js';
import { makeCfnEvent } from '../../support/fake-cfn.js';

const ENV = 'community-prod';
const FORUM_ID = 'main';
const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const OTHER_KEY_ID = 'AKIANEWROTATEDKEY01';
const INSTANCE_ID = 'mi-0123456789abcdef0';
const ACTIVATION_ID = 'activation-0123456789';

const USERNAME_PARAM = names.sesParameter(ENV, FORUM_ID, 'username');
const PASSWORD_PARAM = names.sesParameter(ENV, FORUM_ID, 'password');
const DEFAULT_INSTANCE_NAME = names.activationName(ENV, FORUM_ID);

/** Delay the handler waits for IAM key propagation; injected sleep receives it. */
const KEY_PROPAGATION_DELAY_MS = 10_000;

/** A fixed clock; the handler reads it only for log-context determinism. */
const NOW = new Date('2024-01-02T03:04:05.678Z');

/** An obvious placeholder password; never a realistic secret. */
const RESTORED_PASSWORD = 'test-secret-value';

/** Plain, non-secret resource properties the custom resource carries. */
const RESOURCE_PROPERTIES = {
  environment: ENV,
  forumId: FORUM_ID,
  accessKeyId: ACCESS_KEY_ID,
} as const;

/** The deterministic physical id the handler returns for these properties. */
const PHYSICAL_ID = `${ENV}-${FORUM_ID}-email-refresh`;

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

/** An AWS SDK error with a `name`, whose message must never be surfaced. */
function sdkError(name: string): Error {
  return Object.assign(new Error('sdk body that must never be logged'), { name });
}

/** A no-op sleep spy: records calls, never starts a real timer. */
function fakeSleep(): (ms: number) => Promise<void> {
  return vi.fn((): Promise<void> => Promise.resolve());
}

/** A built onEvent harness over a fake SSM client and captured logger. */
interface OnEventHarness {
  onEvent: (e: EmailRefreshEvent) => Promise<OnEventResponse>;
  ssm: ReturnType<typeof createFakeAwsClient>;
  sleep: ReturnType<typeof fakeSleep>;
  log: CapturedLogger;
}

/** A built isComplete harness over a fake SSM client and captured logger. */
interface IsCompleteHarness {
  isComplete: (e: EmailRefreshEvent) => Promise<IsCompleteResponse>;
  ssm: ReturnType<typeof createFakeAwsClient>;
  sleep: ReturnType<typeof fakeSleep>;
  log: CapturedLogger;
}

/** Build the onEvent phase over a fake SSM client and captured logger. */
function buildOnEvent(behaviors: FakeBehaviors = {}): OnEventHarness {
  const ssm = createFakeAwsClient(behaviors);
  const sleep = fakeSleep();
  const log = captureLogger();
  const ssmDep: Pick<SSMClient, 'send'> = ssm;
  const onEvent = createEmailRefreshOnEvent({
    ssm: ssmDep,
    sleep,
    now: () => NOW,
    logger: log.logger,
    redactor: log.redactor,
  });
  return { onEvent, ssm, sleep, log };
}

/** Build the isComplete phase over a fake SSM client and captured logger. */
function buildIsComplete(behaviors: FakeBehaviors = {}): IsCompleteHarness {
  const ssm = createFakeAwsClient(behaviors);
  const sleep = fakeSleep();
  const log = captureLogger();
  const ssmDep: Pick<SSMClient, 'send'> = ssm;
  const isComplete = createEmailRefreshIsComplete({
    ssm: ssmDep,
    sleep,
    now: () => NOW,
    logger: log.logger,
    redactor: log.redactor,
  });
  return { isComplete, ssm, sleep, log };
}

/** SSM behaviors: the stored username already matches the target key id. */
function usernameMatches(): FakeBehaviors {
  return { GetParameterCommand: { Parameter: { Value: ACCESS_KEY_ID } } };
}

/** SSM behaviors: an online managed node is discoverable for the forum. */
function onlineNode(): FakeBehaviors {
  return {
    DescribeActivationsCommand: { ActivationList: [{ ActivationId: ACTIVATION_ID }] },
    DescribeInstanceInformationCommand: {
      InstanceInformationList: [{ PingStatus: 'Online', InstanceId: INSTANCE_ID }],
    },
  };
}

describe('createEmailRefreshOnEvent Create and Delete', () => {
  it('Create returns RefreshStatus initial and issues no SSM calls', async () => {
    const { onEvent, ssm, sleep } = buildOnEvent();

    const res = await onEvent(makeCfnEvent({ ResourceProperties: RESOURCE_PROPERTIES }));

    expect(res.PhysicalResourceId).toBe(PHYSICAL_ID);
    expect(res.Data).toEqual({ RefreshStatus: 'initial' });
    // Create touches no SSM API and never waits.
    expect(ssm.calls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('Delete is a no-op initial with no SSM calls', async () => {
    const { onEvent, ssm, sleep } = buildOnEvent();

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Delete',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    expect(res.PhysicalResourceId).toBe(PHYSICAL_ID);
    expect(res.Data).toEqual({ RefreshStatus: 'initial' });
    expect(ssm.calls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('isComplete reports complete immediately when no command was sent', async () => {
    const { isComplete, ssm } = buildIsComplete();

    const res = await isComplete(
      makeCfnEvent({
        RequestType: 'Create',
        ResourceProperties: RESOURCE_PROPERTIES,
        // The provider merges onEvent Data in; an initial status carries no CommandId.
        ...({ Data: { RefreshStatus: 'initial' } } as object),
      }),
    );

    expect(res.IsComplete).toBe(true);
    expect(ssm.calls).toHaveLength(0);
  });
});

describe('createEmailRefreshOnEvent Update, node offline', () => {
  it('returns node-offline with no SendCommand but still waits for key propagation', async () => {
    const { onEvent, ssm, sleep } = buildOnEvent({
      ...usernameMatches(),
      // No activations: no node registered at all.
      DescribeActivationsCommand: { ActivationList: [] },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    expect(res.Data).toEqual({ RefreshStatus: 'node-offline' });
    expect(ssm.countFor('SendCommandCommand')).toBe(0);
    // The key-propagation wait happened through the injected sleep.
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(KEY_PROPAGATION_DELAY_MS);
  });

  it('treats a node whose PingStatus is not Online as offline', async () => {
    const { onEvent, ssm } = buildOnEvent({
      ...usernameMatches(),
      DescribeActivationsCommand: { ActivationList: [{ ActivationId: ACTIVATION_ID }] },
      DescribeInstanceInformationCommand: {
        InstanceInformationList: [{ PingStatus: 'ConnectionLost', InstanceId: INSTANCE_ID }],
      },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    expect(res.Data).toEqual({ RefreshStatus: 'node-offline' });
    expect(ssm.countFor('SendCommandCommand')).toBe(0);
  });

  it('isComplete reports complete immediately for a node-offline result', async () => {
    const { isComplete, ssm } = buildIsComplete();

    const res = await isComplete(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
        ...({ Data: { RefreshStatus: 'node-offline' } } as object),
      }),
    );

    expect(res.IsComplete).toBe(true);
    expect(ssm.calls).toHaveLength(0);
  });
});

describe('createEmailRefreshOnEvent Update, applied', () => {
  it('skips the re-put when the stored username already matches, then dispatches the refresh', async () => {
    const { onEvent, ssm, sleep } = buildOnEvent({
      ...usernameMatches(),
      ...onlineNode(),
      SendCommandCommand: { Command: { CommandId: 'cmd-abc123' } },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    // The username already matched, so no password/username re-put happened.
    expect(ssm.countFor('PutParameterCommand')).toBe(0);
    expect(ssm.countFor('GetParameterCommand')).toBe(1);
    // The propagation wait still happened.
    expect(sleep).toHaveBeenCalledWith(KEY_PROPAGATION_DELAY_MS);

    // The command id is recorded under Data for the completion phase.
    expect(res.Data?.RefreshStatus).toBe('applied');
    expect(res.Data?.CommandId).toBe('cmd-abc123');
    expect(res.Data?.InstanceId).toBe(INSTANCE_ID);

    // The Run Command request shape: AWS-RunShellScript running the refresh script.
    expect(ssm.countFor('SendCommandCommand')).toBe(1);
    const [send] = ssm.callsFor('SendCommandCommand');
    const sendInput = send?.input as {
      DocumentName: string;
      InstanceIds: string[];
      Parameters: { commands: string[] };
    };
    expect(sendInput.DocumentName).toBe('AWS-RunShellScript');
    expect(sendInput.InstanceIds).toEqual([INSTANCE_ID]);
    expect(sendInput.Parameters.commands).toEqual(['/opt/community-hub/bin/refresh-email.sh']);
  });

  it('re-puts both parameters from the labelled version when the stored username mismatches', async () => {
    const { onEvent, ssm } = buildOnEvent({
      // First GetParameter (username) returns a different key; second
      // (labelled password) returns the restore password.
      GetParameterCommand: queueResponses([
        { Parameter: { Value: OTHER_KEY_ID } },
        { Parameter: { Value: RESTORED_PASSWORD } },
      ]),
      PutParameterCommand: { Version: 2 },
      ...onlineNode(),
      SendCommandCommand: { Command: { CommandId: 'cmd-xyz789' } },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    expect(res.Data?.RefreshStatus).toBe('applied');

    // Username was read, then the labelled password version was read.
    const gets = ssm.callsFor('GetParameterCommand');
    expect(gets).toHaveLength(2);
    expect((gets[0]?.input as { Name: string }).Name).toBe(USERNAME_PARAM);
    const labelledGet = gets[1]?.input as { Name: string; WithDecryption?: boolean };
    expect(labelledGet.Name).toBe(`${PASSWORD_PARAM}:${ACCESS_KEY_ID}`);
    expect(labelledGet.WithDecryption).toBe(true);

    // Both parameters were re-put: password (SecureString) and username (String).
    const puts = ssm.callsFor('PutParameterCommand');
    expect(puts).toHaveLength(2);
    const passwordPut = puts.find((c) => (c.input as { Name: string }).Name === PASSWORD_PARAM);
    const usernamePut = puts.find((c) => (c.input as { Name: string }).Name === USERNAME_PARAM);
    expect(passwordPut).toBeDefined();
    expect(usernamePut).toBeDefined();
    const passwordInput = passwordPut?.input as { Type: string; Value: string; Overwrite: boolean };
    expect(passwordInput.Type).toBe('SecureString');
    expect(passwordInput.Value).toBe(RESTORED_PASSWORD);
    expect(passwordInput.Overwrite).toBe(true);
    const usernameInput = usernamePut?.input as { Type: string; Value: string };
    expect(usernameInput.Type).toBe('String');
    expect(usernameInput.Value).toBe(ACCESS_KEY_ID);
  });

  it('issues DescribeActivations filtered by the forum default instance name', async () => {
    const { onEvent, ssm } = buildOnEvent({
      ...usernameMatches(),
      ...onlineNode(),
      SendCommandCommand: { Command: { CommandId: 'cmd-abc123' } },
    });

    await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    const [describe] = ssm.callsFor('DescribeActivationsCommand');
    const input = describe?.input as {
      Filters: { FilterKey: string; FilterValues: string[] }[];
    };
    expect(input.Filters[0]?.FilterKey).toBe('DefaultInstanceName');
    expect(input.Filters[0]?.FilterValues).toEqual([DEFAULT_INSTANCE_NAME]);
  });

  it('isComplete polls GetCommandInvocation: InProgress then Success -> applied', async () => {
    const { isComplete, ssm } = buildIsComplete({
      GetCommandInvocationCommand: queueResponses([
        { Status: 'InProgress' },
        { Status: 'Success' },
      ]),
    });

    const event = makeCfnEvent({
      RequestType: 'Update',
      PhysicalResourceId: PHYSICAL_ID,
      ResourceProperties: RESOURCE_PROPERTIES,
      Data: { RefreshStatus: 'applied', CommandId: 'cmd-abc123', InstanceId: INSTANCE_ID },
    });

    const first = await isComplete(event);
    expect(first.IsComplete).toBe(false);

    const second = await isComplete(event);
    expect(second.IsComplete).toBe(true);
    expect(second.Data).toEqual({ RefreshStatus: 'applied' });

    // The poll request carries the recorded command and instance ids.
    const [poll] = ssm.callsFor('GetCommandInvocationCommand');
    const pollInput = poll?.input as { CommandId: string; InstanceId: string };
    expect(pollInput.CommandId).toBe('cmd-abc123');
    expect(pollInput.InstanceId).toBe(INSTANCE_ID);
  });
});

describe('createEmailRefreshIsComplete failed command', () => {
  it('maps a Failed command to failed and never throws', async () => {
    const { isComplete } = buildIsComplete({
      GetCommandInvocationCommand: { Status: 'Failed' },
    });

    const res = await isComplete(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
        Data: { RefreshStatus: 'applied', CommandId: 'cmd-abc123', InstanceId: INSTANCE_ID },
      }),
    );

    // A failed command still completes the resource; it does not fail the deploy.
    expect(res.IsComplete).toBe(true);
    expect(res.Data).toEqual({ RefreshStatus: 'failed' });
  });
});

describe('never fails the deploy', () => {
  it('resolves with failed on malformed resource properties', async () => {
    const { onEvent, ssm, sleep } = buildOnEvent();

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        // Missing forumId and accessKeyId: fails the strict schema.
        ResourceProperties: { environment: ENV },
      }),
    );

    expect(res.Data).toEqual({ RefreshStatus: 'failed' });
    // It fell back to the event's physical id and never called SSM or slept.
    expect(res.PhysicalResourceId).toBe(PHYSICAL_ID);
    expect(ssm.calls).toHaveLength(0);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('resolves with failed when SendCommand errors', async () => {
    const { onEvent } = buildOnEvent({
      ...usernameMatches(),
      ...onlineNode(),
      SendCommandCommand: sdkError('InvalidInstanceId'),
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    expect(res.Data).toEqual({ RefreshStatus: 'failed' });
  });

  it('resolves with failed when the completion poll errors', async () => {
    const { isComplete } = buildIsComplete({
      GetCommandInvocationCommand: sdkError('InvocationDoesNotExist'),
    });

    const res = await isComplete(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
        Data: { RefreshStatus: 'applied', CommandId: 'cmd-abc123', InstanceId: INSTANCE_ID },
      }),
    );

    expect(res.IsComplete).toBe(true);
    expect(res.Data).toEqual({ RefreshStatus: 'failed' });
  });
});

describe('secret hygiene', () => {
  it('registers the restored password with the redactor and never leaks it in logs', async () => {
    const { onEvent, log } = buildOnEvent({
      GetParameterCommand: queueResponses([
        { Parameter: { Value: OTHER_KEY_ID } },
        { Parameter: { Value: RESTORED_PASSWORD } },
      ]),
      PutParameterCommand: { Version: 2 },
      ...onlineNode(),
      SendCommandCommand: { Command: { CommandId: 'cmd-xyz789' } },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: PHYSICAL_ID,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    // The restored password appears in no captured log line, no Data, no id.
    const combinedLogs = log.lines.join('\n');
    expect(combinedLogs).not.toContain(RESTORED_PASSWORD);
    expect(JSON.stringify(res)).not.toContain(RESTORED_PASSWORD);

    // Even if a secret-registered value were logged, it would be redacted:
    // confirm the redactor is holding the restored password as a backstop.
    expect(log.redactor.redact(`value=${RESTORED_PASSWORD}`)).not.toContain(RESTORED_PASSWORD);
  });
});

// Keep the fake-routing command names in lockstep with the handler's imports.
describe('command name invariants', () => {
  it('uses the SDK command class names the fake routes on', () => {
    expect(DescribeActivationsCommand.name).toBe('DescribeActivationsCommand');
    expect(DescribeInstanceInformationCommand.name).toBe('DescribeInstanceInformationCommand');
    expect(GetCommandInvocationCommand.name).toBe('GetCommandInvocationCommand');
    expect(GetParameterCommand.name).toBe('GetParameterCommand');
    expect(PutParameterCommand.name).toBe('PutParameterCommand');
    expect(SendCommandCommand.name).toBe('SendCommandCommand');
  });
});
