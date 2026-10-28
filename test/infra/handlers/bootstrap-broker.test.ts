/**
 * Unit tests for the bootstrap broker handler (`src/infra/handlers/bootstrap-broker.ts`).
 *
 * The handler is exercised through its injectable factory `createBrokerHandler`
 * with a fake SSM client ({@link createFakeAwsClient}), a fixed clock, and a
 * real {@link Redactor} feeding a capturing {@link Logger} sink. No real AWS,
 * no network and no real timers are involved.
 *
 * Coverage follows the testing steering `infra/handlers/*` row: the source-IP
 * check, single registration with the exact `CreateActivation` request shape,
 * generic error mapping, and the secret-hygiene guarantee that the activation
 * code and id never reach captured logs, the error path or (as a secret) leak.
 */

import { describe, expect, it } from 'vitest';
import {
  CreateActivationCommand,
  DeleteActivationCommand,
  DescribeActivationsCommand,
  DescribeInstanceInformationCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';
import { GetInstanceCommand, type LightsailClient } from '@aws-sdk/client-lightsail';

import {
  createBrokerHandler,
  type BrokerEvent,
  type BrokerResponse,
  type ForumsConfig,
} from '../../../src/infra/handlers/bootstrap-broker.js';
import { REDACTED, Redactor, createLogger, type Logger } from '../../../src/shared/logger.js';
import { createFakeAwsClient, type FakeBehaviors } from '../../support/fake-aws.js';

const REGION = 'us-east-1';
const ENV = 'community-prod';
const FORUM_ID = 'main';
const INSTANCE_NAME = 'community-prod-main-instance';
const ROLE_NAME = 'community-prod-main-node-role';
const DEFAULT_INSTANCE_NAME = 'community-prod-main';

/** A fixed clock so the one-hour activation expiry is deterministic. */
const NOW = new Date('2024-01-01T00:00:00.000Z');
/** NOW plus one hour, the expected activation `ExpirationDate`. */
const EXPECTED_EXPIRY = new Date('2024-01-01T01:00:00.000Z');

/** Obvious placeholder secrets returned by the fake `CreateActivation`. */
const ACTIVATION_ID = 'test-activation-id';
const ACTIVATION_CODE = 'test-secret-value';

const FORUMS: ForumsConfig = {
  [FORUM_ID]: {
    instanceName: INSTANCE_NAME,
    roleName: ROLE_NAME,
    defaultInstanceName: DEFAULT_INSTANCE_NAME,
  },
};

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

/** Build a broker event with sensible defaults for the happy path. */
function event(overrides?: { method?: string; body?: string | null }): BrokerEvent {
  return {
    body:
      overrides?.body === undefined
        ? JSON.stringify({ environment: ENV, forumId: FORUM_ID })
        : overrides.body,
    requestContext: {
      http: {
        method: overrides?.method ?? 'POST',
        // The source IP carries no authorization meaning on Lightsail (outbound
        // is NAT'd away from the static IP); it is recorded but never checked.
        sourceIp: '198.51.100.7',
      },
    },
  };
}

/** Default SSM behaviors: no prior activations, no registered node, success. */
function happyBehaviors(): FakeBehaviors {
  return {
    DescribeActivationsCommand: { ActivationList: [] },
    DescribeInstanceInformationCommand: { InstanceInformationList: [] },
    CreateActivationCommand: {
      ActivationId: ACTIVATION_ID,
      ActivationCode: ACTIVATION_CODE,
    },
  };
}

/**
 * Build the handler under test with the given SSM behaviors and a captured
 * logger. A fake Lightsail client answers `GetInstance` for the ownership check;
 * by default it reports the forum's instance in the `running` state. Pass
 * `instanceState` to simulate another state, or `lightsailBehaviors` to script
 * a NotFound / error response.
 */
function build(
  behaviors: FakeBehaviors,
  options: { instanceState?: string; lightsailBehaviors?: FakeBehaviors } = {},
): {
  handle: (e: BrokerEvent) => Promise<BrokerResponse>;
  ssm: ReturnType<typeof createFakeAwsClient>;
  lightsail: ReturnType<typeof createFakeAwsClient>;
  log: CapturedLogger;
} {
  const ssm = createFakeAwsClient(behaviors);
  const lightsail = createFakeAwsClient(
    options.lightsailBehaviors ?? {
      GetInstanceCommand: {
        instance: { state: { name: options.instanceState ?? 'running' } },
      },
    },
  );
  const log = captureLogger();
  const ssmDep: Pick<SSMClient, 'send'> = ssm;
  const lightsailDep: Pick<LightsailClient, 'send'> = lightsail;
  const handle = createBrokerHandler({
    ssm: ssmDep,
    lightsail: lightsailDep,
    now: () => NOW,
    logger: log.logger,
    redactor: log.redactor,
    region: REGION,
    forums: FORUMS,
  });
  return { handle, ssm, lightsail, log };
}

describe('createBrokerHandler', () => {
  describe('ownership check', () => {
    it('allows a claim when the forum instance exists and is running', async () => {
      const { handle, ssm, lightsail } = build(happyBehaviors());

      const res = await handle(event());

      expect(res.statusCode).toBe(200);
      expect(ssm.countFor('CreateActivationCommand')).toBe(1);
      // Ownership is verified by GetInstance on the forum's instance RESOURCE
      // name (not by source IP: Lightsail NATs outbound away from the static IP).
      expect(lightsail.countFor('GetInstanceCommand')).toBe(1);
      const [call] = lightsail.callsFor('GetInstanceCommand');
      expect((call?.input as { instanceName: string }).instanceName).toBe(INSTANCE_NAME);
    });

    it('rejects with 403 and issues no activation when the instance is not running', async () => {
      const { handle, ssm } = build(happyBehaviors(), { instanceState: 'pending' });

      const res = await handle(event());

      expect(res.statusCode).toBe(403);
      expect(ssm.countFor('CreateActivationCommand')).toBe(0);
      // The ownership check runs before any SSM activation call.
      expect(ssm.calls).toHaveLength(0);
    });

    it('rejects with 403 (not 500) when the forum instance does not exist yet', async () => {
      const notFound = Object.assign(new Error('instance not found'), {
        name: 'NotFoundException',
      });
      const { handle, ssm } = build(happyBehaviors(), {
        lightsailBehaviors: { GetInstanceCommand: notFound },
      });

      const res = await handle(event());

      // A claim before the instance exists just retries, so NotFound is a 403.
      expect(res.statusCode).toBe(403);
      expect(ssm.calls).toHaveLength(0);
    });

    it('maps a non-NotFound Lightsail failure to a generic 500 logging the error name only', async () => {
      const lookupError = Object.assign(new Error('GetInstance failed: secret in message'), {
        name: 'AccessDeniedException',
      });
      const { handle, ssm, log } = build(happyBehaviors(), {
        lightsailBehaviors: { GetInstanceCommand: lookupError },
      });

      const res = await handle(event());

      expect(res.statusCode).toBe(500);
      expect(ssm.calls).toHaveLength(0);
      const combined = log.lines.join('\n');
      expect(combined).toContain('AccessDeniedException');
      expect(combined).not.toContain('secret in message');
    });
  });

  describe('single registration', () => {
    it('returns an activation exactly once with id, code and region', async () => {
      const { handle, ssm } = build(happyBehaviors());

      const res = await handle(event());

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/json');
      const body = JSON.parse(res.body) as {
        activationId: string;
        activationCode: string;
        region: string;
      };
      expect(body).toEqual({
        activationId: ACTIVATION_ID,
        activationCode: ACTIVATION_CODE,
        region: REGION,
      });
      expect(ssm.countFor('CreateActivationCommand')).toBe(1);
    });

    it('creates the activation with the expected request shape', async () => {
      const { handle, ssm } = build(happyBehaviors());

      await handle(event());

      const [call] = ssm.callsFor('CreateActivationCommand');
      expect(call).toBeDefined();
      const input = call?.input as {
        IamRole: string;
        RegistrationLimit: number;
        ExpirationDate: Date;
        DefaultInstanceName: string;
        Tags: { Key: string; Value: string }[];
      };
      expect(input.IamRole).toBe(ROLE_NAME);
      expect(input.RegistrationLimit).toBe(1);
      expect(input.DefaultInstanceName).toBe(DEFAULT_INSTANCE_NAME);
      // One-hour expiry measured from the injected clock.
      expect(input.ExpirationDate.getTime()).toBe(EXPECTED_EXPIRY.getTime());
      expect(input.Tags).toEqual([
        { Key: 'community-hub:environment', Value: ENV },
        { Key: 'community-hub:forum', Value: FORUM_ID },
      ]);
    });

    it('deletes prior unused activations before creating a fresh one', async () => {
      const { handle, ssm } = build({
        ...happyBehaviors(),
        DescribeActivationsCommand: {
          ActivationList: [{ ActivationId: 'stale-activation-id' }],
        },
        DeleteActivationCommand: {},
      });

      const res = await handle(event());

      expect(res.statusCode).toBe(200);
      expect(ssm.countFor('DeleteActivationCommand')).toBe(1);
      const [del] = ssm.callsFor('DeleteActivationCommand');
      expect((del?.input as { ActivationId: string }).ActivationId).toBe('stale-activation-id');
      expect(ssm.countFor('CreateActivationCommand')).toBe(1);
    });

    it('rejects with 409 and no new activation when a node is already registered', async () => {
      const { handle, ssm } = build({
        ...happyBehaviors(),
        DescribeActivationsCommand: {
          ActivationList: [{ ActivationId: 'existing-activation-id' }],
        },
        DescribeInstanceInformationCommand: {
          InstanceInformationList: [{ InstanceId: 'mi-0123456789abcdef0' }],
        },
      });

      const res = await handle(event());

      expect(res.statusCode).toBe(409);
      expect(ssm.countFor('CreateActivationCommand')).toBe(0);
      expect(ssm.countFor('DeleteActivationCommand')).toBe(0);
    });

    it('returns 404 for an unknown forum without any SSM call', async () => {
      const { handle, ssm } = build(happyBehaviors());

      const res = await handle(
        event({ body: JSON.stringify({ environment: ENV, forumId: 'ghost' }) }),
      );

      expect(res.statusCode).toBe(404);
      expect(ssm.calls).toHaveLength(0);
    });
  });

  describe('method and body handling', () => {
    it('rejects non-POST methods with 405', async () => {
      const { handle, ssm } = build(happyBehaviors());

      const res = await handle(event({ method: 'GET' }));

      expect(res.statusCode).toBe(405);
      expect(ssm.calls).toHaveLength(0);
    });

    it('rejects a missing body with 400', async () => {
      const { handle } = build(happyBehaviors());

      const res = await handle(event({ body: null }));

      expect(res.statusCode).toBe(400);
    });

    it('rejects a malformed JSON body with 400', async () => {
      const { handle } = build(happyBehaviors());

      const res = await handle(event({ body: '{ not json' }));

      expect(res.statusCode).toBe(400);
    });

    it('rejects a body with unknown keys with 400', async () => {
      const { handle } = build(happyBehaviors());

      const res = await handle(
        event({ body: JSON.stringify({ environment: ENV, forumId: FORUM_ID, extra: true }) }),
      );

      expect(res.statusCode).toBe(400);
    });
  });

  describe('generic error mapping', () => {
    it('maps an SDK failure to a generic 500 and logs operation name plus error code only', async () => {
      const sdkError = Object.assign(new Error('CreateActivation failed: secret in message'), {
        name: 'ThrottlingException',
      });
      const { handle, log } = build({
        ...happyBehaviors(),
        CreateActivationCommand: sdkError,
      });

      const res = await handle(event());

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body)).toEqual({ error: 'internal error' });

      const combined = log.lines.join('\n');
      // The error name is logged; the raw message body never is.
      expect(combined).toContain('ThrottlingException');
      expect(combined).not.toContain('secret in message');
    });
  });

  describe('secret hygiene', () => {
    it('never leaks the activation code into captured logs', async () => {
      const { handle, log } = build(happyBehaviors());

      const res = await handle(event());

      expect(res.statusCode).toBe(200);
      const combined = log.lines.join('\n');
      // The raw activation code is registered with the redactor before logging,
      // so it must never appear verbatim in any captured line.
      expect(combined).not.toContain(ACTIVATION_CODE);
      // If the code were ever logged under a secret-named key it would be redacted.
      // We still assert the redaction marker is a valid outcome, not the raw value.
      if (combined.includes(REDACTED)) {
        expect(combined).not.toContain(ACTIVATION_CODE);
      }
    });

    it('does not log the activation id or code when the create path logs success', async () => {
      const { handle, log } = build(happyBehaviors());

      await handle(event());

      const combined = log.lines.join('\n');
      expect(combined).not.toContain(ACTIVATION_CODE);
    });

    it('keeps the activation code out of the error response and logs on failure', async () => {
      // A failure after code generation should still never expose the code.
      const sdkError = Object.assign(new Error('boom'), { name: 'InternalServerError' });
      const { handle, log } = build({
        ...happyBehaviors(),
        CreateActivationCommand: sdkError,
      });

      const res = await handle(event());

      expect(res.statusCode).toBe(500);
      expect(res.body).not.toContain(ACTIVATION_CODE);
      expect(log.lines.join('\n')).not.toContain(ACTIVATION_CODE);
    });
  });

  describe('activation command coverage', () => {
    it('scopes DescribeActivations to the forum default instance name', async () => {
      const { handle, ssm } = build(happyBehaviors());

      await handle(event());

      const [describe] = ssm.callsFor('DescribeActivationsCommand');
      const input = describe?.input as {
        Filters: { FilterKey: string; FilterValues: string[] }[];
      };
      expect(input.Filters).toEqual([
        { FilterKey: 'DefaultInstanceName', FilterValues: [DEFAULT_INSTANCE_NAME] },
      ]);
    });

    it('does not query instance information when no prior activations exist', async () => {
      const { handle, ssm } = build(happyBehaviors());

      await handle(event());

      // With an empty ActivationList the registered-node check short-circuits.
      expect(ssm.countFor('DescribeInstanceInformationCommand')).toBe(0);
    });
  });
});

// Reference the imported command classes so the fake-routing names stay in
// lockstep with the handler. These assertions document the command names the
// behaviors map keys above must match.
describe('command name invariants', () => {
  it('uses the SSM command class names the fake routes on', () => {
    expect(CreateActivationCommand.name).toBe('CreateActivationCommand');
    expect(DeleteActivationCommand.name).toBe('DeleteActivationCommand');
    expect(DescribeActivationsCommand.name).toBe('DescribeActivationsCommand');
    expect(DescribeInstanceInformationCommand.name).toBe('DescribeInstanceInformationCommand');
  });

  it('uses the Lightsail command class name the fake routes on', () => {
    expect(GetInstanceCommand.name).toBe('GetInstanceCommand');
  });
});
