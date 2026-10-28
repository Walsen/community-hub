import { createHmac } from 'node:crypto';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { deriveSesSmtpPassword } from '../../../src/infra/email/smtp-password.js';

/**
 * Property 22: SES SMTP password derivation.
 *
 * Validates: Requirements 11.8
 *
 * `deriveSesSmtpPassword` in `src/infra/email/smtp-password.ts` turns an IAM
 * secret access key and an AWS region into the base64 SMTP password SES expects,
 * using the AWS-documented SigV4 HMAC-SHA256 chain fixed to the SES SMTP scope.
 * This test pins the guarantees that derivation gives us across arbitrary inputs:
 *
 *  - Shape: the result is always 44 characters and decodes as valid base64 to
 *    33 bytes whose first byte is the `0x04` SigV4 version marker.
 *  - Determinism: the same `(key, region)` pair always yields the same password,
 *    so the module is a pure function with no hidden state (Req 11.8).
 *  - Distinctness: for specific distinct inputs — a different region with the
 *    same key, and a different key with the same region — the outputs differ.
 *    We assert this for concrete generated pairs rather than claiming universal
 *    injectivity, which a 256-bit hash could in principle (astronomically
 *    rarely) violate.
 *  - Cross-check (strongest): an independent re-implementation of the AWS
 *    algorithm reproduces the module's output for every generated input.
 *
 * All keys are placeholder printable-ASCII strings, never real credentials. A
 * fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x5e5c0de; // deterministic seed

/**
 * Placeholder secret access keys: non-empty printable ASCII, standing in for an
 * IAM secret. These are test fixtures, not real credentials.
 */
const placeholderSecretAccessKey: fc.Arbitrary<string> = fc.string({
  minLength: 1,
  maxLength: 48,
  unit: fc.integer({ min: 0x20, max: 0x7e }).map((c) => String.fromCharCode(c)),
});

/**
 * Region-like strings covering the real SES regions plus a handful of plausibly
 * shaped values, so the derivation is exercised beyond a single region.
 */
const regionLike: fc.Arbitrary<string> = fc.constantFrom(
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'eu-west-1',
  'eu-west-2',
  'eu-central-1',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-northeast-1',
  'ca-central-1',
  'sa-east-1',
);

/**
 * Independent re-implementation of the AWS SES SMTP password algorithm, written
 * from the documented steps rather than reusing the module under test, so the
 * cross-check is a genuine second source of truth.
 */
function referenceSmtpPassword(secretAccessKey: string, region: string): string {
  const sign = (key: Buffer, message: string): Buffer =>
    Buffer.from(createHmac('sha256', key).update(message, 'utf8').digest());

  const kSecret: Buffer = Buffer.from(`AWS4${secretAccessKey}`, 'utf8');
  const kDate = sign(kSecret, '11111111');
  const kRegion = sign(kDate, region);
  const kService = sign(kRegion, 'ses');
  const kTerminal = sign(kService, 'aws4_request');
  const kAction = sign(kTerminal, 'SendRawEmail');

  return Buffer.concat([Buffer.from([0x04]), kAction]).toString('base64');
}

/**
 * Canonical base64 pattern for the 33-byte payload: 33 bytes is exactly 11
 * groups of three, so the standard-alphabet encoding is 44 characters with no
 * `=` padding.
 */
const BASE64_44 = /^[A-Za-z0-9+/]{44}$/;

describe('Property 22: SES SMTP password derivation', () => {
  it('produces a 44-char base64 string decoding to 33 bytes starting with 0x04 (Req 11.8)', () => {
    fc.assert(
      fc.property(placeholderSecretAccessKey, regionLike, (key, region) => {
        const password = deriveSesSmtpPassword(key, region);

        expect(password).toHaveLength(44);
        expect(password).toMatch(BASE64_44);

        const decoded = Buffer.from(password, 'base64');
        expect(decoded).toHaveLength(33);
        expect(decoded[0]).toBe(0x04);
        // Round-trip: the string is exactly the base64 of those bytes.
        expect(decoded.toString('base64')).toBe(password);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('is deterministic: the same (key, region) always yields the same password (Req 11.8)', () => {
    fc.assert(
      fc.property(placeholderSecretAccessKey, regionLike, (key, region) => {
        expect(deriveSesSmtpPassword(key, region)).toBe(deriveSesSmtpPassword(key, region));
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('matches an independent re-implementation of the AWS algorithm (Req 11.8)', () => {
    fc.assert(
      fc.property(placeholderSecretAccessKey, regionLike, (key, region) => {
        expect(deriveSesSmtpPassword(key, region)).toBe(referenceSmtpPassword(key, region));
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('distinguishes a different region under the same key (Req 11.8)', () => {
    const twoRegions = fc
      .tuple(regionLike, regionLike)
      .filter(([first, second]) => first !== second);

    fc.assert(
      fc.property(placeholderSecretAccessKey, twoRegions, (key, [first, second]) => {
        expect(deriveSesSmtpPassword(key, first)).not.toBe(deriveSesSmtpPassword(key, second));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('distinguishes a different key under the same region (Req 11.8)', () => {
    const twoKeys = fc
      .tuple(placeholderSecretAccessKey, placeholderSecretAccessKey)
      .filter(([first, second]) => first !== second);

    fc.assert(
      fc.property(twoKeys, regionLike, ([first, second], region) => {
        expect(deriveSesSmtpPassword(first, region)).not.toBe(
          deriveSesSmtpPassword(second, region),
        );
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
