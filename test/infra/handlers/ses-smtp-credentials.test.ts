/**
 * Unit tests for the SES SMTP credentials custom-resource handler
 * (`src/infra/handlers/ses-smtp-credentials.ts`).
 *
 * The handler is driven through its injectable factory
 * ({@link createSesSmtpCredentialsHandler}) with fake IAM and SSM clients
 * ({@link createFakeAwsClient}), a fixed clock, and a real {@link Redactor}
 * feeding a capturing {@link Logger}. Events are built with
 * {@link makeCfnEvent}. No real AWS, no network, no real timers.
 *
 * Coverage follows the testing steering `infra/handlers/*` row for SES
 * credentials: Create (list empty -> create key -> store password + label +
 * username), the two-key limit (free the non-current slot, else a typed
 * {@link SesCredentialError}), Update with a new vs the same counter, Delete
 * (delete the encoded key, delete both parameters only when still named and no
 * other key remains, tolerate not-found), and secret hygiene: neither the IAM
 * secret access key nor the derived SMTP password ever appears in logs, the
 * response, the physical id, or a thrown error, and every response sets
 * `NoEcho: true`.
 */

import { describe, expect, it } from 'vitest';
import {
  CreateAccessKeyCommand,
  DeleteAccessKeyCommand,
  ListAccessKeysCommand,
  type IAMClient,
} from '@aws-sdk/client-iam';
import {
  DeleteParameterCommand,
  GetParameterCommand,
  LabelParameterVersionCommand,
  ParameterType,
  PutParameterCommand,
  type SSMClient,
} from '@aws-sdk/client-ssm';

import {
  createSesSmtpCredentialsHandler,
  type SesCredentialsEvent,
  type SesCredentialsResponse,
} from '../../../src/infra/handlers/ses-smtp-credentials.js';
import { SesCredentialError } from '../../../src/shared/errors.js';
import { deriveSesSmtpPassword } from '../../../src/infra/email/smtp-password.js';
import { names } from '../../../src/infra/naming.js';
import { Redactor, createLogger, type Logger } from '../../../src/shared/logger.js';
import { createFakeAwsClient, type FakeBehaviors } from '../../support/fake-aws.js';
import { makeCfnEvent } from '../../support/fake-cfn.js';

const ENV = 'community-prod';
const FORUM_ID = 'main';
const REGION = 'us-east-1';
const COUNTER = 0;

const USER_NAME = names.sesUser(ENV, FORUM_ID);
const USERNAME_PARAM = names.sesParameter(ENV, FORUM_ID, 'username');
const PASSWORD_PARAM = names.sesParameter(ENV, FORUM_ID, 'password');

/** A fixed clock; the handler reads it only for log context determinism. */
const NOW = new Date('2024-01-02T03:04:05.678Z');

/** An obvious placeholder IAM secret access key; never a realistic value. */
const SECRET_ACCESS_KEY = 'test-secret-value';
/** The non-secret access key id returned alongside it. */
const ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
/** The SMTP password derived from the placeholder secret for this region. */
const DERIVED_PASSWORD = deriveSesSmtpPassword(SECRET_ACCESS_KEY, REGION);

/** Plain, non-secret resource properties the custom resource carries. */
const RESOURCE_PROPERTIES = {
  environment: ENV,
  forumId: FORUM_ID,
  rotationCounter: String(COUNTER),
} as const;

/** Resource properties for an arbitrary rotation counter. */
function propertiesWithCounter(counter: number): Readonly<Record<string, unknown>> {
  return { environment: ENV, forumId: FORUM_ID, rotationCounter: String(counter) };
}

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

