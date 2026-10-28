import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { deriveSesSmtpPassword } from '../../../src/infra/email/smtp-password.js';

/**
 * Independent re-implementation of the AWS-documented SES SMTP password
 * derivation, written from the published reference algorithm rather than by
 * reusing the production code. The production module and this function are two
 * separate implementations of the same spec, so asserting they agree pins the
 * exact algorithm (Req 11.8), not merely the implementation against itself.
 *
 * The keys below are obvious, non-functional PLACEHOLDERS — the AWS docs example
 * secret and deterministically derived variants. They are not real credentials.
 */
function referenceSmtpPassword(secretAccessKey: string, region: string): string {
  const sign = (key: Buffer, message: string): Buffer =>
    createHmac('sha256', key).update(message, 'utf8').digest();

  let signature: Buffer = Buffer.from(`AWS4${secretAccessKey}`, 'utf8');
  for (const message of ['11111111', region, 'ses', 'aws4_request', 'SendRawEmail']) {
    signature = sign(signature, message);
  }

  return Buffer.concat([Buffer.from([0x04]), signature]).toString('base64');
}

// Obvious placeholders only. `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` is the
// AWS documentation example secret; the others are equally fake stand-ins.
const PLACEHOLDER_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

const FIXED_VECTORS: ReadonlyArray<{ key: string; region: string }> = [
  { key: PLACEHOLDER_KEY, region: 'us-east-1' },
  { key: PLACEHOLDER_KEY, region: 'eu-west-1' },
  { key: 'EXAMPLESECRETKEYDONOTUSE0000000000000000', region: 'us-west-2' },
];

describe('deriveSesSmtpPassword', () => {
  it('matches a fixed, independently-computed vector for the AWS example key (us-east-1)', () => {
    const expected = referenceSmtpPassword(PLACEHOLDER_KEY, 'us-east-1');

    expect(deriveSesSmtpPassword(PLACEHOLDER_KEY, 'us-east-1')).toBe(expected);
  });

  it.each(FIXED_VECTORS)('agrees with the reference algorithm for %o', ({ key, region }) => {
    expect(deriveSesSmtpPassword(key, region)).toBe(referenceSmtpPassword(key, region));
  });

  it('produces region-specific passwords for the same key', () => {
    const usEast = deriveSesSmtpPassword(PLACEHOLDER_KEY, 'us-east-1');
    const euWest = deriveSesSmtpPassword(PLACEHOLDER_KEY, 'eu-west-1');

    expect(usEast).not.toBe(euWest);
  });

  it('is deterministic for a given (key, region) pair', () => {
    expect(deriveSesSmtpPassword(PLACEHOLDER_KEY, 'us-east-1')).toBe(
      deriveSesSmtpPassword(PLACEHOLDER_KEY, 'us-east-1'),
    );
  });

  describe('structural invariants of the fixed vector', () => {
    const password = deriveSesSmtpPassword(PLACEHOLDER_KEY, 'us-east-1');

    it('is exactly 44 base64 characters', () => {
      expect(password).toHaveLength(44);
    });

    it('is valid, canonical base64', () => {
      const decoded = Buffer.from(password, 'base64');
      // Round-trip: re-encoding the decoded bytes reproduces the string exactly,
      // which rejects non-canonical or malformed base64.
      expect(decoded.toString('base64')).toBe(password);
    });

    it('decodes to 33 bytes whose first byte is the 0x04 SigV4 version byte', () => {
      const decoded = Buffer.from(password, 'base64');

      expect(decoded).toHaveLength(33);
      expect(decoded[0]).toBe(0x04);
    });
  });
});

/**
 * Validates: Requirements 11.8
 */
