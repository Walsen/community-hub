/**
 * Comprehensive secret-hygiene property test.
 *
 * Property 17: Secret hygiene (Core 5).
 * **Validates: Requirements 2.5, 11.9**
 *
 * The single core guarantee this file asserts, across every surface a secret
 * could escape through: for any metadata whose secret fields carry *generated*,
 * obviously-fake values (every generated value here is prefixed `fake-secret-`),
 * no resolved secret value appears anywhere an operator, CloudFormation or a log
 * reader could read it. The one and only exception the design permits is the
 * bootstrap broker's HTTP 200 response body, which hands the single-use SSM
 * activation code to the claiming instance exactly once; the activation code
 * must appear nowhere else.
 *
 * The property is threaded through four surfaces, each a small sub-property run
 * under the fixed seed `0x5eed` so any counterexample reproduces. Breadth of
 * surfaces is favoured over a high run count (the testing steering: "Prefer
 * breadth of surfaces over high numRuns").
 *
 * 1. **Stack synthesis** (templates, outputs, tags, resolved user data).
 *    A validated model only ever holds `ssm:`/`secretsmanager:` Secret_References,
 *    never values — the loader rejects inline secrets. So the fake secret values
 *    are generated, placed in the Secret_Store the references *point at* (never
 *    in the YAML), and then the synthesized + normalized template, its outputs,
 *    its tags and the fully resolved Lightsail user data are scanned: the values
 *    must be absent because nothing resolves them at synth. User data may carry
 *    only the references themselves.
 *
 * 2. **SES SMTP credentials handler.** A generated IAM secret access key and the
 *    SMTP password derived from it never reach a log line, the response, the
 *    physical id or a thrown error; every response sets `NoEcho`.
 *
 * 3. **Bootstrap broker handler.** A generated activation code appears in the
 *    200 response body only — never in captured logs or any error/other response.
 *
 * 4. **Seed CLI** (`runSeed`, dry-run and real). Generated admin passwords, API
 *    keys and user passwords, resolved by a fake resolver, never appear in the
 *    printed report or the captured logs, in either mode.
 *
 * Everything runs offline: no AWS credentials, no network, no real timers. The
 * fakes are the shared harnesses (`fake-aws`, `fake-forum`, `fake-cfn`) reused
 * from the per-area hygiene tests.
 */

import { App, Stack, ContextProvider } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as cxschema from 'aws-cdk-lib/cloud-assembly-schema';
import { type IAMClient } from '@aws-sdk/client-iam';
import { type SSMClient } from '@aws-sdk/client-ssm';
import { type LightsailClient } from '@aws-sdk/client-lightsail';
import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createDefaultRegistry, EngineRegistry } from '../src/engines/registry.js';
import type { SeedClient, SeedClientDeps } from '../src/engines/engine-adapter.js';
import { loadMetadata } from '../src/metadata/loader.js';
import type { ValidatedModel } from '../src/metadata/schema.js';
import { type SecretReference } from '../src/metadata/secret-ref.js';
import { EnvironmentStack } from '../src/infra/environment-stack.js';
import {
  createSesSmtpCredentialsHandler,
  type SesCredentialsEvent,
  type SesCredentialsResponse,
} from '../src/infra/handlers/ses-smtp-credentials.js';
import {
  createBrokerHandler,
  type BrokerEvent,
  type BrokerResponse,
  type ForumsConfig,
} from '../src/infra/handlers/bootstrap-broker.js';
import { deriveSesSmtpPassword } from '../src/infra/email/smtp-password.js';
import { names } from '../src/infra/naming.js';
import { runSeed } from '../src/seeder/run.js';
import type { HttpClient } from '../src/shared/http.js';
import { Redactor, createLogger, type Logger } from '../src/shared/logger.js';
import type { SecretResolver } from '../src/shared/secrets.js';

import { createFakeAwsClient } from './support/fake-aws.js';
import { createFakeForum } from './support/fake-forum.js';
import { makeCfnEvent } from './support/fake-cfn.js';
import { createTestEngine } from './support/testengine.js';

/** Fast-check configuration: fixed seed so any counterexample reproduces. */
const FC_CONFIG = { numRuns: 25, seed: 0x5eed } as const;

/** Fixed synthesis environment so account/region tokens never vary. */
const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const ROOT_DOMAIN = 'example.org';

