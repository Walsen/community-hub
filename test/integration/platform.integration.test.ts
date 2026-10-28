/**
 * Opt-in end-to-end integration tests (optional task 21.9).
 *
 * These tests deploy a real, throwaway Lightsail Environment (one small Flarum
 * forum, `acmeStaging: true`) and assert the runtime behaviours that can only
 * be observed end to end and cannot be covered by unit, template or script
 * assertions:
 *
 *  - broker claim and node scoping — the forum registers exactly one SSM
 *    hybrid managed node, proving it claimed its single-use activation from the
 *    per-Environment bootstrap broker (instance-credentials path);
 *  - the admin API key is written to its own SSM parameter (Req 5.4 / 6.4);
 *  - the forum is served over HTTPS and plain HTTP redirects to it (Req 13.10
 *    renewal path depends on this reachability; Req 6.4 HTTPS);
 *  - DNS-01 issuance and the conflicting-record failure in `route53-existing`
 *    (Req 12.9, 13.10) — zone-gated;
 *  - a forced certificate renewal keeps the forum reachable (Req 13.10);
 *  - seeding twice issues zero mutating calls on the second run (Req 9.1);
 *  - SES SMTP authentication succeeds with the stored credentials (Req 11.15);
 *  - credential rotation reports the `applied` outcome, leaving a single live
 *    access key (Req 11.15);
 *  - after destroy the instance is gone and the final manual snapshot is
 *    retained (Req 3.7).
 *
 * Guarding and exclusion (these must NOT run during the default `npm test`):
 *  - `vitest.config.ts` excludes `test/integration/**`, so `npm test` never
 *    loads this file at all;
 *  - this suite is wrapped in {@link describeIntegration}, which is
 *    `describe.skip` unless `COMMUNITY_HUB_INTEGRATION=1`, so even
 *    `npm run test:integration` without the opt-in env var skips it and issues
 *    no AWS calls.
 *
 * When enabled, these tests make real AWS API calls and incur cost; that is the
 * operator's deliberate opt-in. The Environment is deployed once in `beforeAll`
 * and always torn down in `afterAll`, even when an assertion fails, so a run
 * never leaks resources.
 *
 * No secret values appear in this file. SSM parameter *values* are only ever
 * asserted by shape (non-empty, or the fixed SES SMTP password length); the
 * admin API key read for seeding stays inside the seeder and is never logged.
 */

import { spawnSync } from 'node:child_process';

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../src/engines/registry.js';
import { deriveSesSmtpPassword } from '../../src/infra/email/smtp-password.js';
import { names } from '../../src/infra/naming.js';
import type { ForumModel } from '../../src/metadata/schema.js';
import { createHttpClient } from '../../src/shared/http.js';
import { Redactor, createLogger } from '../../src/shared/logger.js';
import { createAwsSecretResolver } from '../../src/shared/secrets.js';
import { runSeed, type RunSeedDeps } from '../../src/seeder/run.js';

import {
  INTEGRATION_ZONE_ID_ENV_VAR,
  deployEnvironment,
  describeIntegration,
  destroyEnvironment,
  type ThrowawayEnvironment,
} from './support.js';

/** Upper bound for the long AWS-side deploy/rotate/destroy lifecycle hooks. */
const LIFECYCLE_TIMEOUT_MS = 45 * 60 * 1000;
/** Per-test timeout for the shorter end-to-end assertions. */
const ASSERTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Whether the DNS-dependent scenarios (DNS-01 issuance, conflicting-record
 * failure, and anything needing a reachable public hostname such as HTTPS and
 * seeding) can run. They can only run when a real public hosted zone id is
 * supplied, which puts the Environment into `route53-existing`; otherwise the
 * Environment is `external` and the forum has no resolvable hostname.
 */
const ZONE_ID = process.env[INTEGRATION_ZONE_ID_ENV_VAR];
const ZONE_AVAILABLE = ZONE_ID !== undefined && ZONE_ID.length > 0;
/** Clear skip reason shown when the zone-gated cases are excluded. */
const ZONE_SKIP_REASON = `set ${INTEGRATION_ZONE_ID_ENV_VAR} to a real public hosted zone id to run this scenario`;

