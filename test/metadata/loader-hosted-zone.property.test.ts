import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { EngineRegistry } from '../../src/engines/registry.js';
import { MetadataValidationError } from '../../src/metadata/errors.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import { DNS_MODES } from '../../src/metadata/schema.js';
import { rawMetadataDocument, toYaml, type RawMetadataDocument } from '../support/arbitraries.js';
import { createTestEngine } from '../support/testengine.js';

/**
 * Property 29: Hosted_Zone_ID metadata rules.
 *
 * Validates: Requirements 12.1, 12.2, 12.3, 12.4
 *
 * Starting from a VALID raw document D (from {@link rawMetadataDocument}), this
 * property overrides `environment.dnsMode` and `environment.hostedZoneId` to
 * construct every presence-iff / enum case, then asserts `loadMetadata` either
 * succeeds or rejects at the right field path:
 *
 *  - Req 12.1: only the three DNS_Mode values `route53`, `route53-existing` and
 *    `external` are accepted; any other value is rejected at
 *    `environment.dnsMode`.
 *  - Req 12.2: `route53-existing` WITHOUT a `hostedZoneId` is rejected at
 *    `environment.hostedZoneId`.
 *  - Req 12.3: a `hostedZoneId` present while dnsMode is `route53` or `external`
 *    is rejected at `environment.hostedZoneId`.
 *  - Req 12.4: a malformed `hostedZoneId` (not `^Z[A-Z0-9]+$`) with
 *    `route53-existing` is rejected at `environment.hostedZoneId`.
 *  - The two valid combinations load successfully: `route53`/`external` with no
 *    `hostedZoneId`, and `route53-existing` with a well-formed id.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x29_f0_5a_11;

/** The `testengine`-only registry the loader validates against. */
const registry = new EngineRegistry([createTestEngine()]);

/** A recursively mutable view of a type, for in-place mutation of a clone. */
type Mutable<T> = {
  -readonly [K in keyof T]: T[K] extends readonly (infer E)[]
    ? Mutable<E>[]
    : T[K] extends object
      ? Mutable<T[K]>
      : T[K];
};

/** A deep-writable clone of a raw document. */
type MutableDocument = Mutable<RawMetadataDocument>;

/** A well-formed Route 53 hosted zone id: `^Z[A-Z0-9]+$`. */
const WELL_FORMED_ZONE_ID = 'Z0123456789ABCDEFGHIJ';

/** DNS_Mode values that are not accepted by the schema (Req 12.1). */
const INVALID_DNS_MODES = ['lightsail', 'route53-new', 'cloudflare', 'ROUTE53', ''] as const;

/** Hosted zone ids that violate the `^Z[A-Z0-9]+$` pattern (Req 12.4). */
const MALFORMED_ZONE_IDS = [
  'Z', // nothing after the leading Z
  'z0123456789', // lowercase leading char
  'Z-ABC123', // hyphen not allowed
  'Zabc123', // lowercase body
  'ABC123', // missing leading Z
  'Z01 23', // whitespace
] as const;

/** Set `environment.dnsMode` and drop any `hostedZoneId` left over from D. */
function setMode(doc: MutableDocument, mode: string): void {
  doc.environment.dnsMode = mode as (typeof DNS_MODES)[number];
  delete (doc.environment as { hostedZoneId?: string }).hostedZoneId;
}

/** True when any issue sits exactly at the expected path. */
function hasIssueAt(error: MetadataValidationError, expectedPath: string): boolean {
  return error.issues.some((issue) => issue.path === expectedPath);
}

/** Load a mutated clone and return the thrown error, or undefined on success. */
function loadMutated(doc: RawMetadataDocument, mutate: (d: MutableDocument) => void): unknown {
  const mutated = structuredClone(doc) as unknown as MutableDocument;
  mutate(mutated);
  try {
    loadMetadata(toYaml(mutated), registry);
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Property 29: Hosted_Zone_ID metadata rules', () => {
  it('accepts route53 and external without a hostedZoneId (Req 12.1)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, fc.constantFrom('route53', 'external'), (doc, mode) => {
        const thrown = loadMutated(doc, (d) => {
          setMode(d, mode);
        });
        expect(thrown, `dnsMode '${mode}' without hostedZoneId should load`).toBeUndefined();
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('accepts route53-existing with a well-formed hostedZoneId (Req 12.1, 12.4)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, (doc) => {
        const thrown = loadMutated(doc, (d) => {
          setMode(d, 'route53-existing');
          d.environment.hostedZoneId = WELL_FORMED_ZONE_ID;
        });
        expect(thrown, 'route53-existing with a valid hostedZoneId should load').toBeUndefined();
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('rejects any DNS_Mode outside the three allowed values at environment.dnsMode (Req 12.1)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, fc.constantFrom(...INVALID_DNS_MODES), (doc, mode) => {
        const thrown = loadMutated(doc, (d) => {
          setMode(d, mode);
        });
        expect(thrown, `dnsMode '${mode}' should be rejected`).toBeInstanceOf(
          MetadataValidationError,
        );
        expect(hasIssueAt(thrown as MetadataValidationError, 'environment.dnsMode')).toBe(true);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('rejects route53-existing without a hostedZoneId at environment.hostedZoneId (Req 12.2)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, (doc) => {
        const thrown = loadMutated(doc, (d) => {
          setMode(d, 'route53-existing');
          // No hostedZoneId attached: setMode already dropped it.
        });
        expect(thrown, 'route53-existing without hostedZoneId should be rejected').toBeInstanceOf(
          MetadataValidationError,
        );
        expect(hasIssueAt(thrown as MetadataValidationError, 'environment.hostedZoneId')).toBe(
          true,
        );
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('rejects a hostedZoneId when dnsMode is not route53-existing at environment.hostedZoneId (Req 12.3)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, fc.constantFrom('route53', 'external'), (doc, mode) => {
        const thrown = loadMutated(doc, (d) => {
          setMode(d, mode);
          d.environment.hostedZoneId = WELL_FORMED_ZONE_ID;
        });
        expect(thrown, `dnsMode '${mode}' with a hostedZoneId should be rejected`).toBeInstanceOf(
          MetadataValidationError,
        );
        expect(hasIssueAt(thrown as MetadataValidationError, 'environment.hostedZoneId')).toBe(
          true,
        );
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('rejects a malformed hostedZoneId with route53-existing at environment.hostedZoneId (Req 12.4)', () => {
    fc.assert(
      fc.property(rawMetadataDocument, fc.constantFrom(...MALFORMED_ZONE_IDS), (doc, badId) => {
        const thrown = loadMutated(doc, (d) => {
          setMode(d, 'route53-existing');
          d.environment.hostedZoneId = badId;
        });
        expect(thrown, `malformed hostedZoneId '${badId}' should be rejected`).toBeInstanceOf(
          MetadataValidationError,
        );
        expect(hasIssueAt(thrown as MetadataValidationError, 'environment.hostedZoneId')).toBe(
          true,
        );
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});
