/**
 * Property-based tests for the SES SMTP credentials custom-resource handler
 * (`src/infra/handlers/ses-smtp-credentials.ts`).
 *
 * Property 25: Credential lifecycle invariants.
 * **Validates: Requirements 11.8, 11.15, 11.16, 11.17**
 *
 * These tests drive the injectable handler ({@link createSesSmtpCredentialsHandler})
 * against a tiny in-memory model of the forum SES user's IAM access keys and the
 * two SSM parameters (`ses-smtp-username`, `ses-smtp-password`). The fake AWS
 * clients ({@link createFakeAwsClient}) read and mutate that model so a generated
 * sequence of Create/Update/Delete events exercises the real control flow with no
 * AWS, no network and no real timers. Across arbitrary forum ids, environment
 * names, rotation counters and generated secrets the tests assert:
 *
 * 1. the user never holds more than two access keys (IAM's hard limit, Req 11.9);
 * 2. every response sets `NoEcho: true` (Req 11.16);
 * 3. neither the generated IAM secret access key nor its derived SMTP password
 *    ever appears in a log line, the response, the physical id or a thrown error
 *    (Req 11.8, 11.15, 11.17);
 * 4. an Update with a higher counter returns a new physical id (rotation);
 * 5. an Update with the same counter performs zero IAM/SSM mutations and echoes
 *    the prior id.
 *
 * Fast-check runs use a fixed seed so any counterexample is reproducible.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { type IAMClient } from '@aws-sdk/client-iam';
import { type SSMClient } from '@aws-sdk/client-ssm';

import {
  createSesSmtpCredentialsHandler,
  type SesCredentialsEvent,
  type SesCredentialsResponse,
} from '../../../src/infra/handlers/ses-smtp-credentials.js';
import { deriveSesSmtpPassword } from '../../../src/infra/email/smtp-password.js';
import { names } from '../../../src/infra/naming.js';
import { Redactor, createLogger, type Logger } from '../../../src/shared/logger.js';
import { createFakeAwsClient, type FakeAwsClient } from '../../support/fake-aws.js';
import { makeCfnEvent } from '../../support/fake-cfn.js';

/** Fixed region used for every run so derived passwords are stable. */
const REGION = 'us-east-1';
/** Fixed clock; the handler reads it only for log context determinism. */
const NOW = new Date('2024-01-02T03:04:05.678Z');
/** Fast-check configuration: fixed seed so any counterexample reproduces. */
const FC_CONFIG = { numRuns: 50, seed: 0x5eed } as const;

/**
 * The tiny in-memory model the fake IAM/SSM clients share: the forum SES user's
 * access key ids and the two SSM parameter values. Nothing here is a real AWS
 * resource; the fakes read and mutate it synchronously.
 */
interface Model {
  /** IAM access key ids currently on the SES user, in creation order. */
  keys: string[];
  /** The two SSM parameters the handler manages. */
  params: { username?: string; password?: string };
}

/** A capturing log sink plus the lines it collected and its redactor. */
interface CapturedLogger {
  readonly logger: Logger;
  readonly redactor: Redactor;
  readonly lines: string[];
}

/** Build a logger that records every serialized line for inspection. */
function captureLogger(): CapturedLogger {
  const lines: string[] = [];
  const redactor = new Redactor();
  const logger = createLogger({ sink: { write: (line) => lines.push(line) }, redactor });
  return { logger, redactor, lines };
}

/** An SDK-style error carrying only a `name`; its message must never surface. */
function sdkError(name: string): Error {
  return Object.assign(new Error('sdk body that must never be logged'), { name });
}

/** Read the `Name` off a recorded SSM command input without using `any`. */
function nameOf(input: unknown): string {
  return (input as { Name?: unknown }).Name as string;
}

/** Read the `AccessKeyId` off a recorded IAM command input without using `any`. */
function accessKeyIdOf(input: unknown): string | undefined {
  const value = (input as { AccessKeyId?: unknown }).AccessKeyId;
  return typeof value === 'string' ? value : undefined;
}