/**
 * Marker prefix every generated secret value carries. Scanning for this prefix
 * (in addition to each exact value) catches a leak even if a surface truncates
 * or re-encodes the value, so the assertions are conservative.
 */
const FAKE_PREFIX = 'fake-secret-';

// --- Shared helpers --------------------------------------------------------

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

/** Assert none of the generated secret values (nor the marker prefix) occur in `surface`. */
function assertNoSecrets(surface: string, secrets: readonly string[]): void {
  expect(surface).not.toContain(FAKE_PREFIX);
  for (const secret of secrets) {
    expect(surface).not.toContain(secret);
  }
}

// --- Generators ------------------------------------------------------------

/** A valid forum id: `^[a-z][a-z0-9]{0,19}$` (hyphen-free). */
const forumIdArb = fc
  .tuple(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
    fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')), {
      minLength: 0,
      maxLength: 10,
    }),
  )
  .map(([first, rest]) => first + rest.join(''));

/** A simple valid environment name (`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`). */
const environmentArb = fc.constantFrom('community-prod', 'dev-env', 'e1-test');

/** A non-negative rotation counter within a small range. */
const counterArb = fc.nat({ max: 5 });

/**
 * An obviously-fake secret value, always prefixed `fake-secret-`. Never a
 * realistic credential; the suffix is short alphanumerics so it reads as a
 * placeholder in any failure output.
 */
const secretValueArb = fc
  .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 8, maxLength: 16 })
  .map((chars) => `${FAKE_PREFIX}${chars.join('')}`);

// --- Surface 1: stack synthesis --------------------------------------------

type DnsMode = 'route53' | 'route53-existing' | 'external';

/** The declared hosted zone id used for `route53-existing`. */
const DECLARED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

/**
 * A two-forum (Discourse + Flarum) metadata document serialized to YAML, using
 * only `ssm:` Secret_References with placeholder paths. The secret *values* live
 * in the Secret_Store the references point at, never in this document.
 */
function metadataYaml(env: string, dnsMode: DnsMode): string {
  const doc: Record<string, unknown> = {
    version: 1,
    environment: {
      name: env,
      region: REGION,
      availabilityZone: `${REGION}a`,
      dnsMode,
      rootDomain: ROOT_DOMAIN,
      adminEmail: 'ops@example.org',
      sshAllowedCidrs: ['203.0.113.0/24'],
      ...(dnsMode === 'route53-existing' ? { hostedZoneId: DECLARED_ZONE_ID } : {}),
    },
    forums: [
      {
        id: 'main',
        engine: 'discourse',
        subdomain: 'forum',
        bundleId: 'medium_3_0',
        senderAddress: 'noreply',
        secrets: {
          adminPassword: `ssm:/community-hub/${env}/main/admin-password`,
          apiKey: `ssm:/community-hub/${env}/main/api-key`,
        },
        engineOptions: {},
      },
      {
        id: 'dev',
        engine: 'flarum',
        subdomain: 'dev',
        bundleId: 'small_3_0',
        senderAddress: 'dev-forum@example.org',
        secrets: {
          adminPassword: `ssm:/community-hub/${env}/dev/admin-password`,
          apiKey: `ssm:/community-hub/${env}/dev/api-key`,
          databasePassword: `ssm:/community-hub/${env}/dev/database-password`,
        },
        engineOptions: {
          trustLevelGroups: { '0': 'members' },
        },
      },
    ],
  };
  return stringify(doc);
}

/** Load a validated model for the given environment name and DNS mode. */
function modelFor(env: string, dnsMode: DnsMode): ValidatedModel {
  return loadMetadata(metadataYaml(env, dnsMode), createDefaultRegistry());
}

/** Create an {@link App} with Lambda bundling disabled (no esbuild, no Docker). */
function createApp(): App {
  return new App({ context: { 'aws:cdk:bundling-stacks': [] } });
}

/**
 * Seed the `HostedZone.fromLookup` context for `route53-existing` so synthesis
 * resolves the zone offline. Mirrors the `environment-dns` test harness.
 */
function seedHostedZoneLookup(app: App, stack: Stack, value: Record<string, string>): void {
  const { key } = ContextProvider.getKey(stack, {
    provider: cxschema.ContextProvider.HOSTED_ZONE_PROVIDER,
    props: { domainName: ROOT_DOMAIN, privateZone: false },
  });
  app.node.setContext(key, value);
}

