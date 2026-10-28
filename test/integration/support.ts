/**
 * Opt-in integration test harness (task 21.8).
 *
 * Everything in `test/integration/` is excluded from the default `npm test`
 * run by `vitest.config.ts` and runs only through `npm run test:integration`
 * (which `vitest.integration.config.ts` backs, and which the justfile's
 * `test-integration` recipe invokes with `COMMUNITY_HUB_INTEGRATION=1`).
 *
 * This module is reusable scaffolding, not an integration test itself: it
 * provides the env-var guard, a throwaway-Environment metadata builder and the
 * deploy/destroy lifecycle helpers the real tests (optional task 21.9) will
 * call. The deploy and destroy helpers shell out to the project's CDK app
 * (`cdk deploy`/`cdk destroy`), and `destroyEnvironment` additionally deletes
 * the retained final manual snapshots so a run leaves nothing behind.
 *
 * No secret values appear here — metadata carries only Secret_References to
 * placeholder SSM parameter names under the throwaway Environment's own prefix.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe } from 'vitest';

import { createDefaultRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import { formatSecretReference } from '../../src/metadata/secret-ref.js';
import { names } from '../../src/infra/naming.js';
import type { ValidatedModel } from '../../src/metadata/schema.js';

/**
 * The environment variable that opts a run in to the integration suite. The
 * justfile's `test-integration` recipe sets it to `'1'`; nothing else does, so
 * a bare `npm run test:integration` still skips every guarded block.
 */
export const INTEGRATION_ENV_VAR = 'COMMUNITY_HUB_INTEGRATION';

/**
 * Optional environment variable naming a real Route 53 public hosted zone id to
 * exercise `route53-existing` (and therefore DNS-01 issuance). When unset, the
 * harness falls back to `external` DNS mode, which creates no Route 53
 * resources and needs no pre-existing zone.
 */
export const INTEGRATION_ZONE_ID_ENV_VAR = 'COMMUNITY_HUB_IT_ZONE_ID';

/** True only when the run explicitly opted in via {@link INTEGRATION_ENV_VAR}. */
export function integrationEnabled(): boolean {
  return process.env[INTEGRATION_ENV_VAR] === '1';
}

/**
 * A `describe` that runs its body only when the integration suite is enabled,
 * and is otherwise `describe.skip`. Integration tests wrap their top-level
 * suite in this so a non-opted-in run (including the default `npm test`, which
 * never even loads these files) reports them as skipped rather than executing
 * real AWS calls.
 *
 * @example
 * describeIntegration('broker claim', () => {
 *   it('registers exactly one node', async () => { ... });
 * });
 */
export const describeIntegration: typeof describe.skip = integrationEnabled()
  ? describe
  : describe.skip;

/** A deployed throwaway Environment and the artifacts needed to tear it down. */
export interface ThrowawayEnvironment {
  /** The generated Environment name, of the form `it-<suffix>`. */
  readonly name: string;
  /** The validated model the Environment was built from. */
  readonly model: ValidatedModel;
  /** The CloudFormation stack name CDK synthesizes for the Environment. */
  readonly stackName: string;
  /** Absolute path to the temporary metadata file written for CDK. */
  readonly metadataPath: string;
  /** The AWS region the Environment targets. */
  readonly region: string;
}

/** Options for {@link buildThrowawayModel}. */
export interface ThrowawayModelOptions {
  /**
   * Override the generated Environment name. Tests normally let the harness
   * generate a unique `it-<suffix>` name; this exists for deterministic unit
   * checks of the builder itself.
   */
  readonly name?: string;
  /** The AWS region. Defaults to `AWS_REGION` then `us-east-1`. */
  readonly region?: string;
  /** The root domain. Defaults to `community-hub-it.example`. */
  readonly rootDomain?: string;
  /**
   * An explicit Route 53 hosted zone id. When provided (or when
   * {@link INTEGRATION_ZONE_ID_ENV_VAR} is set), the Environment uses
   * `route53-existing`; otherwise it uses `external`.
   */
  readonly hostedZoneId?: string;
}

