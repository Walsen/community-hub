import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  formatSecretReference,
  parseSecretReference,
  type SecretReference,
} from '../../src/metadata/secret-ref.js';

/**
 * Property 4: Secret_Reference round trip.
 *
 * Validates: Requirements 2.1
 *
 * These properties pin the parse/format pair in `src/metadata/secret-ref.ts`.
 * The arbitraries below mirror the SSM and Secrets Manager id regexes so that
 * every generated reference is well-formed by construction. A fixed seed keeps
 * any counterexample reproducible.
 */

// Character classes copied from the regexes in secret-ref.ts so the generators
// only ever produce ids that the parser accepts.
const SSM_SEGMENT_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-';
const SM_NAME_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/_+=.@-';

const charFrom = (chars: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: chars.length - 1 }).map((i) => chars[i]!);

const stringFrom = (chars: string, minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(charFrom(chars), { minLength, maxLength }).map((cs) => cs.join(''));

/** Absolute SSM path like `/community-hub/<env>/<forum>/<purpose>`. */
const ssmId: fc.Arbitrary<string> = fc
  .array(stringFrom(SSM_SEGMENT_CHARS, 1, 12), { minLength: 1, maxLength: 5 })
  .map((segments) => `/${segments.join('/')}`);

/** A bare Secrets Manager secret name. */
const smBareName: fc.Arbitrary<string> = stringFrom(SM_NAME_CHARS, 1, 40);

/** A Secrets Manager ARN form (also matched by the Secrets Manager regex). */
const smArn: fc.Arbitrary<string> = fc
  .record({
    region: fc.constantFrom('us-east-1', 'us-west-2', 'eu-west-1'),
    account: stringFrom('0123456789', 12, 12),
    name: stringFrom(SM_NAME_CHARS.replace(':', ''), 1, 20),
    suffix: stringFrom('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 6, 6),
  })
  .map(
    ({ region, account, name, suffix }) =>
      `arn:aws:secretsmanager:${region}:${account}:secret:${name}-${suffix}`,
  );

const secretReference: fc.Arbitrary<SecretReference> = fc.oneof(
  ssmId.map((id) => ({ store: 'ssm', id }) as const),
  smBareName.map((id) => ({ store: 'secretsmanager', id }) as const),
  smArn.map((id) => ({ store: 'secretsmanager', id }) as const),
);

describe('Property 4: Secret_Reference round trip', () => {
  it('parse(format(ref)) deep-equals ref for any well-formed reference', () => {
    fc.assert(
      fc.property(secretReference, (ref) => {
        const roundTripped = parseSecretReference(formatSecretReference(ref));
        expect(roundTripped).toEqual(ref);
      }),
      { seed: 0x5ec2e7, numRuns: 1000 },
    );
  });

  it('every generated reference parses back to the ssm or secretsmanager store it came from', () => {
    fc.assert(
      fc.property(secretReference, (ref) => {
        const parsed = parseSecretReference(formatSecretReference(ref));
        expect(parsed?.store).toBe(ref.store);
      }),
      { seed: 0x5ec2e7, numRuns: 1000 },
    );
  });

  it('returns undefined (and never throws) for arbitrary strings that are not references', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        // A real reference is "ssm:/..." or "secretsmanager:<id>". Skip inputs
        // that happen to parse so this property only covers non-references.
        fc.pre(parseSecretReference(raw) === undefined);
        expect(() => parseSecretReference(raw)).not.toThrow();
        expect(parseSecretReference(raw)).toBeUndefined();
      }),
      { seed: 0x5ec2e7, numRuns: 1000 },
    );
  });

  it('never throws on fully arbitrary input, whatever the outcome', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = parseSecretReference(raw);
        expect(
          result === undefined || result.store === 'ssm' || result.store === 'secretsmanager',
        ).toBe(true);
      }),
      { seed: 0x5ec2e7, numRuns: 1000 },
    );
  });
});