/** Build the handler over fake IAM/SSM clients and a captured logger. */
function build(behaviors: { readonly iam?: FakeBehaviors; readonly ssm?: FakeBehaviors }): {
  onEvent: (e: SesCredentialsEvent) => Promise<SesCredentialsResponse>;
  iam: ReturnType<typeof createFakeAwsClient>;
  ssm: ReturnType<typeof createFakeAwsClient>;
  log: CapturedLogger;
} {
  const iam = createFakeAwsClient(behaviors.iam ?? {});
  const ssm = createFakeAwsClient(behaviors.ssm ?? {});
  const log = captureLogger();
  const iamDep: Pick<IAMClient, 'send'> = iam;
  const ssmDep: Pick<SSMClient, 'send'> = ssm;
  const onEvent = createSesSmtpCredentialsHandler({
    iam: iamDep,
    ssm: ssmDep,
    region: REGION,
    now: () => NOW,
    logger: log.logger,
    redactor: log.redactor,
  });
  return { onEvent, iam, ssm, log };
}

/** IAM behaviors for a clean provision: no existing keys, one key created. */
function provisionIam(): FakeBehaviors {
  return {
    ListAccessKeysCommand: { AccessKeyMetadata: [] },
    CreateAccessKeyCommand: {
      AccessKey: { AccessKeyId: ACCESS_KEY_ID, SecretAccessKey: SECRET_ACCESS_KEY },
    },
  };
}

/** SSM behaviors for a clean provision: password put returns a version. */
function provisionSsm(): FakeBehaviors {
  return {
    PutParameterCommand: { Version: 1 },
    LabelParameterVersionCommand: {},
  };
}

/** A not-found SSM error used to simulate an absent parameter. */
function parameterNotFound(): Error {
  return sdkError('ParameterNotFound');
}

describe('createSesSmtpCredentialsHandler Create', () => {
  it('lists keys, creates one, stores the derived password, labels it, and stores the username', async () => {
    const { onEvent, iam, ssm } = build({ iam: provisionIam(), ssm: provisionSsm() });

    const res = await onEvent(makeCfnEvent({ ResourceProperties: RESOURCE_PROPERTIES }));

    // Physical id encodes counter and the non-secret access key id.
    expect(res.PhysicalResourceId).toBe(
      names.sesCredentialsPhysicalId(ENV, FORUM_ID, COUNTER, ACCESS_KEY_ID),
    );
    // Data carries only the non-secret access key id.
    expect(res.Data).toEqual({ AccessKeyId: ACCESS_KEY_ID });
    expect(res.NoEcho).toBe(true);

    // IAM: one list, one create, no deletes (slot was free).
    expect(iam.countFor('ListAccessKeysCommand')).toBe(1);
    expect(iam.countFor('CreateAccessKeyCommand')).toBe(1);
    expect(iam.countFor('DeleteAccessKeyCommand')).toBe(0);
    const [list] = iam.callsFor('ListAccessKeysCommand');
    expect((list?.input as { UserName: string }).UserName).toBe(USER_NAME);
    const [create] = iam.callsFor('CreateAccessKeyCommand');
    expect((create?.input as { UserName: string }).UserName).toBe(USER_NAME);

    // SSM: password (SecureString) stored with the derived value.
    const puts = ssm.callsFor('PutParameterCommand');
    expect(puts).toHaveLength(2);
    const passwordPut = puts.find((c) => (c.input as { Name: string }).Name === PASSWORD_PARAM);
    expect(passwordPut).toBeDefined();
    const passwordInput = passwordPut?.input as { Value: string; Type: string; Overwrite: boolean };
    expect(passwordInput.Type).toBe(ParameterType.SECURE_STRING);
    expect(passwordInput.Overwrite).toBe(true);
    expect(passwordInput.Value).toBe(DERIVED_PASSWORD);

    // The password version is labelled with the access key id.
    expect(ssm.countFor('LabelParameterVersionCommand')).toBe(1);
    const [label] = ssm.callsFor('LabelParameterVersionCommand');
    const labelInput = label?.input as {
      Name: string;
      ParameterVersion: number;
      Labels: string[];
    };
    expect(labelInput.Name).toBe(PASSWORD_PARAM);
    expect(labelInput.ParameterVersion).toBe(1);
    expect(labelInput.Labels).toEqual([ACCESS_KEY_ID]);

    // Username (plain String) stored as the access key id.
    const usernamePut = puts.find((c) => (c.input as { Name: string }).Name === USERNAME_PARAM);
    expect(usernamePut).toBeDefined();
    const usernameInput = usernamePut?.input as { Value: string; Type: string };
    expect(usernameInput.Type).toBe(ParameterType.STRING);
    expect(usernameInput.Value).toBe(ACCESS_KEY_ID);
  });
});

