/**
 * Shellcheck lint of every rendered user-data script.
 *
 * Renders both forums' install and email-refresh scripts with
 * {@link renderAllUserData} for `metadata/example.yaml` — the exact rendering
 * the `render:user-data` CLI uses, so this test and `just shellcheck` stay in
 * agreement — and runs `shellcheck -s bash -` on each, piping the script via
 * stdin so no temporary files are written. A script is correct only when
 * shellcheck exits 0 with no findings; on failure the assertion message carries
 * shellcheck's own output so a regression is debuggable.
 *
 * `shellcheck` is a local binary provided by Devbox, not a network dependency,
 * so this stays offline and deterministic. When it is not on `PATH` (a bare
 * `npm test` outside Devbox) the test skips with a clear note rather than
 * failing — unless `CI=true`, where a missing linter must fail instead of being
 * silently skipped.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDefaultRegistry } from '../../../src/engines/registry.js';
import { loadMetadataFile } from '../../../src/metadata/loader.js';
import { renderAllUserData } from '../../../src/infra/user-data/render.js';

/** Path to the committed example metadata, relative to this test file. */
const EXAMPLE_METADATA = join(__dirname, '..', '..', '..', 'metadata', 'example.yaml');

/** Message shown when the linter is absent and the suite runs outside Devbox. */
const SHELLCHECK_MISSING = 'shellcheck not found; run inside Devbox or use just shellcheck';

/**
 * Detect whether `shellcheck` is on `PATH`. A clean run of `--version` (exit 0)
 * means available; an ENOENT spawn error means absent. Any other failure is
 * treated as unavailable so a broken binary skips rather than wedges the suite.
 */
function shellcheckAvailable(): boolean {
  const probe = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' });
  return probe.error === undefined && probe.status === 0;
}

const available = shellcheckAvailable();
const inCi = process.env.CI === 'true';

const registry = createDefaultRegistry();
const model = loadMetadataFile(EXAMPLE_METADATA, registry);
const scripts = renderAllUserData(model, registry);

describe('rendered user-data scripts pass shellcheck', () => {
  // A missing linter outside CI is a skip, not a failure, so `npm test` stays
  // runnable without Devbox. Inside CI the absence must surface as a failure.
  if (inCi) {
    it('shellcheck is available in CI', () => {
      expect(available, SHELLCHECK_MISSING).toBe(true);
    });
  }

  it('renders install and refresh scripts for every forum', () => {
    // Two scripts per forum (install + refresh); guards against an empty render
    // silently passing the lint loop below.
    expect(scripts).toHaveLength(model.forums.length * 2);
  });

  it.skipIf(!available).each(scripts)('$fileName has no shellcheck findings', ({ script }) => {
    const result = spawnSync('shellcheck', ['-s', 'bash', '-'], {
      input: script,
      encoding: 'utf8',
    });

    expect(result.error, `failed to run shellcheck: ${String(result.error)}`).toBeUndefined();
    expect(result.status, `shellcheck reported findings:\n${result.stdout}${result.stderr}`).toBe(
      0,
    );
  });

  if (!available && !inCi) {
    it.skip(`skipped: ${SHELLCHECK_MISSING}`, () => {
      // Placeholder so a skipped run reports why, outside Devbox.
    });
  }
});
