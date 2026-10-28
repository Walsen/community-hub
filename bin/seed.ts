#!/usr/bin/env node
/**
 * Seeder CLI entry point.
 *
 * Parses `--metadata`, `--forum` and `--dry-run` with `commander`, loads and
 * validates the metadata file through {@link loadMetadataFile} with the default
 * engine registry, wires the real I/O dependencies (AWS SSM and Secrets Manager
 * clients behind the {@link createAwsSecretResolver | secret resolver}, an
 * HTTPS-only {@link createHttpClient | HTTP client} over the global `fetch`, a
 * redacting stderr logger and a random-password generator), and drives one
 * {@link runSeed} run. The run's report is printed to stdout.
 *
 * The CLI is the edge where typed errors become messages and exit codes:
 *
 * | Code | When |
 * |------|------|
 * | `0`  | every resource applied, unchanged or skipped |
 * | `1`  | at least one failed resource or unreachable forum ({@link runSeed} returned `exitStatus: 1`) |
 * | `2`  | usage error, invalid metadata ({@link MetadataValidationError}), unknown `--forum` ({@link UnknownForumError}) or a secret resolution failure ({@link SecretResolutionError}) |
 *
 * `error.message` carries only identifiers and reasons — never secret values —
 * so printing it to stderr is safe. A full stack trace is printed only when the
 * environment variable `DEBUG` equals `community-hub`.
 *
 * The orchestration lives in {@link main} so it can be unit-tested (task 21.4)
 * with injected argv and streams; the module only auto-runs when invoked
 * directly as the process entry point.
 */

import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Command, CommanderError, InvalidArgumentError } from 'commander';

import { createDefaultRegistry } from '../src/engines/registry.js';
import { MetadataValidationError } from '../src/metadata/errors.js';
import { loadMetadataFile } from '../src/metadata/loader.js';
import { runSeed, type RunSeedDeps } from '../src/seeder/run.js';
import { SecretResolutionError, UnknownForumError } from '../src/shared/errors.js';
import { createHttpClient } from '../src/shared/http.js';
import { createLogger, Redactor, type LogSink } from '../src/shared/logger.js';
import { createAwsSecretResolver } from '../src/shared/secrets.js';

/** Default metadata file when neither `--metadata` nor the env var is set. */
const DEFAULT_METADATA = 'metadata/example.yaml';

/** Number of random bytes behind a generated user password. */
const RANDOM_PASSWORD_BYTES = 24;

/** The `DEBUG` value that turns on full stack traces. */
const DEBUG_VALUE = 'community-hub';

/** Exit code for a successful run (nothing failed, nothing unreachable). */
const EXIT_OK = 0;

/** Exit code when at least one resource failed or a forum was unreachable. */
const EXIT_RESOURCE_FAILURE = 1;

/**
 * Exit code for configuration errors the run never got past: usage, invalid
 * metadata, an unknown `--forum`, or a secret that could not be resolved.
 */
const EXIT_CONFIG_ERROR = 2;

/** Writable streams the CLI prints to; injected so tests can capture output. */
export interface SeedStreams {
  /** The report goes here. */
  readonly stdout: Pick<NodeJS.WritableStream, 'write'>;
  /** Error messages, structured log lines and stack traces go here. */
  readonly stderr: Pick<NodeJS.WritableStream, 'write'>;
}

/** Parsed `--metadata`, `--forum` and `--dry-run` options. */
interface SeedOptions {
  readonly metadata: string;
  readonly forum?: string;
  readonly dryRun: boolean;
}

/**
 * Run the Seeder CLI once and resolve with the process exit code.
 *
 * Pure of `process`: argv and the output streams are parameters, so the same
 * function backs both the real entry point and the exit-code tests. It never
 * calls `process.exit`; the caller maps the returned code onto the process.
 *
 * @param argv - Full process argv (`[node, script, ...args]`), as commander expects.
 * @param streams - Destinations for the report (`stdout`) and diagnostics (`stderr`).
 * @returns The exit code: `0` success, `1` resource failure/unreachable, `2` config error.
 */
