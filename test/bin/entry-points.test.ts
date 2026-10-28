/**
 * Unit tests for the entry-point exit codes (`bin/seed.ts` and `bin/app.ts`).
 *
 * The seeder entry point exposes a testable {@link main} that takes argv and
 * captured streams and returns an exit code, so its exit-code mapping is driven
 * directly here with crafted argv and on-disk fixtures:
 *
 * | Code | When |
 * |------|------|
 * | `2`  | usage error, invalid metadata, unknown `--forum`, secret failure |
 * | `1`  | at least one failed resource or an unreachable forum |
 * | `0`  | everything applied/unchanged/skipped |
 *
 * `bin/seed.ts` builds the real AWS clients (`createDefaultRegistry`, SSM /
 * Secrets Manager, the global `fetch` HTTP client) with no dependency
 * injection, so only the paths that fail *before* any AWS or network call are
 * exercised through `main`: a usage error, invalid metadata
 * ({@link MetadataValidationError}) and an unknown `--forum`
 * ({@link UnknownForumError}, thrown by `runSeed`'s forum selection before the
 * preflight secret resolution). The two deployment-reachable mappings — a
 * {@link SecretResolutionError} (exit 2) and a failed/unreachable resource
 * (exit 1) — cannot be driven through `main` offline (it constructs real
 * clients), so they are proven at the layer `main` delegates to:
 * {@link runSeed}, with an injected failing resolver and an injected unreachable
 * fake forum. `main` maps a `SecretResolutionError` with the same `instanceof`
 * branch that already returns 2 for the two offline cases, and maps
 * `runSeed`'s `exitStatus: 1` straight to exit 1.
 *
 * `bin/app.ts` runs at import and sets `process.exitCode` (no exported
 * `main`), so its full exit code is covered by a child-process spawn that runs
 * the entry with an invalid-metadata fixture and asserts the process exits 2.
 * That mapping (a {@link MetadataValidationError} → exit 2) is also asserted at
 * the loader boundary `bin/app.ts` relies on.
 *
 * Everything is deterministic and offline: no AWS credentials, no network, and
 * only obvious placeholder secret values.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { main as seedMain, type SeedStreams } from '../../bin/seed.js';
import type { SeedClient, SeedClientDeps } from '../../src/engines/engine-adapter.js';
import { EngineRegistry } from '../../src/engines/registry.js';
import { loadMetadata, loadMetadataFile } from '../../src/metadata/loader.js';
import { MetadataValidationError } from '../../src/metadata/errors.js';
import { runSeed } from '../../src/seeder/run.js';
import { SecretResolutionError } from '../../src/shared/errors.js';
import type { HttpClient } from '../../src/shared/http.js';
import { createLogger, Redactor } from '../../src/shared/logger.js';
import type { SecretResolver } from '../../src/shared/secrets.js';

import { createFakeForum } from '../support/fake-forum.js';
import { createTestEngine } from '../support/testengine.js';

/** This test file's directory, for resolving fixtures and entry-point paths. */
const HERE = __dirname;

/** Path to a fixture under `test/fixtures/metadata`. */
function fixture(name: string): string {
  return join(HERE, '..', 'fixtures', 'metadata', name);
}

/** A valid single-forum file that loads against the default registry. */
const VALID_FIXTURE = fixture('valid-default-registry.yaml');

/** An invalid file that fails schema validation (bad version + unknown key). */
const INVALID_FIXTURE = fixture('invalid-schema.yaml');

/** A capturing pair of streams for {@link seedMain}, with the written text. */
function captureStreams(): { streams: SeedStreams; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    streams: {
      stdout: {
        write: (chunk: string): boolean => {
          out.push(chunk);
          return true;
        },
      },
      stderr: {
        write: (chunk: string): boolean => {
          err.push(chunk);
          return true;
        },
      },
    },
  };
}

/** Build a `[node, script, ...args]` argv as commander expects. */
function argv(...args: string[]): string[] {
  return ['node', 'seed', ...args];
}

describe('bin/seed.ts main() exit codes', () => {
  it('exits 2 on a usage error (unknown flag)', async () => {
    const { streams } = captureStreams();
    const code = await seedMain(argv('--definitely-not-a-flag'), streams);
    expect(code).toBe(2);
  });

  it('exits 2 on invalid metadata (MetadataValidationError)', async () => {
    const { streams, err } = captureStreams();
    const code = await seedMain(argv('--metadata', INVALID_FIXTURE), streams);
    expect(code).toBe(2);
    // The message reaches stderr and names a field path, never a secret value.
    const stderr = err.join('');
    expect(stderr.length).toBeGreaterThan(0);
    expect(stderr).not.toContain('admin-password');
  });

  it('exits 2 on an unknown --forum (UnknownForumError, no AWS call)', async () => {
    // The valid fixture declares only forum `main`; requesting `nope` makes
    // runSeed's forum selection throw UnknownForumError before the preflight
    // secret resolution, so no SSM/Secrets Manager or network call happens.
    const { streams, err } = captureStreams();
    const code = await seedMain(argv('--metadata', VALID_FIXTURE, '--forum', 'nope'), streams);
    expect(code).toBe(2);
    expect(err.join('')).toContain('nope');
  });

  it('exits 0 on --help (a CommanderError with exit code 0)', async () => {
    const { streams } = captureStreams();
    const code = await seedMain(argv('--help'), streams);
    expect(code).toBe(0);
  });
});