/** A short, filesystem- and name-safe random suffix for a throwaway Environment. */
function randomSuffix(): string {
  // 4 bytes → 8 lowercase hex chars; `it-` + 8 = 11 chars, well within the
  // 3–32 char Environment-name limit and the hyphen-free forum-id limit.
  return randomBytes(4).toString('hex');
}

/**
 * Build a validated model for a throwaway Environment: one small Flarum forum
 * with `acmeStaging: true` (so Let's Encrypt staging is used and production
 * rate limits are never hit). DNS mode is `route53-existing` when a hosted zone
 * id is available (option or {@link INTEGRATION_ZONE_ID_ENV_VAR}), else
 * `external`.
 *
 * The model is produced through the real {@link loadMetadata} so it is subject
 * to exactly the validation a deployed Environment would be. All secrets are
 * Secret_References to placeholder parameter names under the Environment's own
 * `/community-hub/<env>/<forumId>/` prefix; no secret values are embedded.
 *
 * @param options - Overrides for name, region, domain and hosted zone id.
 * @returns The Environment name and its validated, frozen model.
 */
export function buildThrowawayModel(options: ThrowawayModelOptions = {}): {
  name: string;
  model: ValidatedModel;
} {
  const name = options.name ?? `it-${randomSuffix()}`;
  const region = options.region ?? process.env.AWS_REGION ?? 'us-east-1';
  const rootDomain = options.rootDomain ?? 'community-hub-it.example';
  const hostedZoneId = options.hostedZoneId ?? process.env[INTEGRATION_ZONE_ID_ENV_VAR];
  const forumId = 'main';
  const prefix = `/community-hub/${name}/${forumId}`;

  // `route53-existing` needs a zone id; without one, fall back to `external`,
  // which declares no Route 53 resources at all.
  const dnsLines =
    hostedZoneId !== undefined && hostedZoneId.length > 0
      ? `  dnsMode: route53-existing\n  hostedZoneId: ${hostedZoneId}\n`
      : '  dnsMode: external\n';

  const text = [
    'version: 1',
    'environment:',
    `  name: ${name}`,
    `  region: ${region}`,
    `  availabilityZone: ${region}a`,
    dnsLines.trimEnd(),
    `  rootDomain: ${rootDomain}`,
    `  adminEmail: ops@${rootDomain}`,
    '  sshAllowedCidrs: []',
    '  acmeStaging: true',
    'forums:',
    `  - id: ${forumId}`,
    '    engine: flarum',
    '    subdomain: forum',
    '    bundleId: small_3_0',
    '    senderAddress: noreply',
    '    secrets:',
    `      adminPassword: ssm:${prefix}/admin-password`,
    `      apiKey: ssm:${prefix}/api-key`,
    `      databasePassword: ssm:${prefix}/database-password`,
    '    engineOptions:',
    '      trustLevelGroups:',
    "        '0': members",
    '',
  ].join('\n');

  const model = loadMetadata(text, createDefaultRegistry());
  return { name, model };
}

/** Run a CDK CLI subcommand against the project app, returning on failure. */
function runCdk(args: readonly string[], metadataPath: string): void {
  // The project's `cdk.json` sets the app command (compile + run `bin/app.js`);
  // `-c metadata=<path>` is the form `bin/app.ts` reads first.
  const result = spawnSync(
    'npx',
    ['cdk', ...args, '-c', `metadata=${metadataPath}`, '--require-approval', 'never'],
    { cwd: path.resolve(__dirname, '..', '..'), stdio: 'inherit', encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`cdk ${args.join(' ')} exited with status ${String(result.status)}`);
  }
}

/**
 * Write the throwaway Environment's metadata to a temp file and `cdk deploy` it.
 *
 * Returns the handle the test must pass to {@link destroyEnvironment} in an
 * `afterAll`, regardless of whether later assertions pass, so a run never leaks
 * a Lightsail Environment.
 *
 * @param options - Overrides forwarded to {@link buildThrowawayModel}.
 * @returns The deployed Environment handle.
 */
