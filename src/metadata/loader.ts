/**
 * The Metadata_Loader: the only code in the codebase that parses metadata YAML.
 *
 * {@link loadMetadata} is pure over its inputs — it reads no clock, no
 * randomness and no environment, so the validated model depends only on
 * `(text, registry)`. It parses YAML, validates the shape with the Zod
 * {@link MetadataSchema}, runs {@link validateCrossField} for the whole-document
 * and adapter-driven rules, aggregates every issue into a single
 * {@link MetadataValidationError} (never fail-fast), and deep-freezes the result
 * so downstream consumers cannot mutate it.
 *
 * {@link loadMetadataFile} is the single place that reads a YAML file from disk;
 * it does the I/O and then delegates to {@link loadMetadata}.
 *
 * Messages carry field paths and reasons only. YAML parse errors are reported
 * by error code and position without quoting source text, and secret-bearing
 * fields never contribute their value to an issue (see the security steering).
 */

import { readFileSync } from 'node:fs';

import { parseDocument } from 'yaml';

import { formatPath, MetadataValidationError, type ValidationIssue } from './errors.js';
import { MetadataSchema, type ValidatedModel } from './schema.js';
import { validateCrossField } from './validate.js';
import type { EngineRegistry } from '../engines/registry.js';

/**
 * Parse and fully validate a metadata document from its YAML text.
 *
 * YAML is parsed with duplicate-key detection on. A YAML parse failure is
 * reported as one or more issues by error code and line/column only (never
 * quoting source), and validation stops before schema checks. Otherwise the
 * document is validated by {@link MetadataSchema}; on success the cross-field
 * and adapter rules run via {@link validateCrossField}. All issues are
 * collected and, if any exist, thrown as a single {@link MetadataValidationError}
 * (sorted by path). On success the model is deep-frozen and returned.
 *
 * This function is pure: it performs no I/O and reads no clock, randomness or
 * environment, so the result depends only on `(text, registry)`.
 *
 * @param text - The raw metadata YAML.
 * @param registry - The Engine_Registry used to resolve each forum's engine.
 * @returns The validated, expanded and deep-frozen metadata model.
 * @throws MetadataValidationError if the document fails to parse or validate.
 */
export function loadMetadata(text: string, registry: EngineRegistry): ValidatedModel {
  const doc = parseDocument(text, { uniqueKeys: true });

  // If the YAML itself did not parse, report each syntax error by code and
  // position and stop; schema validation on a broken document is meaningless.
  if (doc.errors.length > 0) {
    const issues: ValidationIssue[] = doc.errors.map((error) => {
      const linePos = error.linePos?.[0];
      const position =
        linePos === undefined
          ? error.code
          : `${error.code} at line ${String(linePos.line)}, column ${String(linePos.col)}`;
      return { path: formatPath([]), message: position };
    });
    throw new MetadataValidationError(issues);
  }

  const parsed: unknown = doc.toJS();

  const result = MetadataSchema.safeParse(parsed);
  if (!result.success) {
    // Map Zod issues to ValidationIssues. The message is Zod's own message
    // (a static one for secret fields); the offending value is never included.
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: formatPath(
        issue.path.map((segment) => (typeof segment === 'number' ? segment : String(segment))),
      ),
      message: issue.message,
    }));
    throw new MetadataValidationError(issues);
  }

  // Shape is valid; run the whole-document and adapter-driven checks.
  const issues = validateCrossField(result.data, registry);
  if (issues.length > 0) {
    throw new MetadataValidationError(issues);
  }

  return deepFreeze(result.data);
}

/**
 * Load and validate a metadata document from a file on disk.
 *
 * This is the only function in the codebase that reads a YAML file. It performs
 * the file I/O and then delegates to {@link loadMetadata}, which stays pure over
 * its inputs.
 *
 * @param path - Filesystem path to the metadata YAML file.
 * @param registry - The Engine_Registry used to resolve each forum's engine.
 * @returns The validated, expanded and deep-frozen metadata model.
 * @throws MetadataValidationError if the document fails to parse or validate.
 */
export function loadMetadataFile(path: string, registry: EngineRegistry): ValidatedModel {
  const text = readFileSync(path, 'utf8');
  return loadMetadata(text, registry);
}

/**
 * Recursively freeze an object graph (objects and arrays) in place and return
 * it, so the validated model cannot be mutated by any consumer.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