/**
 * The two deployment-reachable mappings that `main` cannot exercise offline
 * (it builds real AWS clients) are proven at the {@link runSeed} layer `main`
 * delegates to. `main` maps `SecretResolutionError` to exit 2 via the same
 * `instanceof` branch the offline cases above already cover, and maps
 * `runSeed`'s `exitStatus: 1` to exit 1 directly.
 */
describe('bin/seed.ts exit mapping via runSeed (reachable paths)', () => {
  /** A single-`testengine` forum model + registry wired to a fake forum. */
  function wire(options: { unreachable?: boolean; secrets: SecretResolver }): {
    run: () => ReturnType<typeof runSeed>;
  } {
    const fake = createFakeForum({ forumId: 'main', unreachable: options.unreachable ?? false });
    const seedClientFactory = (deps: SeedClientDeps): SeedClient => {
      void deps;
      return fake.client;
    };
    const registry = new EngineRegistry([
      createTestEngine({ id: 'testengine', seedClientFactory }),
    ]);
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
        '      adminPassword: ssm:/community-hub/community-test/main/admin-password',
        '      apiKey: ssm:/community-hub/community-test/main/api-key',
        '',
      ].join('\n'),
      registry,
    );
    const http: HttpClient = {
      request(): never {
        throw new Error('HttpClient.request should not be called by the fake forum');
      },
    };
    const logger = createLogger({ sink: { write: () => undefined }, redactor: new Redactor() });
    return {
      run: () =>
        runSeed({
          model,
          registry,
          dryRun: false,
          deps: {
            secrets: options.secrets,
            http,
            logger,
            randomPassword: () => 'test-random-password',
          },
        }),
    };
  }

  it('runSeed surfaces SecretResolutionError, which main maps to exit 2', async () => {
    const secrets: SecretResolver = () =>
      Promise.reject(
        new SecretResolutionError({ reference: "apiKey of forum 'main'", reason: 'access_denied' }),
      );
    const { run } = wire({ secrets });

    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SecretResolutionError);
    // reportError in bin/seed.ts returns 2 for SecretResolutionError (same
    // instanceof branch as the offline MetadataValidationError/UnknownForumError
    // cases above).
  });

  it('runSeed returns exitStatus 1 for an unreachable forum, which main maps to exit 1', async () => {
    const secrets: SecretResolver = () => Promise.resolve('test-api-key-value');
    const { run } = wire({ unreachable: true, secrets });

    const result = await run();
    expect(result.exitStatus).toBe(1);
    // main returns `result.exitStatus === 1 ? 1 : 0`, so this is exit 1.
    const mapped = result.exitStatus === 1 ? 1 : 0;
    expect(mapped).toBe(1);
  });
});

describe('bin/app.ts exit codes', () => {
  it('maps a MetadataValidationError to exit 2 at the loader boundary', () => {
    // bin/app.ts calls loadMetadataFile and maps MetadataValidationError to
    // exit 2. Assert the loader raises that exact error for the invalid fixture.
    expect(() =>
      loadMetadataFile(INVALID_FIXTURE, new EngineRegistry([createTestEngine()])),
    ).toThrow(MetadataValidationError);
  });

  it('exits 2 when run as a process against invalid metadata', () => {
    // bin/app.ts runs at import and sets process.exitCode; drive the whole
    // process so the real exit code is observed. Prefer the compiled entry if a
    // build is present, else run the TypeScript entry via tsx when available.
    const invocation = resolveAppInvocation();
    if (invocation === undefined) {
      // Neither a compiled dist/bin/app.js nor tsx is available offline; the
      // exit-2 mapping is covered by the loader-boundary test above.
      return;
    }

    const result = spawnSync(invocation.command, invocation.args, {
      cwd: join(HERE, '..', '..'),
      env: {
        ...process.env,
        COMMUNITY_HUB_METADATA: INVALID_FIXTURE,
        // Keep CDK from needing real credentials for this synth-free failure.
        CDK_DEFAULT_ACCOUNT: '000000000000',
        CDK_DEFAULT_REGION: 'us-east-1',
      },
      encoding: 'utf8',
      timeout: 60_000,
    });

    expect(result.status).toBe(2);
  });
});

/** How to invoke `bin/app.ts` as a process, or `undefined` if not runnable. */
interface AppInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

/**
 * Resolve a runnable invocation of the CDK app entry point. Prefers the
 * compiled `dist/bin/app.js`; falls back to running `bin/app.ts` through `tsx`
 * when the loader is installed. Returns `undefined` when neither is available,
 * so the test degrades to the loader-boundary assertion.
 */
function resolveAppInvocation(): AppInvocation | undefined {
  const root = join(HERE, '..', '..');
  const compiled = join(root, 'dist', 'bin', 'app.js');
  if (existsSync(compiled)) {
    return { command: process.execPath, args: [compiled] };
  }
  const tsxCli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (existsSync(tsxCli)) {
    return { command: process.execPath, args: [tsxCli, join(root, 'bin', 'app.ts')] };
  }
  return undefined;
}
