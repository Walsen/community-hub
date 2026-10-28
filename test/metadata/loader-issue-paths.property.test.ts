import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { MetadataValidationError } from '../../src/metadata/errors.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import { DMARC_POLICIES, DNS_MODES } from '../../src/metadata/schema.js';
import { rawMetadataDocument, toYaml, type RawMetadataDocument } from '../support/arbitraries.js';
import { createTestEngine } from '../support/testengine.js';

/**
 * Property 2: Validation issues carry the mutated field path.
 *
 * Validates: Requirements 1.4, 1.6, 11.6
 *
 * Start from a VALID raw document D (from {@link rawMetadataDocument}), apply a
 * single invalidating mutation M that introduces one specific invalid field at
 * a known path P, then assert that `loadMetadata(toYaml(M(D)), registry)`:
 *  - throws a {@link MetadataValidationError} (Req 1.4 — each violation is
 *    reported; the loader does not silently accept the document);
 *  - whose `issues` include one whose path is (or is under) P — the issue
 *    carries the mutated field path (Req 1.4);
 *  - for an unknown engine, an issue message names the offending engine id
 *    (Req 1.6);
 *  - for an invalid `dmarcPolicy`, an issue is reported at the policy field
 *    path (Req 11.6);
 *  - never echoes an injected placeholder secret value in the error (Req 1.4 /
 *    the security steering: secret-bearing fields never contribute their value
 *    to an issue).
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x1554e_9a7;

/** The `testengine`-only registry the loader validates against. */
const registry = new EngineRegistry([createTestEngine()]);

/**
 * An obvious placeholder secret VALUE (not a Secret_Reference). It must never
 * appear anywhere in the thrown error: not in the message, not in any issue.
 */
const INLINE_SECRET_VALUE = 'plaintext-do-not-echo-this-secret-value';

/** A recursively mutable view of a type, for in-place mutation of a clone. */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer E)[]
    ? Mutable<E>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

/** A deep-writable clone of a raw document, with room for an unknown extra key. */
type MutableDocument = Mutable<RawMetadataDocument> & Record<string, unknown>;

/** A mutation applied to a valid document, plus the path it should surface. */
interface Mutator {
  /** Human-readable label for failure diagnostics. */
  readonly label: string;
  /**
   * Mutate a deep clone of the document in place and return the expected path
   * (document-absolute, as `formatPath` renders it). Mutators that depend on a
   * forum index receive one chosen by fast-check.
   */
  readonly mutate: (doc: MutableDocument, forumIndex: number) => string;
  /** Optional extra assertion on the thrown error (e.g. message content). */
  readonly extra?: (error: MetadataValidationError, expectedPath: string) => void;
}

/** True when any issue sits exactly at, or under, the expected path. */
function hasIssueAt(error: MetadataValidationError, expectedPath: string): boolean {
  return error.issues.some(
    (issue) => issue.path === expectedPath || issue.path.startsWith(`${expectedPath}.`),
  );
}

const MUTATORS: readonly Mutator[] = [
  {
    label: 'invalid environment.dnsMode (legacy lightsail)',
    mutate: (doc): string => {
      doc.environment.dnsMode = 'lightsail' as (typeof DNS_MODES)[number];
      return 'environment.dnsMode';
    },
  },
  {
    label: 'invalid environment.dmarcPolicy',
    mutate: (doc): string => {
      doc.environment.dmarcPolicy = 'block-everything' as (typeof DMARC_POLICIES)[number];
      return 'environment.dmarcPolicy';
    },
  },
  {
    label: 'unknown forum engine id',
    mutate: (doc, forumIndex): string => {
      const forum = doc.forums[forumIndex]!;
      forum.engine = 'nonexistentengine';
      return `forums[${String(forumIndex)}].engine`;
    },
    extra: (error): void => {
      // Req 1.6: the message names the unsupported engine identifier.
      expect(error.message).toContain('nonexistentengine');
    },
  },
  {
    label: 'inline (non-reference) forum secret',
    mutate: (doc, forumIndex): string => {
      const forum = doc.forums[forumIndex]!;
      forum.secrets.adminPassword = INLINE_SECRET_VALUE;
      return `forums[${String(forumIndex)}].secrets.adminPassword`;
    },
    extra: (error): void => {
      // Req 1.4 / security: the placeholder value is never echoed anywhere.
      expect(error.message).not.toContain(INLINE_SECRET_VALUE);
      for (const issue of error.issues) {
        expect(issue.path).not.toContain(INLINE_SECRET_VALUE);
        expect(issue.message).not.toContain(INLINE_SECRET_VALUE);
      }
    },
  },
  {
    label: 'invalid environment.snapshotTimeUtc (not on the hour)',
    mutate: (doc): string => {
      doc.environment.snapshotTimeUtc = '06:30';
      return 'environment.snapshotTimeUtc';
    },
  },
  {
    label: 'ssh CIDR with a /0 prefix',
    mutate: (doc): string => {
      const index = doc.environment.sshAllowedCidrs.length;
      doc.environment.sshAllowedCidrs.push('0.0.0.0/0');
      return `environment.sshAllowedCidrs[${String(index)}]`;
    },
  },
  {
    label: 'unknown top-level key (legacy smtp block)',
    mutate: (doc): string => {
      doc.smtp = { host: 'smtp.example.org' };
      // A strict-object unrecognized key is reported at the object that carries
      // it (the document root here); the rejected key name appears in the
      // message, which the `extra` hook asserts.
      return '<root>';
    },
    extra: (error): void => {
      expect(error.message).toContain('smtp');
    },
  },
  {
    label: 'missing required field environment.region',
    mutate: (doc): string => {
      delete (doc.environment as { region?: string }).region;
      return 'environment.region';
    },
  },
];

describe('Property 2: Validation issues carry the mutated field path', () => {
  it('rejects a single mutation and reports an issue at the mutated path', () => {
    fc.assert(
      fc.property(
        rawMetadataDocument,
        fc.nat(),
        fc.nat({ max: MUTATORS.length - 1 }),
        (doc, forumSeed, mutatorIndex) => {
          const mutator = MUTATORS[mutatorIndex]!;
          const forumIndex = doc.forums.length === 0 ? 0 : forumSeed % doc.forums.length;

          // Mutate a deep clone so the generated (valid) document is untouched.
          const mutated = structuredClone(doc) as unknown as MutableDocument;
          const expectedPath = mutator.mutate(mutated, forumIndex);

          let thrown: unknown;
          try {
            loadMetadata(toYaml(mutated), registry);
          } catch (error) {
            thrown = error;
          }

          // A MetadataValidationError must be thrown (Req 1.4).
          expect(thrown, `mutation "${mutator.label}" should be rejected`).toBeInstanceOf(
            MetadataValidationError,
          );
          const error = thrown as MetadataValidationError;

          // An issue must carry the mutated field path (Req 1.4).
          expect(
            hasIssueAt(error, expectedPath),
            `mutation "${mutator.label}" expected an issue at '${expectedPath}', got: ${error.issues
              .map((i) => i.path)
              .join(', ')}`,
          ).toBe(true);

          mutator.extra?.(error, expectedPath);
        },
      ),
      { seed: SEED, numRuns: 400 },
    );
  });
});