/**
 * The wired handler plus its model, fake clients and captured logger. The model
 * is shared by reference with the fakes so assertions can inspect it after each
 * event.
 */
interface Harness {
  readonly onEvent: (e: SesCredentialsEvent) => Promise<SesCredentialsResponse>;
  readonly model: Model;
  readonly iam: FakeAwsClient;
  readonly ssm: FakeAwsClient;
  readonly log: CapturedLogger;
  /** The fake IAM secret returned for every CreateAccessKey in this harness. */
  readonly secretAccessKey: string;
  /** The SMTP password derived from {@link secretAccessKey} for {@link REGION}. */
  readonly derivedPassword: string;
}

/**
 * Build a handler over fake IAM/SSM clients whose behaviors read and mutate a
 * fresh in-memory {@link Model}. A monotonically increasing counter generates
 * fresh, obviously-fake access key ids so repeated Creates never collide.
 *
 * @param secretAccessKey - the fake secret every CreateAccessKey returns; the
 *   handler derives its SMTP password from it, so both are the leak targets.
 */
function buildHarness(secretAccessKey: string): Harness {
  const model: Model = { keys: [], params: {} };
  const log = captureLogger();
  let keySeq = 0;

  const iam = createFakeAwsClient({
    ListAccessKeysCommand: () => ({
      AccessKeyMetadata: model.keys.map((id) => ({ AccessKeyId: id })),
    }),
    CreateAccessKeyCommand: () => {
      keySeq += 1;
      const accessKeyId = `AKIAFAKEKEY${String(keySeq).padStart(9, '0')}`;
      model.keys.push(accessKeyId);
      return { AccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: secretAccessKey } };
    },
    DeleteAccessKeyCommand: (input: unknown) => {
      const id = accessKeyIdOf(input);
      model.keys = model.keys.filter((key) => key !== id);
      return {};
    },
  });

  const ssm = createFakeAwsClient({
    PutParameterCommand: (input: unknown) => {
      const name = nameOf(input);
      const value = (input as { Value?: unknown }).Value as string;
      if (name.endsWith('/ses-smtp-username')) {
        model.params.username = value;
      } else if (name.endsWith('/ses-smtp-password')) {
        model.params.password = value;
      }
      return { Version: 1 };
    },
    LabelParameterVersionCommand: () => ({}),
    GetParameterCommand: (input: unknown) => {
      const name = nameOf(input);
      const value = name.endsWith('/ses-smtp-username')
        ? model.params.username
        : model.params.password;
      if (value === undefined) {
        return sdkError('ParameterNotFound');
      }
      return { Parameter: { Value: value } };
    },
    DeleteParameterCommand: (input: unknown) => {
      const name = nameOf(input);
      if (name.endsWith('/ses-smtp-username')) {
        delete model.params.username;
      } else if (name.endsWith('/ses-smtp-password')) {
        delete model.params.password;
      }
      return {};
    },
  });

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

  return {
    onEvent,
    model,
    iam,
    ssm,
    log,
    secretAccessKey,
    derivedPassword: deriveSesSmtpPassword(secretAccessKey, REGION),
  };
}

/** Resource properties the custom resource carries (all non-secret strings). */
function props(
  environment: string,
  forumId: string,
  counter: number,
): Readonly<Record<string, unknown>> {
  return { environment, forumId, rotationCounter: String(counter) };
}

// --- Generators ------------------------------------------------------------

/** A valid forum id: `^[a-z][a-z0-9]{0,19}$` (hyphen-free). */
const forumIdArb = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 0,
      maxLength: 19,
    }),
  )
  .map(([first, rest]) => first + rest.join(''));

/** A simple, valid environment name. */
const environmentArb = fc.constantFrom('community-prod', 'dev-env', 'e1');

/** A non-negative rotation counter within a small range. */
const counterArb = fc.nat({ max: 5 });

