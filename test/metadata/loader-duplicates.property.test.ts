import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { MetadataValidationError } from '../../src/metadata/errors.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import {
  rawMetadataDocument,
  toYaml,
  type RawForum,
  type RawMetadataDocument,
} from '../support/arbitraries.js';
import { createTestEngine } from '../support/testengine.js';

/**
 * Property 3: Duplicate forum ids and subdomains are rejected.
 *
 * Validates: Requirements 1.5
 *
 * Starting from a VALID raw document with at least two forums, forcing two
 * forums to share the same `id` (Mutation A) or the same `subdomain`
 * (Mutation B) makes {@link loadMetadata} reject the document with a
 * {@link MetadataValidationError} whose issues include one that both names the
 * duplicated value and points at the colliding field of the second occurrence
 * (`forums[b].id` / `forums[b].subdomain`).
 *
 * The test asserts the duplicate issue is PRESENT (`.some(...)`) rather than
 * asserting an exact issue set: copying one forum's id onto another also moves
 * that forum's own secret references out of its (new) prefix, so the loader may
 * legitimately report additional issues. Those do not concern this property.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x53ed03;

/** The `testengine`-only registry the loader validates against. */
const registry = new EngineRegistry([createTestEngine()]);

/**
 * A valid document with at least two forums, together with a distinct ordered
 * pair of forum indices `(a, b)` (both valid, `a !== b`) chosen by fast-check.
 * The collision is applied to forum `b` using forum `a`'s value, so the loader
 * reports the duplicate on the later (higher-index) occurrence.
 */
const documentWithIndexPair: fc.Arbitrary<{
  readonly doc: RawMetadataDocument;
  readonly a: number;
  readonly b: number;
}> = rawMetadataDocument
  .filter((doc) => doc.forums.length >= 2)
  .chain((doc) => {
    const n = doc.forums.length;
    return fc
      .tuple(fc.integer({ min: 0, max: n - 1 }), fc.integer({ min: 0, max: n - 1 }))
      .filter(([a, b]) => a !== b)
      .map(([a, b]) => ({ doc, a, b }));
  });

/** Replace forum at `index` with a copy carrying overridden fields. */
function withForumOverride(
  doc: RawMetadataDocument,
  index: number,
  override: Partial<RawForum>,
): RawMetadataDocument {
  const forums = doc.forums.map((forum, i) =>
    i === index ? ({ ...forum, ...override } satisfies RawForum) : forum,
  );
  return { ...doc, forums };
}

/**
 * Load `doc`, expecting a {@link MetadataValidationError}, and return its
 * issues. Fails the property if the loader does not throw that error.
 */
function loadExpectingError(doc: RawMetadataDocument): MetadataValidationError['issues'] {
  try {
    loadMetadata(toYaml(doc), registry);
  } catch (error) {
    expect(error).toBeInstanceOf(MetadataValidationError);
    return (error as MetadataValidationError).issues;
  }
  throw new Error('expected loadMetadata to throw MetadataValidationError');
}

describe('Property 3: Duplicate forum ids and subdomains are rejected', () => {
  it('rejects a duplicated forum id, naming the value at the second occurrence (Req 1.5)', () => {
    fc.assert(
      fc.property(documentWithIndexPair, ({ doc, a, b }) => {
        const sharedId = doc.forums[a]!.id;
        const mutated = withForumOverride(doc, b, { id: sharedId });

        const issues = loadExpectingError(mutated);

        // Two forums now share the value; the loader reports the repeat on the
        // later of the two occurrences in document order.
        const second = Math.max(a, b);
        expect(
          issues.some(
            (issue) => issue.path === `forums[${second}].id` && issue.message.includes(sharedId),
          ),
        ).toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('rejects a duplicated subdomain, naming the value at the second occurrence (Req 1.5)', () => {
    fc.assert(
      fc.property(documentWithIndexPair, ({ doc, a, b }) => {
        const sharedSubdomain = doc.forums[a]!.subdomain;
        const mutated = withForumOverride(doc, b, { subdomain: sharedSubdomain });

        const issues = loadExpectingError(mutated);

        // Two forums now share the value; the loader reports the repeat on the
        // later of the two occurrences in document order.
        const second = Math.max(a, b);
        expect(
          issues.some(
            (issue) =>
              issue.path === `forums[${second}].subdomain` &&
              issue.message.includes(sharedSubdomain),
          ),
        ).toBe(true);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
