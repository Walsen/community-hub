import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { MetadataValidationError } from '../../src/metadata/errors.js';
import { bundleRamMb, LIGHTSAIL_BUNDLES } from '../../src/metadata/bundles.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import { rawMetadataDocument, toYaml, type RawMetadataDocument } from '../support/arbitraries.js';
import { createTestEngine } from '../support/testengine.js';

/**
 * Property 6: Minimum RAM enforcement.
 *
 * Validates: Requirements 4.5
 *
 * Each Engine_Adapter declares a minimum RAM. A forum's Bundle_Size maps to a
 * RAM amount via the Lightsail bundle table. The Metadata_Loader must enforce
 * the rule per forum:
 *  - WHEN the bundle's RAM is at least the engine's `minRamMb`, the loader does
 *    not reject the document for that reason (and, since the arbitrary produces
 *    otherwise-valid documents, it does not reject it at all);
 *  - WHEN the bundle's RAM is below `minRamMb`, the loader rejects the document
 *    with a {@link MetadataValidationError} carrying an issue at
 *    `forums[i].bundleId` whose message states the required `<minRamMb> MB`.
 *  - An UNKNOWN bundle id is always rejected with an issue at
 *    `forums[i].bundleId` that lists the known bundle ids.
 *
 * The test drives both the engine's `minRamMb` and the forum's `bundleId` with
 * fast-check and computes the expected outcome from `bundleRamMb`, so the
 * oracle is the bundle table itself rather than a restatement of the loader.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x6a11d0;

/** The candidate minimum-RAM values for the engine, one per real bundle size. */
const MIN_RAM_CHOICES = [512, 1024, 2048, 4096] as const;

/** Every known bundle id from the Lightsail bundle table. */
const KNOWN_BUNDLE_IDS = Object.keys(LIGHTSAIL_BUNDLES) as (keyof typeof LIGHTSAIL_BUNDLES)[];

/** A bundle id that is deliberately not in the table. */
const UNKNOWN_BUNDLE_ID = 'does_not_exist_0_0';

/**
 * A bundle whose RAM is at least every value in {@link MIN_RAM_CHOICES}, used to
 * pin the non-mutated forums so they never fail the minimum-RAM check and the
 * only in-play bundle is the one on the forum under test. The arbitrary itself
 * picks bundles freely (including undersized ones), so this normalization is
 * what keeps the property scoped to a single forum.
 */
const AMPLE_BUNDLE_ID = '2xlarge_3_0';

/** The path the loader reports a bundle problem at, for the forum at `index`. */
function bundlePath(index: number): string {
  return `forums[${String(index)}].bundleId`;
}

/**
 * Return a copy of `doc` with the forum at `forumIndex` given the chosen
 * `bundleId` and every other forum pinned to {@link AMPLE_BUNDLE_ID}. Pinning
 * the other forums keeps the only RAM-relevant variable the bundle on the forum
 * under test, so the document's acceptance depends solely on that forum. Every
 * other field stays valid by construction (the document comes from
 * {@link rawMetadataDocument}).
 */
function withBundleId(
  doc: RawMetadataDocument,
  forumIndex: number,
  bundleId: string,
): RawMetadataDocument {
  const forums = doc.forums.map((forum, index) =>
    index === forumIndex ? { ...forum, bundleId } : { ...forum, bundleId: AMPLE_BUNDLE_ID },
  );
  return { ...doc, forums };
}

describe('Property 6: Minimum RAM enforcement', () => {
  it('accepts iff the bundle RAM meets the engine minimum, else reports the minimum (Req 4.5)', () => {
    fc.assert(
      fc.property(
        rawMetadataDocument,
        fc.constantFrom(...MIN_RAM_CHOICES),
        fc.constantFrom(...KNOWN_BUNDLE_IDS),
        (doc, minRamMb, bundleId) => {
          // Pick a deterministic forum to mutate: the first one. The document
          // always has at least one forum.
          const forumIndex = 0;
          const registry = new EngineRegistry([createTestEngine({ minRamMb })]);
          const mutated = withBundleId(doc, forumIndex, bundleId);

          const ramMb = bundleRamMb(bundleId);
          // bundleId is drawn from known ids, so RAM is always defined.
          expect(ramMb).toBeDefined();
          const meetsMinimum = (ramMb ?? 0) >= minRamMb;

          let thrown: unknown;
          try {
            loadMetadata(toYaml(mutated), registry);
          } catch (error) {
            thrown = error;
          }

          const path = bundlePath(forumIndex);

          if (meetsMinimum) {
            // Otherwise-valid document with sufficient RAM: no rejection at all,
            // and in particular no issue at this forum's bundleId.
            expect(thrown).toBeUndefined();
            return;
          }

          // Insufficient RAM: rejected with an issue at forums[i].bundleId that
          // states the required minimum in "<minRamMb> MB" form.
          expect(thrown).toBeInstanceOf(MetadataValidationError);
          const err = thrown as MetadataValidationError;
          const atPath = err.issues.filter((issue) => issue.path === path);
          expect(atPath.length).toBeGreaterThan(0);
          expect(atPath.some((issue) => issue.message.includes(`${String(minRamMb)} MB`))).toBe(
            true,
          );
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('rejects an unknown bundle id with an issue at bundleId listing known ids (Req 4.5)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, fc.constantFrom(...MIN_RAM_CHOICES), (doc, minRamMb) => {
        const forumIndex = 0;
        const registry = new EngineRegistry([createTestEngine({ minRamMb })]);
        const mutated = withBundleId(doc, forumIndex, UNKNOWN_BUNDLE_ID);

        let thrown: unknown;
        try {
          loadMetadata(toYaml(mutated), registry);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(MetadataValidationError);
        const err = thrown as MetadataValidationError;
        const atPath = err.issues.filter((issue) => issue.path === bundlePath(forumIndex));
        expect(atPath.length).toBeGreaterThan(0);
        // The message must enumerate the known bundle ids so the operator can
        // choose a valid one.
        expect(
          atPath.some((issue) => KNOWN_BUNDLE_IDS.every((id) => issue.message.includes(id))),
        ).toBe(true);
      }),
      { seed: SEED, numRuns: 100 },
    );
  });
});
