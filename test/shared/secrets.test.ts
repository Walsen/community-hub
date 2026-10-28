import { describe, expect, it } from 'vitest';

import { formatSecretReference, type SecretReference } from '../../src/metadata/secret-ref.js';
import { SecretResolutionError } from '../../src/shared/errors.js';
import { REDACTED, Redactor } from '../../src/shared/logger.js';
import { createAwsSecretResolver } from '../../src/shared/secrets.js';
import { createFakeAwsClient, type FakeBehaviors } from '../support/fake-aws.js';

/** Obvious placeholder; never a realistic secret, per test ground rules. */
const SECRET = 'test-secret-value';

/** An `ssm:` reference under the per-forum secret path. */
function ssmRef(id = '/community-hub/env/forum/api-key'): SecretReference {
  return { store: 'ssm', id };
}

/** A `secretsmanager:` reference under the per-forum secret path. */
function smRef(id = '/community-hub/env/forum/admin-password'): SecretReference {
  return { store: 'secretsmanager', id };
}

/**
 * Build a resolver over fake SSM and Secrets Manager clients and a real
 * {@link Redactor}, returning all three so a test can assert on request shape,
 * call counts and redaction.
 */
function harness(deps: { ssm?: FakeBehaviors; sm?: FakeBehaviors } = {}) {
  const ssm = createFakeAwsClient(deps.ssm ?? {});
  const secretsManager = createFakeAwsClient(deps.sm ?? {});
  const redactor = new Redactor();
  const resolve = createAwsSecretResolver({ ssm, secretsManager, redactor });
  return { ssm, secretsManager, redactor, resolve };
}

describe('createAwsSecretResolver ssm references', () => {
  it('reads with GetParameter and WithDecryption and returns the decrypted value', async () => {
    const { ssm, resolve } = harness({
      ssm: { GetParameterCommand: { Parameter: { Value: SECRET } } },
    });

    const value = await resolve(ssmRef());

    expect(value).toBe(SECRET);
    expect(ssm.countFor('GetParameterCommand')).toBe(1);
    expect(ssm.callsFor('GetParameterCommand')[0]?.input).toEqual({
      Name: '/community-hub/env/forum/api-key',
      WithDecryption: true,
    });
  });

  it('registers the resolved value with the redactor before returning', async () => {
    const { redactor, resolve } = harness({
      ssm: { GetParameterCommand: { Parameter: { Value: SECRET } } },
    });

    // Not yet registered: the value passes through untouched.
    expect(redactor.redact(`uses ${SECRET}`)).toBe(`uses ${SECRET}`);

    await resolve(ssmRef());

    // After resolution the value is masked everywhere it appears.
    expect(redactor.redact(`uses ${SECRET}`)).toBe(`uses ${REDACTED}`);
  });
});

describe('createAwsSecretResolver secretsmanager references', () => {
  it('reads with GetSecretValue and returns the SecretString', async () => {
    const { secretsManager, resolve } = harness({
      sm: { GetSecretValueCommand: { SecretString: SECRET } },
    });

    const value = await resolve(smRef());

    expect(value).toBe(SECRET);
    expect(secretsManager.countFor('GetSecretValueCommand')).toBe(1);
    expect(secretsManager.callsFor('GetSecretValueCommand')[0]?.input).toEqual({
      SecretId: '/community-hub/env/forum/admin-password',
    });
  });
});

describe('createAwsSecretResolver caching', () => {
  it('resolves the same reference twice with a single underlying send', async () => {
    const { ssm, resolve } = harness({
      ssm: { GetParameterCommand: { Parameter: { Value: SECRET } } },
    });

    const first = await resolve(ssmRef());
    const second = await resolve(ssmRef());

    expect(first).toBe(SECRET);
    expect(second).toBe(SECRET);
    expect(ssm.countFor('GetParameterCommand')).toBe(1);
  });

  it('shares one in-flight read across concurrent callers', async () => {
    const { ssm, resolve } = harness({
      ssm: { GetParameterCommand: { Parameter: { Value: SECRET } } },
    });

    const results = await Promise.all([resolve(ssmRef()), resolve(ssmRef()), resolve(ssmRef())]);

    expect(results).toEqual([SECRET, SECRET, SECRET]);
    expect(ssm.countFor('GetParameterCommand')).toBe(1);
  });
});

