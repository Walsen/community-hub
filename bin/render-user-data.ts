#!/usr/bin/env node
/**
 * `render:user-data` entry point: render every forum's user-data scripts to
 * `cdk.out/user-data/` so `just shellcheck` can lint the real bash.
 *
 * Loads the metadata file named by `$COMMUNITY_HUB_METADATA` (default
 * `metadata/example.yaml`) with {@link loadMetadataFile} and the default engine
 * registry, then {@link renderAllUserData} produces the install and
 * email-refresh scripts. Each script is written to `cdk.out/user-data/` as a
 * `0644` file after the directory is recreated from scratch, and the rendered
 * file names are printed.
 *
 * This is the only I/O here; the rendering itself is pure. No secret values are
 * written: the rendered scripts carry Secret_References only. A metadata
 * validation failure is reported to stderr and exits with code 2.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createDefaultRegistry } from '../src/engines/registry.js';
import { renderAllUserData } from '../src/infra/user-data/render.js';
import { loadMetadataFile } from '../src/metadata/loader.js';
import { MetadataValidationError } from '../src/metadata/errors.js';

/** Directory the rendered scripts are written to, recreated on every run. */
const OUTPUT_DIR = join('cdk.out', 'user-data');

/** Default metadata file when `$COMMUNITY_HUB_METADATA` is unset. */
const DEFAULT_METADATA = join('metadata', 'example.yaml');

function main(): void {
  const metadataPath = process.env.COMMUNITY_HUB_METADATA ?? DEFAULT_METADATA;
  const registry = createDefaultRegistry();
  const model = loadMetadataFile(metadataPath, registry);
  const scripts = renderAllUserData(model, registry);

  // Recreate the output directory so stale scripts from an earlier metadata
  // file never linger and get linted.
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const { fileName, script } of scripts) {
    writeFileSync(join(OUTPUT_DIR, fileName), script, { mode: 0o644 });
    process.stdout.write(`${join(OUTPUT_DIR, fileName)}\n`);
  }
}

try {
  main();
} catch (error) {
  if (error instanceof MetadataValidationError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  throw error;
}