describe('two access key limit', () => {
  it('deletes the non-current key before creating when the user already has two', async () => {
    const otherKeyId = 'AKIAI44QH8DHBEXAMPLE';
    const { onEvent, iam } = build({
      iam: {
        ListAccessKeysCommand: {
          AccessKeyMetadata: [{ AccessKeyId: ACCESS_KEY_ID }, { AccessKeyId: otherKeyId }],
        },
        DeleteAccessKeyCommand: {},
        CreateAccessKeyCommand: {
          AccessKey: { AccessKeyId: 'AKIANEWKEYEXAMPLE', SecretAccessKey: SECRET_ACCESS_KEY },
        },
      },
      ssm: {
        // The current key named in ses-smtp-username is ACCESS_KEY_ID.
        GetParameterCommand: { Parameter: { Value: ACCESS_KEY_ID } },
        PutParameterCommand: { Version: 2 },
        LabelParameterVersionCommand: {},
      },
    });

    const res = await onEvent(makeCfnEvent({ ResourceProperties: RESOURCE_PROPERTIES }));

    // The non-current key (otherKeyId) is deleted; the current one is kept.
    expect(iam.countFor('DeleteAccessKeyCommand')).toBe(1);
    const [del] = iam.callsFor('DeleteAccessKeyCommand');
    expect((del?.input as { AccessKeyId: string }).AccessKeyId).toBe(otherKeyId);
    expect(iam.countFor('CreateAccessKeyCommand')).toBe(1);
    expect(res.NoEcho).toBe(true);
  });

  it('throws a typed SesCredentialError when no slot can be freed', async () => {
    // Both keys equal the id named in ses-smtp-username, so neither is
    // deletable: the handler cannot free a slot and must fail typed.
    const { onEvent, iam } = build({
      iam: {
        ListAccessKeysCommand: {
          AccessKeyMetadata: [{ AccessKeyId: ACCESS_KEY_ID }, { AccessKeyId: ACCESS_KEY_ID }],
        },
      },
      ssm: { GetParameterCommand: { Parameter: { Value: ACCESS_KEY_ID } } },
    });

    await expect(
      onEvent(makeCfnEvent({ ResourceProperties: RESOURCE_PROPERTIES })),
    ).rejects.toMatchObject({
      name: 'SesCredentialError',
      forumId: FORUM_ID,
      operation: 'ListAccessKeys',
      awsErrorName: 'TwoAccessKeyLimit',
    });
    // No create was attempted since no slot was freed.
    expect(iam.countFor('CreateAccessKeyCommand')).toBe(0);
  });
});

