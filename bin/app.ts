#!/usr/bin/env node
/**
 * CDK application entry point.
 *
 * Loads one Metadata_File, resolves every forum's engine through the default
 * {@link createDefaultRegistry | registry}, and builds exactly one
 * {@link EnvironmentStack} for the Environment it describes. The stack's
 * `env.account` comes from `CDK_DEFAULT_ACCOUNT` and its `env.region` from the
 * metadata, so no account or region literal ever appears here (Req 3.1).
 *
 * The metadata path is taken from the CDK context (`-c metadata=<path>`, the
 * form the justfile and `npx cdk` pass), falling back to the
 * `COMMUNITY_HUB_METADATA` environment variable and then `metadata/example.yaml`.
 *
 * Error handling follows the design's exit-code table: a
 * {@link MetadataValidationError} or {@link HostedZoneMismatchError} prints its
 * issues to stderr and exits 2 (Req 1.4, 12.6); any other failure — including a
 * failed hosted-zone lookup at synth (Req 12.7) — exits 1. Full stack traces are
 * printed only when `DEBUG=community-hub`; otherwise just the message(s) are
 * shown.
 */

import { App } from 'aws-cdk-lib';

import { createDefaultRegistry } from '../src/engines/registry.js';
import { loadMetadataFile } from '../src/metadata/loader.js';
import { MetadataValidationError } from '../src/metadata/errors.js';
import { HostedZoneMismatchError } from '../src/shared/errors.js';
import { EnvironmentStack } from '../src/infra/environment-stack.js';
import { names } from '../src/infra/naming.js';

/** The context key the CLI and justfile use to pass the metadata path. */
const METADATA_CONTEXT_KEY = 'metadata';

/** Exit code for a configuration error the operator must fix (Req 1.4, 12.6). */
const EXIT_CONFIG_ERROR = 2;

/** Exit code for any other, unexpected failure. */
const EXIT_UNEXPECTED_ERROR = 1;

/**
 * Resolve the metadata path from CDK context, then the environment, then the
 * committed example.
 *
 * @param app - The CDK app whose context is consulted first.
 * @returns The metadata file path to load.
 */
function resolveMetadataPath(app: App): string {
  const fromContext: unknown = app.node.tryGetContext(METADATA_CONTEXT_KEY);
  if (typeof fromContext === 'string' && fromContext.length > 0) {
    return fromContext;
  }
  const fromEnv = process.env.COMMUNITY_HUB_METADATA;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return 'metadata/example.yaml';
}

/**
 * Build the CDK app: load metadata, construct the single Environment stack and
 * synthesize. Throws on any failure; {@link run} maps the throw to an exit code.
 */
function build(): void {
  const app = new App();
  const metadataPath = resolveMetadataPath(app);
  const registry = createDefaultRegistry();
  const model = loadMetadataFile(metadataPath, registry);
  const environment = model.environment;

  const account = process.env.CDK_DEFAULT_ACCOUNT;

  // `route53-existing` performs a synth-time HostedZone.fromLookup, which needs
  // a concrete account. Fail early with a clear, actionable message rather than
  // letting the lookup produce a confusing error later (Req 12.7).
  if (environment.dnsMode === 'route53-existing' && (account === undefined || account === '')) {
    throw new Error(
      `dnsMode 'route53-existing' requires a concrete AWS account for the hosted-zone lookup, ` +
        `but CDK_DEFAULT_ACCOUNT is not set. Configure credentials (for example 'aws sso login') ` +
        `so the account is available at synth.`,
    );
  }

  // Under exactOptionalPropertyTypes, `account` is only present when set; an
  // unset account is left off so CDK treats it as an environment-agnostic stack.
  const env =
    account === undefined
      ? { region: environment.region }
      : { account, region: environment.region };

  new EnvironmentStack(app, names.stack(environment.name), {
    model,
    registry,
    env,
  });

  app.synth();
}

/**
 * Print an error to stderr, respecting the `DEBUG=community-hub` toggle for full
 * stack traces.
 *
 * @param error - The thrown value to report.
 */
function reportError(error: unknown): void {
  const debug = process.env.DEBUG === 'community-hub';
  if (debug && error instanceof Error && error.stack !== undefined) {
    process.stderr.write(`${error.stack}\n`);
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
}

/**
 * Run the CDK app and map failures to the design's exit codes.
 *
 * - {@link MetadataValidationError} / {@link HostedZoneMismatchError} → exit 2.
 * - Any other error → exit 1.
 */
function run(): void {
  try {
    build();
  } catch (error: unknown) {
    reportError(error);
    if (error instanceof MetadataValidationError || error instanceof HostedZoneMismatchError) {
      process.exitCode = EXIT_CONFIG_ERROR;
      return;
    }
    process.exitCode = EXIT_UNEXPECTED_ERROR;
  }
}

run();