describe('createAwsSecretResolver retry after failure', () => {
  it('evicts a rejected resolution so a later call issues a new send and can succeed', async () => {
    let attempt = 0;
    const { ssm, resolve } = harness({
      ssm: {
        GetParameterCommand: (): unknown => {
          attempt += 1;
          if (attempt === 1) {
            return Object.assign(new Error('transient'), { name: 'InternalServerError' });
          }
          return { Parameter: { Value: SECRET } };
        },
      },
    });

    await expect(resolve(ssmRef())).rejects.toBeInstanceOf(SecretResolutionError);
    const value = await resolve(ssmRef());

    expect(value).toBe(SECRET);
    expect(ssm.countFor('GetParameterCommand')).toBe(2);
  });
});

describe('createAwsSecretResolver error mapping', () => {
  it('maps ParameterNotFound to not_found', async () => {
    const { resolve } = harness({
      ssm: {
        GetParameterCommand: Object.assign(new Error('nope'), { name: 'ParameterNotFound' }),
      },
    });

    await expect(resolve(ssmRef())).rejects.toMatchObject({
      name: 'SecretResolutionError',
      reason: 'not_found',
      reference: formatSecretReference(ssmRef()),
    });
  });

  it('maps ResourceNotFoundException to not_found', async () => {
    const { resolve } = harness({
      sm: {
        GetSecretValueCommand: Object.assign(new Error('nope'), {
          name: 'ResourceNotFoundException',
        }),
      },
    });

    await expect(resolve(smRef())).rejects.toMatchObject({
      name: 'SecretResolutionError',
      reason: 'not_found',
    });
  });

  it('maps AccessDeniedException to access_denied', async () => {
    const { resolve } = harness({
      ssm: {
        GetParameterCommand: Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
      },
    });

    await expect(resolve(ssmRef())).rejects.toMatchObject({
      name: 'SecretResolutionError',
      reason: 'access_denied',
    });
  });

  it('maps a missing parameter value to empty', async () => {
    const { resolve } = harness({
      ssm: { GetParameterCommand: { Parameter: {} } },
    });

    await expect(resolve(ssmRef())).rejects.toMatchObject({
      name: 'SecretResolutionError',
      reason: 'empty',
    });
  });

  it('maps an empty SecretString to empty', async () => {
    const { resolve } = harness({
      sm: { GetSecretValueCommand: { SecretString: '' } },
    });

    await expect(resolve(smRef())).rejects.toMatchObject({
      name: 'SecretResolutionError',
      reason: 'empty',
    });
  });

  it('maps any other error to unknown', async () => {
    const { resolve } = harness({
      ssm: {
        GetParameterCommand: Object.assign(new Error('boom'), { name: 'ThrottlingException' }),
      },
    });

    await expect(resolve(ssmRef())).rejects.toMatchObject({
      name: 'SecretResolutionError',
      reason: 'unknown',
    });
  });

  it('carries the formatted reference name on the thrown error', async () => {
    const { resolve } = harness({
      sm: {
        GetSecretValueCommand: Object.assign(new Error('nope'), {
          name: 'ResourceNotFoundException',
        }),
      },
    });

    const error = await resolve(smRef()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretResolutionError);
    expect((error as SecretResolutionError).reference).toBe(formatSecretReference(smRef()));
  });
});

describe('createAwsSecretResolver secret hygiene', () => {
  it('never places the attempted value on the error when resolution fails', async () => {
    // The underlying error message carries the attempted value; the resolver
    // must not let it reach the SecretResolutionError in any form.
    const { resolve } = harness({
      ssm: {
        GetParameterCommand: Object.assign(new Error(`value was ${SECRET}`), {
          name: 'ThrottlingException',
        }),
      },
    });

    const error = await resolve(ssmRef()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretResolutionError);
    const serialized = `${(error as Error).message} ${(error as SecretResolutionError).reference}`;
    expect(serialized).not.toContain(SECRET);
  });

  it('keeps the value out of the empty-reason error even when a value was present upstream', async () => {
    const { resolve } = harness({
      sm: { GetSecretValueCommand: { SecretString: '' } },
    });

    const error = await resolve(smRef()).catch((e: unknown) => e);
    expect((error as Error).message).not.toContain(SECRET);
    expect((error as SecretResolutionError).reference).not.toContain(SECRET);
  });
});