describe('Update rotation', () => {
  it('provisions a new key and returns a new physical id when the counter changes', async () => {
    const oldPhysicalId = names.sesCredentialsPhysicalId(ENV, FORUM_ID, 0, ACCESS_KEY_ID);
    const newKeyId = 'AKIANEWROTATEDKEY01';
    const { onEvent, iam, ssm } = build({
      iam: {
        ListAccessKeysCommand: { AccessKeyMetadata: [{ AccessKeyId: ACCESS_KEY_ID }] },
        CreateAccessKeyCommand: {
          AccessKey: { AccessKeyId: newKeyId, SecretAccessKey: SECRET_ACCESS_KEY },
        },
      },
      ssm: provisionSsm(),
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: oldPhysicalId,
        ResourceProperties: propertiesWithCounter(1),
      }),
    );

    expect(res.PhysicalResourceId).toBe(names.sesCredentialsPhysicalId(ENV, FORUM_ID, 1, newKeyId));
    expect(res.PhysicalResourceId).not.toBe(oldPhysicalId);
    expect(res.NoEcho).toBe(true);
    expect(iam.countFor('CreateAccessKeyCommand')).toBe(1);
    expect(ssm.countFor('PutParameterCommand')).toBe(2);
  });

  it('is a no-op that echoes the existing id when the counter is unchanged', async () => {
    const physicalId = names.sesCredentialsPhysicalId(ENV, FORUM_ID, 0, ACCESS_KEY_ID);
    const { onEvent, iam, ssm } = build({});

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Update',
        PhysicalResourceId: physicalId,
        ResourceProperties: propertiesWithCounter(0),
      }),
    );

    expect(res.PhysicalResourceId).toBe(physicalId);
    expect(res.NoEcho).toBe(true);
    // No IAM or SSM mutation at all.
    expect(iam.calls).toHaveLength(0);
    expect(ssm.calls).toHaveLength(0);
  });
});