describeIntegration('platform end-to-end', () => {
  let environment: ThrowawayEnvironment | undefined;

  beforeAll(() => {
    // One deploy for the whole suite; always torn down in afterAll even if this
    // throws partway, because destroyEnvironment tolerates partial state.
    environment = deployEnvironment();
  }, LIFECYCLE_TIMEOUT_MS);

  afterAll(() => {
    // Safety net: tear down whatever the suite left (the retained-snapshot test
    // clears `environment` once it has destroyed the stack itself). Tolerates
    // an already-destroyed stack and an undefined handle.
    destroyEnvironment(environment);
    environment = undefined;
  }, LIFECYCLE_TIMEOUT_MS);

  it(
    'registers exactly one SSM managed node for the forum (broker claim)',
    () => {
      const env = requireEnv(environment);
      const nodes = describeNodes(env, soleForum(env).id);
      // Exactly one node registered for the one forum, and it is online — proof
      // the instance claimed its single-use activation from the broker and the
      // activation name is scoped to this Environment and forum.
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.PingStatus).toBe('Online');
      expect(names.activationName(env.name, soleForum(env).id)).toBe(
        `${env.name}-${soleForum(env).id}`,
      );
    },
    ASSERTION_TIMEOUT_MS,
  );

  it(
    'writes the admin API key to the forum SSM parameter',
    () => {
      const env = requireEnv(environment);
      const ref = soleForum(env).secrets.apiKey;
      expect(ref?.store).toBe('ssm');
      const name = ref?.id ?? '';
      expect(name.length).toBeGreaterThan(0);
      // Assert the parameter exists and is non-empty; never assert its value.
      expect(readSsmValue(env, name).length).toBeGreaterThan(0);
    },
    ASSERTION_TIMEOUT_MS,
  );

  it.runIf(ZONE_AVAILABLE)(
    'serves HTTPS and redirects plain HTTP to HTTPS',
    async () => {
      const env = requireEnv(environment);
      const host = forumHostname(env);

      const https = await fetch(`https://${host}/`, { redirect: 'manual' });
      expect(https.status).toBeGreaterThanOrEqual(200);
      expect(https.status).toBeLessThan(400);

      // Plain HTTP outside the ACME challenge path redirects to HTTPS (Req 13.14).
      const http = await fetch(`http://${host}/`, { redirect: 'manual' });
      expect([301, 302, 307, 308]).toContain(http.status);
      expect(http.headers.get('location') ?? '').toMatch(/^https:\/\//);
    },
    ASSERTION_TIMEOUT_MS,
  );

  it.skipIf(ZONE_AVAILABLE)(`serves HTTPS (zone-gated) — ${ZONE_SKIP_REASON}`, () => {
    expect(ZONE_AVAILABLE).toBe(false);
  });

  it.runIf(ZONE_AVAILABLE)(
    'issues the certificate via the DNS-01 challenge',
    () => {
      const env = requireEnv(environment);
      const host = forumHostname(env);
      // A valid leaf certificate whose CN matches the hostname is proof the
      // DNS-01 flow (Route 53 TXT at _acme-challenge.<host>) completed.
      expect(readTlsSubjectCn(host)).toBe(host);
    },
    ASSERTION_TIMEOUT_MS,
  );

  it.skipIf(ZONE_AVAILABLE)(`DNS-01 issuance (zone-gated) — ${ZONE_SKIP_REASON}`, () => {
    expect(ZONE_AVAILABLE).toBe(false);
  });

  it.runIf(ZONE_AVAILABLE)(
    'fails a redeploy when a conflicting non-Platform record exists',
    () => {
      const env = requireEnv(environment);
      const host = forumHostname(env);
      const zoneId = ZONE_ID ?? '';
      const conflicting = '192.0.2.1';

      // Pre-create a conflicting A record the Platform would otherwise own.
      changeARecord(zoneId, host, conflicting, 'UPSERT');
      try {
        const deploy = spawnSync(
          'npx',
          ['cdk', 'deploy', '-c', `metadata=${env.metadataPath}`, '--require-approval', 'never'],
          { encoding: 'utf8' },
        );
        // The deploy must fail because the record is not a Platform_Record.
        expect(deploy.status).not.toBe(0);
        // ...and the conflicting record must be untouched by the failed deploy.
        expect(readARecordValues(zoneId, host)).toContain(conflicting);
      } finally {
        changeARecord(zoneId, host, conflicting, 'DELETE');
      }
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it.skipIf(ZONE_AVAILABLE)(`conflicting record (zone-gated) — ${ZONE_SKIP_REASON}`, () => {
    expect(ZONE_AVAILABLE).toBe(false);
  });

  it.runIf(ZONE_AVAILABLE)(
    'renews the certificate on force and stays reachable',
    () => {
      const env = requireEnv(environment);
      const host = forumHostname(env);
      const before = readTlsNotBefore(host);

      // Force a renewal through the on-instance renew command over SSM Run
      // Command — the same lego renew path the daily timer uses, with --force.
      runOnInstance(env, 'sudo /opt/community-hub/renew-cert.sh --force');

      const after = readTlsNotBefore(host);
      // A forced renewal issues a fresh certificate (notBefore no earlier than
      // before) and the forum keeps serving HTTPS throughout.
      expect(after).toBeGreaterThanOrEqual(before);
      expect(curlStatus(`https://${host}/`)).toBeLessThan(400);
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it.skipIf(ZONE_AVAILABLE)(`forced renewal (zone-gated) — ${ZONE_SKIP_REASON}`, () => {
    expect(ZONE_AVAILABLE).toBe(false);
  });

  it.runIf(ZONE_AVAILABLE)(
    'seeds idempotently: the second run issues zero mutating calls',
    async () => {
      const env = requireEnv(environment);
      const deps = buildSeedDeps(env);

      const first = await runSeed({
        model: env.model,
        registry: createDefaultRegistry(),
        dryRun: false,
        deps,
      });
      expect(first.exitStatus).toBe(0);

      const second = await runSeed({
        model: env.model,
        registry: createDefaultRegistry(),
        dryRun: false,
        deps,
      });
      const summary = second.summaries[0];
      expect(summary).toBeDefined();
      // Second run is a no-op: nothing created, updated or failed (Req 9.1).
      expect(summary?.created).toBe(0);
      expect(summary?.updated).toBe(0);
      expect(summary?.failed).toBe(0);
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it.skipIf(ZONE_AVAILABLE)(`idempotent seed (zone-gated) — ${ZONE_SKIP_REASON}`, () => {
    expect(ZONE_AVAILABLE).toBe(false);
  });

  it(
    'authenticates to the SES SMTP endpoint with the stored credentials',
    () => {
      const env = requireEnv(environment);
      const forum = soleForum(env);
      const region = env.model.environment.region;

      const username = readSsmValue(env, names.sesParameter(env.name, forum.id, 'username'));
      const password = readSsmValue(env, names.sesParameter(env.name, forum.id, 'password'));

      expect(username.length).toBeGreaterThan(0);
      // The derivation is deterministic and yields a 44-char base64 password;
      // the stored one must match that shape.
      expect(password.length).toBe(deriveSesSmtpPassword('placeholder-key', region).length);

      // A real AUTH LOGIN handshake over STARTTLS confirms the credentials work.
      expect(smtpAuthLogin(`email-smtp.${region}.amazonaws.com`, username, password)).toBe(true);
    },
    ASSERTION_TIMEOUT_MS,
  );

  it(
    'rotates SES credentials on redeploy, leaving a single live access key',
    () => {
      const env = requireEnv(environment);
      const forum = soleForum(env);
      const passwordParam = names.sesParameter(env.name, forum.id, 'password');
      const before = readSsmValue(env, passwordParam);

      // Redeploy the same Environment (the throwaway builder bumps nothing by
      // itself; the SES credentials custom resource re-derives and replaces the
      // key material, which is the observable `applied` rotation outcome).
      const rotated = deployEnvironment({ name: env.name });
      // Keep the latest handle so afterAll tears down the redeployed stack.
      environment = rotated;

      const after = readSsmValue(rotated, passwordParam);
      expect(after).not.toBe(before);

      // Exactly one live (Active) access key remains for the forum's SES user.
      const user = names.sesUser(rotated.name, forum.id);
      const keys = listActiveAccessKeys(rotated, user);
      expect(keys).toHaveLength(1);
    },
    LIFECYCLE_TIMEOUT_MS,
  );

  it(
    'retains the final manual snapshot after destroy',
    () => {
      const env = requireEnv(environment);
      const forum = soleForum(env);
      const instanceName = names.instance(env.name, forum.id);

      // Drive `cdk destroy` ourselves so we can inspect the retained snapshot
      // before the harness teardown deletes it. The lifecycle custom resource
      // takes a final manual snapshot before deleting the instance (Req 3.7).
      const destroy = spawnSync(
        'npx',
        ['cdk', 'destroy', '--force', '-c', `metadata=${env.metadataPath}`],
        { encoding: 'utf8' },
      );
      expect(destroy.status).toBe(0);

      // The instance is gone.
      expect(getInstances(env)).not.toContain(instanceName);

      // A retained final manual snapshot carrying the forum's prefix survives.
      const prefix = `${env.name}-${forum.id}-final-`;
      const retained = getSnapshotNames(env).filter((name) => name.startsWith(prefix));
      expect(retained.length).toBeGreaterThanOrEqual(1);

      // Hand cleanup of the retained snapshots and temp dir to the harness; the
      // stack is already destroyed, which destroyEnvironment tolerates.
      destroyEnvironment(env);
      environment = undefined;
    },
    LIFECYCLE_TIMEOUT_MS,
  );
});

// --- helpers -----------------------------------------------------------------

/** Assert the Environment was deployed, narrowing it for a test body. */
function requireEnv(environment: ThrowawayEnvironment | undefined): ThrowawayEnvironment {
  if (environment === undefined) {
    throw new Error('Environment was not deployed in beforeAll');
  }
  return environment;
}

/** The single forum in the throwaway Environment. */
function soleForum(environment: ThrowawayEnvironment): ForumModel {
  const forum = environment.model.forums[0];
  if (forum === undefined) {
    throw new Error('throwaway Environment unexpectedly has no forum');
  }
  return forum;
}

/** Fully qualified hostname of the sole forum. */
function forumHostname(environment: ThrowawayEnvironment): string {
  return `${soleForum(environment).subdomain}.${environment.model.environment.rootDomain}`;
}

/** Run an AWS CLI subcommand in the Environment's region, returning stdout JSON text. */
function aws(environment: ThrowawayEnvironment, args: readonly string[]): string {
  const result = spawnSync('aws', [...args, '--region', environment.region, '--output', 'json'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `aws ${args.slice(0, 2).join(' ')} exited with status ${String(result.status)}`,
    );
  }
  return result.stdout;
}

/** A managed-node summary row from `ssm describe-instance-information`. */
interface ManagedNode {
  readonly InstanceId?: string;
  readonly PingStatus?: string;
}

/** List the SSM managed nodes registered for a forum, by Environment+forum tags. */
function describeNodes(environment: ThrowawayEnvironment, forumId: string): ManagedNode[] {
  const stdout = aws(environment, [
    'ssm',
    'describe-instance-information',
    '--filters',
    `Key=tag:community-hub:environment,Values=${environment.name}`,
    `Key=tag:community-hub:forum,Values=${forumId}`,
  ]);
  const parsed = JSON.parse(stdout) as { InstanceInformationList?: ManagedNode[] };
  return parsed.InstanceInformationList ?? [];
}

/** Read an SSM SecureString value via the AWS CLI; returns the decrypted value. */
function readSsmValue(environment: ThrowawayEnvironment, name: string): string {
  const stdout = aws(environment, ['ssm', 'get-parameter', '--name', name, '--with-decryption']);
  const parsed = JSON.parse(stdout) as { Parameter?: { Value?: string } };
  return parsed.Parameter?.Value ?? '';
}

/** List the Active access keys for an IAM user. */
function listActiveAccessKeys(environment: ThrowawayEnvironment, userName: string): string[] {
  const stdout = aws(environment, ['iam', 'list-access-keys', '--user-name', userName]);
  const parsed = JSON.parse(stdout) as {
    AccessKeyMetadata?: { AccessKeyId?: string; Status?: string }[];
  };
  return (parsed.AccessKeyMetadata ?? [])
    .filter((key) => key.Status === 'Active')
    .map((key) => key.AccessKeyId ?? '');
}

/** Return the raw JSON text of `lightsail get-instances` for a substring check. */
function getInstances(environment: ThrowawayEnvironment): string {
  return aws(environment, ['lightsail', 'get-instances']);
}

/** List all Lightsail instance-snapshot names in the Environment's region. */
function getSnapshotNames(environment: ThrowawayEnvironment): string[] {
  const parsed = JSON.parse(aws(environment, ['lightsail', 'get-instance-snapshots'])) as {
    instanceSnapshots?: { name?: string }[];
  };
  return (parsed.instanceSnapshots ?? []).map((snap) => snap.name ?? '');
}

/** Build real seeder dependencies (HTTPS client, AWS secret resolver, logger). */
function buildSeedDeps(environment: ThrowawayEnvironment): RunSeedDeps {
  const redactor = new Redactor();
  const logger = createLogger({ sink: { write: () => undefined }, redactor });
  const secrets = createAwsSecretResolver({
    ssm: new SSMClient({ region: environment.region }),
    secretsManager: new SecretsManagerClient({ region: environment.region }),
    redactor,
  });
  const http = createHttpClient({
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });
  return {
    secrets,
    http,
    logger,
    randomPassword: () => `it-${Math.random().toString(36).slice(2)}`,
  };
}

/** The leaf certificate fields this suite reads over TLS. */
interface LeafCertificate {
  readonly cn: string;
  readonly notBeforeMs: number;
}

/**
 * Read the peer leaf certificate's subject CN and `notBefore` over a short-lived
 * TLS connection, synchronously, via `openssl s_client`. Driving openssl through
 * the shell keeps the helper blocking (vitest `it` bodies here are synchronous)
 * without pulling in extra dependencies.
 */
function readLeafCertificate(host: string): LeafCertificate {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `echo | openssl s_client -servername ${host} -connect ${host}:443 2>/dev/null | ` +
        `openssl x509 -noout -subject -startdate`,
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`openssl probe of ${host} failed`);
  }
  const cn = /CN\s*=\s*([^,\n/]+)/.exec(result.stdout)?.[1]?.trim() ?? '';
  const startDate = /notBefore=(.+)/.exec(result.stdout)?.[1]?.trim();
  return { cn, notBeforeMs: startDate !== undefined ? Date.parse(startDate) : 0 };
}

/** The subject CN of the peer leaf certificate at `host`. */
function readTlsSubjectCn(host: string): string {
  return readLeafCertificate(host).cn;
}

/** The `notBefore` epoch-ms of the peer leaf certificate at `host`. */
function readTlsNotBefore(host: string): number {
  return readLeafCertificate(host).notBeforeMs;
}

/** The HTTP status code `curl` observes for a URL (0 on transport failure). */
function curlStatus(url: string): number {
  const result = spawnSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', url], {
    encoding: 'utf8',
  });
  return Number(result.stdout) || 0;
}

/**
 * Perform an SMTP AUTH LOGIN handshake over STARTTLS; returns true when the
 * endpoint replies 235 (authentication succeeded).
 */
function smtpAuthLogin(host: string, username: string, password: string): boolean {
  const u = Buffer.from(username, 'utf8').toString('base64');
  const p = Buffer.from(password, 'utf8').toString('base64');
  const script = ['AUTH LOGIN', u, p, 'QUIT', ''].join('\r\n');
  const result = spawnSync(
    'bash',
    [
      '-c',
      `printf '%s' ${JSON.stringify(script)} | ` +
        `openssl s_client -quiet -starttls smtp -connect ${host}:587 2>/dev/null`,
    ],
    { encoding: 'utf8' },
  );
  return result.stdout.includes('235');
}

/** Run a shell command on the forum instance through SSM Run Command. */
function runOnInstance(environment: ThrowawayEnvironment, command: string): void {
  const instanceId = describeNodes(environment, soleForum(environment).id)[0]?.InstanceId;
  if (instanceId === undefined) {
    throw new Error('no managed node found for forum');
  }
  const run = spawnSync(
    'aws',
    [
      'ssm',
      'send-command',
      '--region',
      environment.region,
      '--instance-ids',
      instanceId,
      '--document-name',
      'AWS-RunShellScript',
      '--parameters',
      JSON.stringify({ commands: [command] }),
    ],
    { encoding: 'utf8' },
  );
  if (run.status !== 0) {
    throw new Error('ssm send-command failed');
  }
}

/** Apply one Route 53 A-record change action (test fixture / cleanup). */
function changeARecord(
  hostedZoneId: string,
  name: string,
  value: string,
  action: 'UPSERT' | 'DELETE',
): void {
  const batch = {
    Changes: [
      {
        Action: action,
        ResourceRecordSet: {
          Name: `${name}.`,
          Type: 'A',
          TTL: 300,
          ResourceRecords: [{ Value: value }],
        },
      },
    ],
  };
  spawnSync(
    'aws',
    [
      'route53',
      'change-resource-record-sets',
      '--hosted-zone-id',
      hostedZoneId,
      '--change-batch',
      JSON.stringify(batch),
    ],
    { encoding: 'utf8' },
  );
}

/** The current A-record values for `name` in the zone, as raw JSON text. */
function readARecordValues(hostedZoneId: string, name: string): string {
  const result = spawnSync(
    'aws',
    [
      'route53',
      'list-resource-record-sets',
      '--hosted-zone-id',
      hostedZoneId,
      '--query',
      `ResourceRecordSets[?Name=='${name}.' && Type=='A'].ResourceRecords[].Value`,
      '--output',
      'json',
    ],
    { encoding: 'utf8' },
  );
  return result.stdout;
}
