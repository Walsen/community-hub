/**
 * Compile-time and runtime checks that the fake AWS client is assignable to
 * the `Pick<Client, 'send'>` shape the handlers inject, for each of the four
 * SDK clients, and that routing, call recording and queued responses behave.
 */

import { describe, expect, it } from 'vitest';
import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { GetSecretValueCommand, type SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import {
  CreateInstanceSnapshotCommand,
  GetInstanceSnapshotCommand,
  type LightsailClient,
} from '@aws-sdk/client-lightsail';
import { CreateAccessKeyCommand, type IAMClient } from '@aws-sdk/client-iam';

import { createFakeAwsClient, queueResponses } from './fake-aws.js';

describe('createFakeAwsClient assignability', () => {
  it('is assignable to Pick<Client, "send"> for each SDK client', () => {
    const fake = createFakeAwsClient({
      GetParameterCommand: { Parameter: { Value: 'test-secret-value' } },
      GetSecretValueCommand: { SecretString: 'test-secret-value' },
      CreateInstanceSnapshotCommand: {},
      CreateAccessKeyCommand: {},
    });

    const ssm: Pick<SSMClient, 'send'> = fake;
    const sm: Pick<SecretsManagerClient, 'send'> = fake;
    const lightsail: Pick<LightsailClient, 'send'> = fake;
    const iam: Pick<IAMClient, 'send'> = fake;

    expect(ssm).toBeDefined();
    expect(sm).toBeDefined();
    expect(lightsail).toBeDefined();
    expect(iam).toBeDefined();
  });

  it('returns the configured response narrowed to the command output type', async () => {
    const fake = createFakeAwsClient({
      GetParameterCommand: { Parameter: { Value: 'test-secret-value' } },
    });
    const client: Pick<SSMClient, 'send'> = fake;

    const out = await client.send(new GetParameterCommand({ Name: '/x', WithDecryption: true }));

    expect(out.Parameter?.Value).toBe('test-secret-value');
  });

  it('throws naming the command when no behavior is configured', async () => {
    const fake = createFakeAwsClient();
    const client: Pick<SecretsManagerClient, 'send'> = fake;

    await expect(client.send(new GetSecretValueCommand({ SecretId: 's' }))).rejects.toThrow(
      /GetSecretValueCommand/,
    );
  });

  it('rejects when a behavior yields an Error', async () => {
    const limit = new Error('LimitExceededException');
    const fake = createFakeAwsClient({ CreateAccessKeyCommand: limit });
    const client: Pick<IAMClient, 'send'> = fake;

    await expect(client.send(new CreateAccessKeyCommand({ UserName: 'u' }))).rejects.toBe(limit);
  });

  it('records calls with command name and input and filters them', async () => {
    const fake = createFakeAwsClient({
      GetParameterCommand: {},
      GetSecretValueCommand: {},
    });

    await fake.send(new GetParameterCommand({ Name: '/a', WithDecryption: true }));
    await fake.send(new GetSecretValueCommand({ SecretId: 'b' }));
    await fake.send(new GetParameterCommand({ Name: '/c', WithDecryption: true }));

    expect(fake.calls).toHaveLength(3);
    expect(fake.countFor('GetParameterCommand')).toBe(2);
    const paramCalls = fake.callsFor('GetParameterCommand');
    expect(paramCalls.map((c) => (c.input as { Name: string }).Name)).toEqual(['/a', '/c']);
  });

  it('drives a polling sequence with a function behavior and queueResponses', async () => {
    const fake = createFakeAwsClient({
      CreateInstanceSnapshotCommand: {},
      GetInstanceSnapshotCommand: queueResponses([
        { instanceSnapshot: { state: 'pending' } },
        { instanceSnapshot: { state: 'available' } },
      ]),
    });
    const client: Pick<LightsailClient, 'send'> = fake;

    await client.send(
      new CreateInstanceSnapshotCommand({ instanceSnapshotName: 's', instanceName: 'i' }),
    );
    const first = await client.send(new GetInstanceSnapshotCommand({ instanceSnapshotName: 's' }));
    const second = await client.send(new GetInstanceSnapshotCommand({ instanceSnapshotName: 's' }));
    const third = await client.send(new GetInstanceSnapshotCommand({ instanceSnapshotName: 's' }));

    expect(first.instanceSnapshot?.state).toBe('pending');
    expect(second.instanceSnapshot?.state).toBe('available');
    // Exhausted queue repeats the last response so an extra poll still terminates.
    expect(third.instanceSnapshot?.state).toBe('available');
  });
});