export async function main(argv: readonly string[], streams: SeedStreams): Promise<number> {
  let options: SeedOptions;
  try {
    options = parseArgs(argv, streams);
  } catch (error) {
    // commander already printed usage/version text to the configured streams.
    // A `CommanderError` with exit code 0 (e.g. --help, --version) is success;
    // any other parse failure is a usage error (exit 2).
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? EXIT_OK : EXIT_CONFIG_ERROR;
    }
    throw error;
  }

  const redactor = new Redactor();
  const sink: LogSink = { write: (line) => void streams.stderr.write(`${line}\n`) };
  const logger = createLogger({ sink, redactor });

  try {
    const registry = createDefaultRegistry();
    const model = loadMetadataFile(options.metadata, registry);

    const deps: RunSeedDeps = {
      secrets: createAwsSecretResolver({
        ssm: new SSMClient({}),
        secretsManager: new SecretsManagerClient({}),
        redactor,
      }),
      http: createHttpClient({
        fetch: globalThis.fetch.bind(globalThis),
        sleep: (ms) => delay(ms),
      }),
      logger,
      randomPassword: () => randomBytes(RANDOM_PASSWORD_BYTES).toString('base64url'),
    };

    const result = await runSeed({
      model,
      registry,
      ...(options.forum !== undefined ? { forumId: options.forum } : {}),
      dryRun: options.dryRun,
      deps,
    });

    streams.stdout.write(`${result.report}\n`);
    return result.exitStatus === 1 ? EXIT_RESOURCE_FAILURE : EXIT_OK;
  } catch (error) {
    return reportError(error, streams.stderr);
  }
}

/**
 * Parse argv into {@link SeedOptions} with commander.
 *
 * commander is configured to throw (`exitOverride`) instead of calling
 * `process.exit`, and to write help and errors to the injected streams, so
 * parsing stays testable. The metadata default falls back to
 * `$COMMUNITY_HUB_METADATA` then {@link DEFAULT_METADATA}.
 *
 * @throws CommanderError on a usage error, `--help` or `--version`.
 */
function parseArgs(argv: readonly string[], streams: SeedStreams): SeedOptions {
  const program = new Command();
  program
    .name('community-hub-seed')
    .description('Reconcile forum configuration from a Community Hub metadata file.')
    .option(
      '--metadata <path>',
      'path to the metadata YAML file',
      process.env.COMMUNITY_HUB_METADATA ?? DEFAULT_METADATA,
    )
    .option('--forum <id>', 'reconcile only the forum with this id')
    .option('--dry-run', 'plan without mutating; print the plan and exit', false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({
      writeOut: (str) => void streams.stdout.write(str),
      writeErr: (str) => void streams.stderr.write(str),
    });

  program.parse(argv);
  const opts = program.opts<{ metadata: string; forum?: string; dryRun: boolean }>();

  if (opts.metadata.length === 0) {
    throw new InvalidArgumentError('--metadata must not be empty');
  }

  return {
    metadata: opts.metadata,
    ...(opts.forum !== undefined ? { forum: opts.forum } : {}),
    dryRun: opts.dryRun,
  };
}

/**
 * Print a typed error and return its exit code.
 *
 * Config-class errors ({@link MetadataValidationError}, {@link UnknownForumError},
 * {@link SecretResolutionError}) map to exit `2`; anything else maps to exit
 * `1`. Only `error.message` (identifiers and reasons, never secret values) is
 * printed, unless `DEBUG=community-hub`, in which case the full stack is shown.
 */
function reportError(error: unknown, stderr: Pick<NodeJS.WritableStream, 'write'>): number {
  const debug = process.env.DEBUG === DEBUG_VALUE;

  if (
    error instanceof MetadataValidationError ||
    error instanceof UnknownForumError ||
    error instanceof SecretResolutionError
  ) {
    stderr.write(`${debug && error.stack !== undefined ? error.stack : error.message}\n`);
    return EXIT_CONFIG_ERROR;
  }

  if (error instanceof Error) {
    stderr.write(`${debug && error.stack !== undefined ? error.stack : error.message}\n`);
    return EXIT_RESOURCE_FAILURE;
  }

  stderr.write(`${String(error)}\n`);
  return EXIT_RESOURCE_FAILURE;
}

/**
 * Whether this module is the process entry point (`node dist/bin/seed.js`), as
 * opposed to being imported by a test. Guards the auto-run so tests can import
 * {@link main} without launching a real run.
 */
function isMainModule(): boolean {
  return require.main === module;
}

if (isMainModule()) {
  void main(process.argv, { stdout: process.stdout, stderr: process.stderr }).then((code) => {
    process.exitCode = code;
  });
}