/** Build an {@link EnvironmentStack} for the mode, resolving any zone lookup offline. */
function buildStack(env: string, dnsMode: DnsMode): EnvironmentStack {
  const app = createApp();
  const model = modelFor(env, dnsMode);

  if (dnsMode === 'route53-existing') {
    const keyScope = new Stack(createApp(), 'KeyScope', {
      env: { account: ACCOUNT, region: REGION },
    });
    seedHostedZoneLookup(app, keyScope, { Id: DECLARED_ZONE_ID, Name: ROOT_DOMAIN });
  }

  return new EnvironmentStack(app, 'TestStack', {
    model,
    registry: createDefaultRegistry(),
    env: { account: ACCOUNT, region: REGION },
  });
}

/** Matches a CDK asset hash: a 64-character lowercase hex token anywhere. */
const ASSET_HASH_GLOBAL = /[0-9a-f]{64}/g;

/** Is the resource at `path` a Lightsail instance's `UserData` property? */
function isLightsailUserData(path: readonly string[]): boolean {
  return (
    path.length === 4 &&
    path[0] === 'Resources' &&
    path[2] === 'Properties' &&
    path[3] === 'UserData'
  );
}

/**
 * Render the fully resolved Lightsail user data from a synthesized template into
 * one scannable string. Unlike the `environment-dns` snapshot test — which
 * placeholders the user data because it varies by token id — here the point is
 * to *scan* it: the gzip+base64 payload is resolved to its concrete string so a
 * leaked secret value would be visible. `App.synth()` resolves CDK tokens, so
 * the stack's assembly template carries the final user data.
 */
function resolvedUserData(stack: EnvironmentStack): string {
  const root = stack.node.root;
  const assembly = root instanceof App ? root.synth() : undefined;
  const parts: string[] = [];
  if (assembly !== undefined) {
    const artifact = assembly.getStackArtifact(stack.artifactId);
    collectUserData(artifact.template, [], parts);
  }
  return parts.join('\n');
}

/** Walk a template, collecting every Lightsail `UserData` string found. */
function collectUserData(node: unknown, path: readonly string[], into: string[]): void {
  if (typeof node === 'string') {
    if (isLightsailUserData(path)) {
      into.push(node);
    }
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, index) => collectUserData(item, [...path, String(index)], into));
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      collectUserData(value, [...path, key], into);
    }
  }
}

/**
 * The full scannable surface of a synthesized stack: the template JSON (with
 * asset hashes stripped so a hash can never masquerade as a non-leak), the
 * outputs, every tag, and the resolved user data. Outputs and tags are part of
 * the template JSON, so stringifying the whole template already covers them;
 * the resolved user data is appended because the template's `UserData` is an
 * unresolved token until synth.
 */
function stackSurface(stack: EnvironmentStack): string {
  const template = Template.fromStack(stack);
  const json = JSON.stringify(template.toJSON()).replace(ASSET_HASH_GLOBAL, 'ASSET');
  const userData = resolvedUserData(stack);
  return `${json}\n${userData}`;
}

/**
 * Synthesizing an {@link EnvironmentStack} is expensive, and crucially the
 * generated secret values never touch the stack (the model carries only
 * references), so the scannable surface for a given `(env, dnsMode)` is a pure
 * function of those two inputs. Memoize it so the property scans a precomputed
 * string per combination rather than re-synthesizing per fast-check run.
 */
const stackSurfaceCache = new Map<string, string>();

/** The scannable surface for `(env, dnsMode)`, synthesized once and cached. */
function stackSurfaceFor(env: string, dnsMode: DnsMode): string {
  const cacheKey = `${env}::${dnsMode}`;
  const cached = stackSurfaceCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const surface = stackSurface(buildStack(env, dnsMode));
  stackSurfaceCache.set(cacheKey, surface);
  return surface;
}

