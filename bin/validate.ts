#!/usr/bin/env node
/**
 * `validate` entry point: load and validate a metadata file, print the result.
 *
 * Backs the `just validate` recipe. Takes the metadata path as a positional
 * argument, defaulting to `$COMMUNITY_HUB_METADATA` and then
 * `metadata/example.yaml`, loads it with {@link loadMetadataFile} and the
 * default engine registry, and reports the outcome:
 *
 * - On success, prints `OK <path>: <n> forums` to stdout and returns 0.
 * - On {@link MetadataValidationError}, prints each issue as
 *   `<field path>: <reason>` to stderr (issues are already sorted by path by
 *   the loader; that order is preserved) and returns 2. Only paths and reasons
 *   are printed, never field values.
 * - On any other error, returns 1.
 *
 * This performs no AWS calls and resolves no secrets.
 */

import { join } from 'node:path';

import { createDefaultRegistry } from '../src/engines/registry.js';
import { MetadataValidationError } from '../src/metadata/errors.js';
import { loadMetadataFile } from '../src/metadata/loader.js';

/** Default metadata file when no path is given and `$COMMUNITY_HUB_METADATA` is unset. */
const DEFAULT_METADATA = join('metadata', 'example.yaml');

/** The output streams the CLI writes to, injected so tests can capture them. */
interface Io {
  readonly stdout: { write(text: string): void };
  readonly stderr: { write(text: string): void };
}

/**
 * Run the metadata validation CLI and return the process exit code.
 *
 * Resolves the metadata path from the first positional argument (after
 * `node` and the script path in `argv`), then `$COMMUNITY_HUB_METADATA`, then
 * {@link DEFAULT_METADATA}. Loads and validates the file with the default
 * engine registry, writing a success line to `io.stdout` or each validation
 * issue to `io.stderr`.
 *
 * @param argv - Process argv (`argv[2]` is the optional metadata path).
 * @param io - The stdout and stderr sinks to write to.
 * @returns 0 on success, 2 on a metadata validation failure, 1 on any other error.
 */
export function main(argv: readonly string[], io: Io): number {
  const path = argv[2] ?? process.env.COMMUNITY_HUB_METADATA ?? DEFAULT_METADATA;

  try {
    const model = loadMetadataFile(path, createDefaultRegistry());
    io.stdout.write(`OK ${path}: ${String(model.forums.length)} forums\n`);
    return 0;
  } catch (error) {
    if (error instanceof MetadataValidationError) {
      for (const issue of error.issues) {
        io.stderr.write(`${issue.path}: ${issue.message}\n`);
      }
      return 2;
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr.write(`${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv, { stdout: process.stdout, stderr: process.stderr }));
}