describe('Delete', () => {
  it('deletes the key encoded in the physical id and both parameters when still named and alone', async () => {
    const physicalId = names.sesCredentialsPhysicalId(ENV, FORUM_ID, 0, ACCESS_KEY_ID);
    const { onEvent, iam, ssm } = build({
      iam: {
        DeleteAccessKeyCommand: {},
        // No remaining keys after the delete.
        ListAccessKeysCommand: { AccessKeyMetadata: [] },
      },
      ssm: {
        // ses-smtp-username still names the deleted key.
        GetParameterCommand: { Parameter: { Value: ACCESS_KEY_ID } },
        DeleteParameterCommand: {},
      },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Delete',
        PhysicalResourceId: physicalId,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    expect(res.PhysicalResourceId).toBe(physicalId);
    expect(res.NoEcho).toBe(true);

    expect(iam.countFor('DeleteAccessKeyCommand')).toBe(1);
    const [del] = iam.callsFor('DeleteAccessKeyCommand');
    expect((del?.input as { AccessKeyId: string }).AccessKeyId).toBe(ACCESS_KEY_ID);

    // Both parameters deleted.
    expect(ssm.countFor('DeleteParameterCommand')).toBe(2);
    const deletedNames = ssm
      .callsFor('DeleteParameterCommand')
      .map((c) => (c.input as { Name: string }).Name);
    expect(deletedNames).toContain(PASSWORD_PARAM);
    expect(deletedNames).toContain(USERNAME_PARAM);
  });

  it('leaves parameters alone when the username names a newer key', async () => {
    const physicalId = names.sesCredentialsPhysicalId(ENV, FORUM_ID, 0, ACCESS_KEY_ID);
    const { onEvent, iam, ssm } = build({
      iam: {
        DeleteAccessKeyCommand: {},
        ListAccessKeysCommand: { AccessKeyMetadata: [{ AccessKeyId: 'AKIANEWKEYEXAMPLE' }] },
      },
      ssm: {
        GetParameterCommand: { Parameter: { Value: 'AKIANEWKEYEXAMPLE' } },
      },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Delete',
        PhysicalResourceId: physicalId,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    expect(res.PhysicalResourceId).toBe(physicalId);
    expect(iam.countFor('DeleteAccessKeyCommand')).toBe(1);
    // Parameters belong to a newer key; none are deleted.
    expect(ssm.countFor('DeleteParameterCommand')).toBe(0);
  });

  it('tolerates NoSuchEntity on the key delete and ParameterNotFound on parameter deletes', async () => {
    const physicalId = names.sesCredentialsPhysicalId(ENV, FORUM_ID, 0, ACCESS_KEY_ID);
    const { onEvent, ssm } = build({
      iam: {
        DeleteAccessKeyCommand: sdkError('NoSuchEntity'),
        ListAccessKeysCommand: { AccessKeyMetadata: [] },
      },
      ssm: {
        GetParameterCommand: { Parameter: { Value: ACCESS_KEY_ID } },
        DeleteParameterCommand: parameterNotFound(),
      },
    });

    const res = await onEvent(
      makeCfnEvent({
        RequestType: 'Delete',
        PhysicalResourceId: physicalId,
        ResourceProperties: RESOURCE_PROPERTIES,
      }),
    );

    // Delete still succeeds despite the already-gone key and parameters.
    expect(res.PhysicalResourceId).toBe(physicalId);
    expect(res.NoEcho).toBe(true);
    expect(ssm.countFor('DeleteParameterCommand')).toBe(2);
  });
});

describe('secret hygiene', () => {
  /** Collect the stringified response and any thrown error for one invocation. */
  async function invoke(
    onEvent: (e: SesCredentialsEvent) => Promise<SesCredentialsResponse>,
    event: SesCredentialsEvent,
  ): Promise<{ response?: SesCredentialsResponse; error?: unknown }> {
    try {
      return { response: await onEvent(event) };
    } catch (error) {
      return { error };
    }
  }

  /** Assert neither the secret access key nor the derived password appears. */
  function assertNoSecrets(haystack: string): void {
    expect(haystack).not.toContain(SECRET_ACCESS_KEY);
    expect(haystack).not.toContain(DERIVED_PASSWORD);
  }

  it('never leaks the secret or derived password in logs, response, physical id or Data', async () => {
    const { onEvent, log } = build({ iam: provisionIam(), ssm: provisionSsm() });

    const { response } = await invoke(
      onEvent,
      makeCfnEvent({ ResourceProperties: RESOURCE_PROPERTIES }),
    );

    expect(response).toBeDefined();
    const res = response as SesCredentialsResponse;
    expect(res.NoEcho).toBe(true);

    const combinedLogs = log.lines.join('\n');
    assertNoSecrets(combinedLogs);
    assertNoSecrets(JSON.stringify(res));
    assertNoSecrets(res.PhysicalResourceId);
    assertNoSecrets(JSON.stringify(res.Data ?? {}));
  });

  it('never leaks the secret when provisioning fails after the key is created', async () => {
    const { onEvent, log } = build({
      iam: provisionIam(),
      ssm: {
        // PutParameter fails after the secret has been derived in memory.
        PutParameterCommand: sdkError('AccessDeniedException'),
      },
    });

    const { response, error } = await invoke(
      onEvent,
      makeCfnEvent({ ResourceProperties: RESOURCE_PROPERTIES }),
    );

    expect(response).toBeUndefined();
    expect(error).toBeInstanceOf(SesCredentialError);

    const combinedLogs = log.lines.join('\n');
    assertNoSecrets(combinedLogs);
    // The thrown error must not carry the secret or derived password either.
    const err = error as SesCredentialError;
    assertNoSecrets(err.message);
    assertNoSecrets(JSON.stringify({ ...err, message: err.message }));
    // And it carries only operation name and AWS error code.
    expect(err.operation).toBe('PutParameter');
    expect(err.awsErrorName).toBe('AccessDeniedException');
  });
});

// Keep the fake-routing command names in lockstep with the handler's imports.
describe('command name invariants', () => {
  it('uses the SDK command class names the fake routes on', () => {
    expect(ListAccessKeysCommand.name).toBe('ListAccessKeysCommand');
    expect(CreateAccessKeyCommand.name).toBe('CreateAccessKeyCommand');
    expect(DeleteAccessKeyCommand.name).toBe('DeleteAccessKeyCommand');
    expect(PutParameterCommand.name).toBe('PutParameterCommand');
    expect(LabelParameterVersionCommand.name).toBe('LabelParameterVersionCommand');
    expect(GetParameterCommand.name).toBe('GetParameterCommand');
    expect(DeleteParameterCommand.name).toBe('DeleteParameterCommand');
  });
});