describe('Property 17: secret hygiene (Core 5) — stack synthesis', () => {
  it('never leaks a resolved secret value into templates, outputs, tags or resolved user data', () => {
    fc.assert(
      fc.property(
        environmentArb,
        fc.constantFrom<DnsMode>('route53', 'route53-existing', 'external'),
        // The generated values the Secret_References *would* resolve to. They
        // are never placed in the model; the model carries only references. So
        // the only correct outcome is that none of them appears anywhere.
        fc.array(secretValueArb, { minLength: 3, maxLength: 6 }),
        (env, dnsMode, secretValues) => {
          const surface = stackSurfaceFor(env, dnsMode);

          // The references themselves may (and do) appear in user data; the
          // values must not. Confirm at least one reference is present so the
          // test is meaningfully scanning user data, then assert no value leaks.
          expect(surface).toContain(`/community-hub/${env}/main/api-key`);
          assertNoSecrets(surface, secretValues);
        },
      ),
      FC_CONFIG,
    );
  }, 30_000);
});

// --- Surface 2: SES SMTP credentials handler -------------------------------

/** The tiny model the fake IAM/SSM clients share for the SES handler. */
interface SesModel {
  keys: string[];
  params: { username?: string; password?: string };
}

/** Read the `Name` off a recorded SSM command input. */
function ssmName(input: unknown): string {
  return (input as { Name?: unknown }).Name as string;
}

/** Read the `AccessKeyId` off a recorded IAM command input. */
function accessKeyIdOf(input: unknown): string | undefined {
  const value = (input as { AccessKeyId?: unknown }).AccessKeyId;
  return typeof value === 'string' ? value : undefined;
}

/** The wired SES handler plus its captured logger and leak targets. */
interface SesHarness {
  readonly onEvent: (e: SesCredentialsEvent) => Promise<SesCredentialsResponse>;
  readonly model: SesModel;
  readonly log: CapturedLogger;
  readonly secretAccessKey: string;
  readonly derivedPassword: string;
}

/** Build the SES handler over fake IAM/SSM clients whose create returns `secret`. */
function buildSesHarness(secret: string): SesHarness {
  const model: SesModel = { keys: [], params: {} };
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
      return { AccessKey: { AccessKeyId: accessKeyId, SecretAccessKey: secret } };
    },
    DeleteAccessKeyCommand: (input: unknown) => {
      const id = accessKeyIdOf(input);
      model.keys = model.keys.filter((key) => key !== id);
      return {};
    },
  });

  const ssm = createFakeAwsClient({
    PutParameterCommand: (input: unknown) => {
      const name = ssmName(input);
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
      const name = ssmName(input);
      const value = name.endsWith('/ses-smtp-username')
        ? model.params.username
        : model.params.password;
      if (value === undefined) {
        return Object.assign(new Error('sdk body'), { name: 'ParameterNotFound' });
      }
      return { Parameter: { Value: value } };
    },
    DeleteParameterCommand: (input: unknown) => {
      const name = ssmName(input);
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
    now: () => new Date('2024-01-02T03:04:05.678Z'),
    logger: log.logger,
    redactor: log.redactor,
  });

  return {
    onEvent,
    model,
    log,
    secretAccessKey: secret,
    derivedPassword: deriveSesSmtpPassword(secret, REGION),
  };
}

/** Resource properties the SES custom resource carries (all non-secret). */
function sesProps(
  env: string,
  forumId: string,
  counter: number,
): Readonly<Record<string, unknown>> {
  return { environment: env, forumId, rotationCounter: String(counter) };
}

/** Invoke the SES handler, capturing the response or thrown error. */
async function invokeSes(
  onEvent: (e: SesCredentialsEvent) => Promise<SesCredentialsResponse>,
  event: SesCredentialsEvent,
): Promise<{ response?: SesCredentialsResponse; error?: unknown }> {
  try {
    return { response: await onEvent(event) };
  } catch (error) {
    return { error };
  }
}

/** Join every SES leak surface (logs, response, physical id, error) into one string. */
function sesLeakSurface(
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
      parts.push(error.message, error.stack ?? '');
    } else {
      parts.push(JSON.stringify(error));
    }
  }
  return parts.join('\n');
}

