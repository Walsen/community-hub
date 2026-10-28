/**
 * Metadata validation errors.
 *
 * This module defines the single error type the Metadata_Loader throws when a
 * metadata document fails validation, plus the issue shape and path formatter
 * shared by the schema, cross-field and adapter validation layers.
 *
 * Messages carry field paths and human-readable reasons only. They must never
 * include secret values or quoted source YAML, so that logs and CLI output
 * stay free of sensitive data (see the security steering).
 */

/**
 * A single validation problem, located by its path within the metadata
 * document. The {@link ValidationIssue.message | message} explains the reason
 * and never contains a secret value or raw source text.
 */
export interface ValidationIssue {
  /** Dotted/indexed path to the offending field, e.g. `forums[1].engine`. */
  readonly path: string;
  /** Human-readable reason. Never a secret value or quoted source YAML. */
  readonly message: string;
}

/**
 * A single segment of a validation path: an object key (string) or an array
 * index (number).
 */
export type PathSegment = string | number;

/**
 * Formats path segments into a stable, human-readable path string.
 *
 * String segments are joined with dots and numeric segments become bracketed
 * indices, so `['forums', 1, 'secrets', 'adminPassword']` becomes
 * `forums[1].secrets.adminPassword`. A leading numeric index is rendered as
 * `[0]` and an empty segment list yields the root marker `<root>`.
 *
 * @param segments - Path segments from the root of the document to the field.
 * @returns The formatted path string.
 */
export function formatPath(segments: readonly PathSegment[]): string {
  if (segments.length === 0) {
    return '<root>';
  }

  let path = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      path += `[${String(segment)}]`;
    } else if (path === '') {
      path = segment;
    } else {
      path += `.${segment}`;
    }
  }
  return path;
}

/** Orders two issues by path, then by message, for a deterministic report. */
function compareIssues(a: ValidationIssue, b: ValidationIssue): number {
  if (a.path !== b.path) {
    return a.path < b.path ? -1 : 1;
  }
  if (a.message !== b.message) {
    return a.message < b.message ? -1 : 1;
  }
  return 0;
}

/**
 * Thrown when a metadata document fails validation. Collects every issue
 * (validation is not fail-fast) sorted by path, and builds a message that
 * lists each path and reason only.
 */
export class MetadataValidationError extends Error {
  /** All validation issues, sorted by path then message. */
  readonly issues: readonly ValidationIssue[];

  /**
   * @param issues - The validation issues to report. Sorted on construction; a
   *   defensive copy is taken so the caller's array is never mutated.
   */
  constructor(issues: readonly ValidationIssue[]) {
    const sorted = [...issues].sort(compareIssues);
    super(MetadataValidationError.buildMessage(sorted));
    this.name = 'MetadataValidationError';
    this.issues = sorted;
    // Restore the prototype chain for instanceof across compiled targets.
    Object.setPrototypeOf(this, MetadataValidationError.prototype);
  }

  /** Builds a message listing paths and reasons only, one issue per line. */
  private static buildMessage(issues: readonly ValidationIssue[]): string {
    const count = issues.length;
    const header =
      count === 1
        ? 'Metadata validation failed with 1 issue:'
        : `Metadata validation failed with ${String(count)} issues:`;
    const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
    return [header, ...lines].join('\n');
  }
}