export function deployEnvironment(options: ThrowawayModelOptions = {}): ThrowawayEnvironment {
  const { name, model } = buildThrowawayModel(options);
  const dir = mkdtempSync(path.join(tmpdir(), `community-hub-it-${name}-`));
  const metadataPath = path.join(dir, 'metadata.yaml');
  // The validated model round-trips through the committed YAML shape; writing
  // the same document we loaded keeps the deploy and the in-memory model in sync.
  writeFileSync(metadataPath, renderModelYaml(model), { encoding: 'utf8', mode: 0o600 });

  runCdk(['deploy', '--outputs-file', path.join(dir, 'outputs.json')], metadataPath);

  return {
    name,
    model,
    stackName: names.stack(name),
    metadataPath,
    region: model.environment.region,
  };
}

/**
 * Tear a throwaway Environment down: `cdk destroy` the stack, then delete the
 * final manual snapshots the lifecycle custom resource retains (CDK/Lightsail
 * leave those behind on purpose), then remove the temp metadata directory.
 *
 * Safe to call from `afterAll` even when {@link deployEnvironment} failed
 * partway: each step tolerates already-absent resources.
 *
 * @param environment - The handle returned by {@link deployEnvironment}, or
 *   `undefined` when deploy never produced one.
 */
export function destroyEnvironment(environment: ThrowawayEnvironment | undefined): void {
  if (environment === undefined) {
    return;
  }

  try {
    runCdk(['destroy', '--force'], environment.metadataPath);
  } finally {
    deleteFinalSnapshots(environment);
    rmSync(path.dirname(environment.metadataPath), { recursive: true, force: true });
  }
}

/**
 * Delete the retained final manual snapshots for every forum in the
 * Environment via the AWS CLI. The lifecycle handler names them
 * `names.finalSnapshot(env, forumId, <utc>)`; snapshots created on destroy
 * carry that prefix, so each is found by listing and matching the prefix.
 */
function deleteFinalSnapshots(environment: ThrowawayEnvironment): void {
  for (const forum of environment.model.forums) {
    const prefix = `${environment.name}-${forum.id}-final-`;
    const list = spawnSync(
      'aws',
      [
        'lightsail',
        'get-instance-snapshots',
        '--region',
        environment.region,
        '--query',
        `instanceSnapshots[?starts_with(name, \`${prefix}\`)].name`,
        '--output',
        'text',
      ],
      { encoding: 'utf8' },
    );
    if (list.status !== 0 || list.stdout.trim().length === 0) {
      continue;
    }
    for (const snapshot of list.stdout.split(/\s+/).filter((value) => value.length > 0)) {
      spawnSync(
        'aws',
        [
          'lightsail',
          'delete-instance-snapshot',
          '--region',
          environment.region,
          '--instance-snapshot-name',
          snapshot,
        ],
        { stdio: 'inherit', encoding: 'utf8' },
      );
    }
  }
}

/**
 * Render a validated model back to the committed metadata YAML shape for the
 * CDK app to read. Only the fields the throwaway builder sets are emitted;
 * Secret_References are written by name, never resolved.
 */
function renderModelYaml(model: ValidatedModel): string {
  const environment = model.environment;
  const dnsLines =
    environment.dnsMode === 'route53-existing' && environment.hostedZoneId !== undefined
      ? `  dnsMode: route53-existing\n  hostedZoneId: ${environment.hostedZoneId}\n`
      : `  dnsMode: ${environment.dnsMode}\n`;

  const forumLines = model.forums.map((forum) => {
    const secrets = Object.entries(forum.secrets)
      .map(([key, ref]) => `      ${key}: ${formatSecretReference(ref)}`)
      .join('\n');
    return [
      `  - id: ${forum.id}`,
      `    engine: ${forum.engine}`,
      `    subdomain: ${forum.subdomain}`,
      `    bundleId: ${forum.bundleId}`,
      `    senderAddress: ${forum.senderAddress}`,
      '    secrets:',
      secrets,
      '    engineOptions:',
      '      trustLevelGroups:',
      "        '0': members",
    ].join('\n');
  });

  return [
    'version: 1',
    'environment:',
    `  name: ${environment.name}`,
    `  region: ${environment.region}`,
    `  availabilityZone: ${environment.availabilityZone}`,
    dnsLines.trimEnd(),
    `  rootDomain: ${environment.rootDomain}`,
    `  adminEmail: ${environment.adminEmail}`,
    '  sshAllowedCidrs: []',
    '  acmeStaging: true',
    'forums:',
    ...forumLines,
    '',
  ].join('\n');
}