describe('Property 17: secret hygiene (Core 5) — SES SMTP credentials handler', () => {
  it('never leaks the IAM secret or derived SMTP password; every response sets NoEcho', async () => {
    await fc.assert(
      fc.asyncProperty(
        environmentArb,
        forumIdArb,
        counterArb,
        secretValueArb,
        async (env, forumId, counter, secret) => {
          const h = buildSesHarness(secret);
          const leakTargets = [h.secretAccessKey, h.derivedPassword];

          // Create.
          const create = await invokeSes(
            h.onEvent,
            makeCfnEvent({ ResourceProperties: sesProps(env, forumId, counter) }),
          );
          expect(create.response?.NoEcho).toBe(true);
          assertNoSecrets(sesLeakSurface(h.log, create), leakTargets);

          // Rotate (higher counter → replacement Create).
          const createdId = h.model.keys[0];
          const physicalId =
            createdId === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(env, forumId, counter, createdId);
          const update = await invokeSes(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Update',
              ...(physicalId !== undefined ? { PhysicalResourceId: physicalId } : {}),
              ResourceProperties: sesProps(env, forumId, counter + 1),
            }),
          );
          expect(update.response?.NoEcho).toBe(true);
          assertNoSecrets(sesLeakSurface(h.log, update), leakTargets);

          // Delete.
          const rotatedKey = h.model.keys[h.model.keys.length - 1];
          const rotatedId =
            rotatedKey === undefined
              ? undefined
              : names.sesCredentialsPhysicalId(env, forumId, counter + 1, rotatedKey);
          const del = await invokeSes(
            h.onEvent,
            makeCfnEvent({
              RequestType: 'Delete',
              ...(rotatedId !== undefined ? { PhysicalResourceId: rotatedId } : {}),
              ResourceProperties: sesProps(env, forumId, counter + 1),
            }),
          );
          expect(del.response?.NoEcho).toBe(true);
          assertNoSecrets(sesLeakSurface(h.log, del), leakTargets);
        },
      ),
      FC_CONFIG,
    );
  });
});

// --- Surface 3: bootstrap broker handler -----------------------------------

const BROKER_INSTANCE_NAME = 'community-prod-main-instance';
const BROKER_ROLE = 'community-prod-main-node-role';
const BROKER_INSTANCE = 'community-prod-main';

/** Build a broker handler whose `CreateActivation` returns the generated code. */
function buildBrokerHarness(
  activationCode: string,
  options: { failCreate?: boolean } = {},
): {
  handle: (e: BrokerEvent) => Promise<BrokerResponse>;
  log: CapturedLogger;
} {
  const forums: ForumsConfig = {
    main: {
      instanceName: BROKER_INSTANCE_NAME,
      roleName: BROKER_ROLE,
      defaultInstanceName: BROKER_INSTANCE,
    },
  };
  const ssm = createFakeAwsClient({
    DescribeActivationsCommand: { ActivationList: [] },
    DescribeInstanceInformationCommand: { InstanceInformationList: [] },
    CreateActivationCommand: options.failCreate
      ? Object.assign(new Error(`CreateActivation failed carrying ${activationCode}`), {
          name: 'ThrottlingException',
        })
      : { ActivationId: 'test-activation-id', ActivationCode: activationCode },
  });
  const lightsail = createFakeAwsClient({
    GetInstanceCommand: { instance: { state: { name: 'running' } } },
  });
  const log = captureLogger();
  const ssmDep: Pick<SSMClient, 'send'> = ssm;
  const lightsailDep: Pick<LightsailClient, 'send'> = lightsail;
  const handle = createBrokerHandler({
    ssm: ssmDep,
    lightsail: lightsailDep,
    now: () => new Date('2024-01-01T00:00:00.000Z'),
    logger: log.logger,
    redactor: log.redactor,
    region: REGION,
    forums,
  });
  return { handle, log };
}

/** A POST claim event from the forum's declared static IP. */
function brokerEvent(): BrokerEvent {
  return {
    body: JSON.stringify({ environment: 'community-prod', forumId: 'main' }),
    // The source IP carries no authorization meaning (Lightsail NATs outbound
    // away from the static IP); the broker authorizes by instance ownership.
    requestContext: { http: { method: 'POST', sourceIp: '198.51.100.7' } },
  };
}

