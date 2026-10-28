/**
 * Unit tests for the metadata validation CLI (`bin/validate.ts`).
 *
 * Each test calls {@link main} with a captured stdout/stderr pair (sinks whose
 * `write` collects into arrays) so no output reaches the real process streams,
 * and asserts the exit code and captured text. Cases cover:
 *
 *  - the committed `metadata/example.yaml` loads (exit 0, an `OK` line with the
 *    forum count);
 *  - an invalid fixture reports every field-path issue to stderr in sorted path
 *    order (exit 2);
 *  - an inline-secret fixture never echoes its placeholder value (exit 2);
 *  - a YAML syntax error is reported by line and column without quoting the
 *    offending source text (exit 2).
 *
 * Secret-bearing fixtures use only the obvious placeholder `test-secret-value`.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { main } from '../../bin/validate.js';

/** A write sink that collects everything written, for asserting on CLI output. */
class CaptureStream {
  /** Every chunk passed to {@link CaptureStream.write}, in write order. */
  readonly chunks: string[] = [];

  /** Collect a chunk. Mirrors the `{ write(text: string): void }` shape the CLI expects. */
  write(text: string): void {
    this.chunks.push(text);
  }

  /** The concatenated output written so far. */
  text(): string {
    return this.chunks.join('');
  }

  /** The output split into non-empty lines, trailing newlines removed. */
  lines(): string[] {
    return this.text()
      .split('\n')
      .filter((line) => line.length > 0);
  }
}

/** Build the `argv` the CLI expects (`[node, script, <path>]`) for a fixture path. */
function argvFor(path: string): readonly string[] {
  return ['node', 'bin/validate.ts', path];
}

/** Absolute path to a fixture under `test/fixtures/metadata/`. */
function fixture(name: string): string {
  return join(__dirname, '..', 'fixtures', 'metadata', name);
}

/** The committed example metadata, resolved from the workspace root (test cwd). */
const EXAMPLE_METADATA = join('metadata', 'example.yaml');

/** The obvious placeholder secret embedded in `inline-secret.yaml`. */
const INLINE_SECRET = 'test-secret-value';

/** Run the CLI against a path with fresh capture sinks. */
function run(path: string): { code: number; out: CaptureStream; err: CaptureStream } {
  const out = new CaptureStream();
  const err = new CaptureStream();
  const code = main(argvFor(path), { stdout: out, stderr: err });
  return { code, out, err };
}

describe('validate CLI main', () => {
  it('validates the committed example metadata (exit 0, OK line with forum count)', () => {
    const { code, out, err } = run(EXAMPLE_METADATA);

    expect(code).toBe(0);
    expect(err.text()).toBe('');

    const line = out.text();
    expect(line).toContain('OK');
    expect(line).toContain(EXAMPLE_METADATA);
    // The example ships with two forums; the success line reports that count.
    expect(line).toContain('2 forums');
  });

  it('reports every field-path issue to stderr in sorted path order (exit 2)', () => {
    const { code, out, err } = run(fixture('invalid-multi.yaml'));

    expect(code).toBe(2);
    expect(out.text()).toBe('');

    const lines = err.lines();
    // The three broken fields are each reported, one issue per line.
    const paths = lines.map((line) => line.slice(0, line.indexOf(':')));
    expect(paths).toContain('environment.dmarcPolicy');
    expect(paths).toContain('environment.dnsMode');
    expect(paths).toContain('environment.sshAllowedCidrs[0]');

    // Issues are emitted in sorted path order (the loader sorts by path).
    expect(paths).toEqual([...paths].sort());
    expect(paths).toEqual([
      'environment.dmarcPolicy',
      'environment.dnsMode',
      'environment.sshAllowedCidrs[0]',
    ]);

    // Every line is a `<path>: <reason>` pair.
    for (const line of lines) {
      expect(line).toMatch(/^[^:]+: .+/);
    }
  });

  it('never echoes an inline secret placeholder value (exit 2)', () => {
    const { code, out, err } = run(fixture('inline-secret.yaml'));

    expect(code).toBe(2);
    expect(out.text()).toBe('');

    // The offending field is named...
    const paths = err.lines().map((line) => line.slice(0, line.indexOf(':')));
    expect(paths).toContain('forums[0].secrets.adminPassword');

    // ...but the placeholder secret value never appears anywhere in output.
    expect(err.text()).not.toContain(INLINE_SECRET);
    expect(out.text()).not.toContain(INLINE_SECRET);
  });

  it('reports a YAML syntax error by line and column without quoting source (exit 2)', () => {
    const { code, out, err } = run(fixture('syntax-error.yaml'));

    expect(code).toBe(2);
    expect(out.text()).toBe('');

    const message = err.text();
    // Position is reported...
    expect(message).toMatch(/line \d+, column \d+/);
    // ...without quoting the offending source content.
    expect(message).not.toContain('community-test');
    expect(message).not.toContain('environment');
  });
});