/** An obviously-fake IAM secret access key; never a realistic value. */
const secretArb = fc
  .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 8, maxLength: 16 })
  .map((chars) => `fake-${chars.join('')}`);

/** Collect the response and any thrown error for one invocation. */
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

/** Every surface a secret could leak into, joined into one scannable string. */
function leakSurface(
  log: CapturedLogger,
  result: { response?: SesCredentialsResponse; error?: unknown },
): string {
  const parts: string[] = [log.lines.join('\n')];
  if (result.response !== undefined) {
    parts.push(JSON.stringify(result.response));
    parts.push(result.response.PhysicalResourceId);
  }
  if (result.error !== undefined) {
    const error = result.error;
    if (error instanceof Error) {
      parts.push(error.message);
      parts.push(error.stack ?? '');
      parts.push(JSON.stringify({ ...error, message: error.message }));
    } else {
      parts.push(JSON.stringify(error));
    }
  }
  return parts.join('\n');
}

describe('Property 25: credential lifecycle invariants', () => {
  it('holds no more than two access keys through a Create/Update/Update/Delete sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        environmentArb,
        forumIdArb,
        counterArb,
        secretArb,
        async (environment, forumId, counter, secret) => {
          const h = buildHarness(secret);

          // Create.
          await invoke(
            h.onEvent,
            makeCfnEvent({ ResourceProperties: props(environment, forumId, counter) }),
          );
          expect(h.model.keys.length).toBeLessThanOrEqual(2);

          // Rotate (higher counter): physical id built from the created key.
          const createdId = h.model.keys[0];
          const oldPhysicalId =
            createdId === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(environment, forumId, counter, createdId);
          await invoke(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Update',
              ...(oldPhysicalId !== undefined ? { PhysicalResourceId: oldPhysicalId } : {}),
              ResourceProperties: props(environment, forumId, counter + 1),
            }),
          );
          expect(h.model.keys.length).toBeLessThanOrEqual(2);

          // Rotate again.
          const rotatedKey = h.model.keys[h.model.keys.length - 1];
          const rotatedId =
            rotatedKey === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(environment, forumId, counter + 1, rotatedKey);
          await invoke(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Update',
              ...(rotatedId !== undefined ? { PhysicalResourceId: rotatedId } : {}),
              ResourceProperties: props(environment, forumId, counter + 2),
            }),
          );
          expect(h.model.keys.length).toBeLessThanOrEqual(2);
        },
      ),
      FC_CONFIG,
    );
  });

  it('sets NoEcho: true on every response across Create, Update and Delete', async () => {
    await fc.assert(
      fc.asyncProperty(
        environmentArb,
        forumIdArb,
        counterArb,
        secretArb,
        async (environment, forumId, counter, secret) => {
          const h = buildHarness(secret);

          const create = await invoke(
            h.onEvent,
            makeCfnEvent({ ResourceProperties: props(environment, forumId, counter) }),
          );
          expect(create.response?.NoEcho).toBe(true);

          const createdId = h.model.keys[0];
          const physicalId =
            createdId === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(environment, forumId, counter, createdId);

          const update = await invoke(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Update',
              ...(physicalId !== undefined ? { PhysicalResourceId: physicalId } : {}),
              ResourceProperties: props(environment, forumId, counter + 1),
            }),
          );
          expect(update.response?.NoEcho).toBe(true);

          const rotatedKey = h.model.keys[h.model.keys.length - 1];
          const rotatedId =
            rotatedKey === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(environment, forumId, counter + 1, rotatedKey);
          const del = await invoke(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Delete',
              ...(rotatedId !== undefined ? { PhysicalResourceId: rotatedId } : {}),
              ResourceProperties: props(environment, forumId, counter + 1),
            }),
          );
          expect(del.response?.NoEcho).toBe(true);
        },
      ),
      FC_CONFIG,
    );
  });

  it('never leaks the secret or derived password in logs, response, id or errors', async () => {
    await fc.assert(
      fc.asyncProperty(
        environmentArb,
        forumIdArb,
        counterArb,
        secretArb,
        async (environment, forumId, counter, secret) => {
          const h = buildHarness(secret);

          // Create, rotate, and delete; scan the cumulative leak surface after each.
          const create = await invoke(
            h.onEvent,
            makeCfnEvent({ ResourceProperties: props(environment, forumId, counter) }),
          );
          let surface = leakSurface(h.log, create);
          expect(surface).not.toContain(h.secretAccessKey);
          expect(surface).not.toContain(h.derivedPassword);

          const createdId = h.model.keys[0];
          const physicalId =
            createdId === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(environment, forumId, counter, createdId);
          const update = await invoke(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Update',
              ...(physicalId !== undefined ? { PhysicalResourceId: physicalId } : {}),
              ResourceProperties: props(environment, forumId, counter + 1),
            }),
          );
          surface = leakSurface(h.log, update);
          expect(surface).not.toContain(h.secretAccessKey);
          expect(surface).not.toContain(h.derivedPassword);

          const rotatedKey = h.model.keys[h.model.keys.length - 1];
          const rotatedId =
            rotatedKey === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(environment, forumId, counter + 1, rotatedKey);
          const del = await invoke(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Delete',
              ...(rotatedId !== undefined ? { PhysicalResourceId: rotatedId } : {}),
              ResourceProperties: props(environment, forumId, counter + 1),
            }),
          );
          surface = leakSurface(h.log, del);
          expect(surface).not.toContain(h.secretAccessKey);
          expect(surface).not.toContain(h.derivedPassword);
        },
      ),
      FC_CONFIG,
    );
  });

  it('returns a new physical id when an Update raises the rotation counter', async () => {
    await fc.assert(
      fc.asyncProperty(
        environmentArb,
        forumIdArb,
        counterArb,
        secretArb,
        async (environment, forumId, counter, secret) => {
          const h = buildHarness(secret);

          const create = await invoke(
            h.onEvent,
            makeCfnEvent({ ResourceProperties: props(environment, forumId, counter) }),
          );
          const oldId = create.response?.PhysicalResourceId;
          expect(oldId).toBeDefined();

          const update = await invoke(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Update',
              ...(oldId !== undefined ? { PhysicalResourceId: oldId } : {}),
              ResourceProperties: props(environment, forumId, counter + 1),
            }),
          );
          expect(update.response?.PhysicalResourceId).toBeDefined();
          expect(update.response?.PhysicalResourceId).not.toBe(oldId);
        },
      ),
      FC_CONFIG,
    );
  });

  it('makes zero mutations and echoes the prior id when the counter is unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(
        environmentArb,
        forumIdArb,
        counterArb,
        secretArb,
        async (environment, forumId, counter, secret) => {
          const h = buildHarness(secret);

          const create = await invoke(
            h.onEvent,
            makeCfnEvent({ ResourceProperties: props(environment, forumId, counter) }),
          );
          const physicalId = create.response?.PhysicalResourceId;
          expect(physicalId).toBeDefined();

          // Reset call logs by building a fresh harness pointed at the same id,
          // so the no-op's call counts are measured in isolation.
          const noop = buildHarness(secret);
          const res = await invoke(
            noop.onEvent,
            makeCfnEvent({
              RequestType: 'Update',
              ...(physicalId !== undefined ? { PhysicalResourceId: physicalId } : {}),
              ResourceProperties: props(environment, forumId, counter),
            }),
          );

          expect(res.response?.PhysicalResourceId).toBe(physicalId);
          expect(res.response?.NoEcho).toBe(true);
          // No IAM or SSM mutation at all.
          expect(noop.iam.calls).toHaveLength(0);
          expect(noop.ssm.calls).toHaveLength(0);
        },
      ),
      FC_CONFIG,
    );
  });
});