describe('Property 17: secret hygiene (Core 5) — bootstrap broker handler', () => {
  it('returns the activation code in the 200 body only, never in logs or on failure', async () => {
    await fc.assert(
      fc.asyncProperty(secretValueArb, async (activationCode) => {
        // Success path: the code is allowed in the 200 body, nowhere else.
        const ok = buildBrokerHarness(activationCode);
        const res = await ok.handle(brokerEvent());
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body) as { activationCode: string };
        expect(body.activationCode).toBe(activationCode);
        // The one permitted place is the body; logs must not carry it.
        assertNoSecrets(ok.log.lines.join('\n'), [activationCode]);

        // Failure path: an SDK error whose message embeds the code must never
        // surface it in the generic 500 body or in any log line.
        const bad = buildBrokerHarness(activationCode, { failCreate: true });
        const failRes = await bad.handle(brokerEvent());
        expect(failRes.statusCode).toBe(500);
        assertNoSecrets(failRes.body, [activationCode]);
        assertNoSecrets(bad.log.lines.join('\n'), [activationCode]);
      }),
      FC_CONFIG,
    );
  });
});

// --- Surface 4: seed CLI (dry-run and real) --------------------------------

/**
 * Wire a single-`testengine` forum model whose admin password and API key are
 * `ssm:` references, backed by an in-memory fake forum. A fake resolver returns
 * the generated secret values for those references; `randomPassword` also yields
 * a generated value so write-only user passwords are covered too.
 */
function wireSeed(secrets: { adminPassword: string; apiKey: string; randomPassword: string }): {
  run: (dryRun: boolean) => ReturnType<typeof runSeed>;
  log: CapturedLogger;
  secretValues: readonly string[];
} {
  const env = 'community-test';
  const fake = createFakeForum({ forumId: 'main' });
  const seedClientFactory = (deps: SeedClientDeps): SeedClient => {
    void deps;
    return fake.client;
  };
  const registry = new EngineRegistry([createTestEngine({ id: 'testengine', seedClientFactory })]);
  const model = loadMetadata(
    [
      'version: 1',
      'environment:',
      '  name: community-test',
      '  region: us-east-1',
      '  availabilityZone: us-east-1a',
      '  dnsMode: route53',
      '  rootDomain: example.org',
      '  adminEmail: ops@example.org',
      '  sshAllowedCidrs:',
      '    - 203.0.113.0/24',
      'forums:',
      '  - id: main',
      '    engine: testengine',
      '    subdomain: forum',
      '    bundleId: small_3_0',
      '    senderAddress: noreply',
      '    secrets:',
      `      adminPassword: ssm:/community-hub/${env}/main/admin-password`,
      `      apiKey: ssm:/community-hub/${env}/main/api-key`,
      '    config:',
      '      users:',
      '        - username: alice',
      '          email: alice@example.org',
      '          trustLevel: 0',
      '',
    ].join('\n'),
    registry,
  );

  const log = captureLogger();
  // A resolver that returns the generated value for the matching reference and
  // registers it with the capturing redactor (as the real resolver does).
  const resolver: SecretResolver = (ref: SecretReference) => {
    const id = ref.id;
    const value = id.endsWith('/admin-password')
      ? secrets.adminPassword
      : id.endsWith('/api-key')
        ? secrets.apiKey
        : secrets.randomPassword;
    log.redactor.register(value);
    return Promise.resolve(value);
  };
  const http: HttpClient = {
    request(): never {
      throw new Error('HttpClient.request should not be called by the fake forum');
    },
  };

  return {
    run: (dryRun: boolean) =>
      runSeed({
        model,
        registry,
        dryRun,
        deps: {
          secrets: resolver,
          http,
          logger: log.logger,
          randomPassword: () => secrets.randomPassword,
        },
      }),
    log,
    secretValues: [secrets.adminPassword, secrets.apiKey, secrets.randomPassword],
  };
}

describe('Property 17: secret hygiene (Core 5) — seed CLI', () => {
  it('never leaks resolved secrets into the report or logs, in dry-run or real mode', async () => {
    await fc.assert(
      fc.asyncProperty(
        secretValueArb,
        secretValueArb,
        secretValueArb,
        fc.boolean(),
        async (adminPassword, apiKey, randomPassword, dryRun) => {
          const wired = wireSeed({ adminPassword, apiKey, randomPassword });
          const result = await wired.run(dryRun);

          // The report text printed to stdout must carry no secret value.
          assertNoSecrets(result.report, wired.secretValues);
          // Captured logs must carry no secret value either.
          assertNoSecrets(wired.log.lines.join('\n'), wired.secretValues);
        },
      ),
      FC_CONFIG,
    );
  });
});
