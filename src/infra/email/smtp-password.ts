/**
 * Pure derivation of an Amazon SES SMTP password from an IAM secret access key.
 *
 * SES does not store a separate SMTP password. Instead, the SMTP password is
 * derived from an IAM user's secret access key using the AWS-documented
 * algorithm: a Signature Version 4 signing-key chain fixed to the SES SMTP
 * scope (`"11111111"` date stamp, the Environment region, the `ses` service,
 * `aws4_request`, and the `SendRawEmail` action), keyed by `"AWS4" + secretAccessKey`.
 * Each HMAC-SHA256 uses the previous digest as the key and the given string as the
 * message; the first key is the UTF-8 bytes of `"AWS4" + secretAccessKey` and the
 * first message is the literal string `"11111111"`.
 *
 * The final password is the base64 encoding of a single version byte (`0x04`)
 * concatenated with the 32-byte digest of the last HMAC. The version byte tells
 * SES which signing algorithm produced the password; `0x04` denotes SigV4. The
 * result is 33 bytes, which is 44 base64 characters.
 *
 * This module is pure: it uses `node:crypto` only and performs no I/O, reads no
 * clock, and consumes no randomness. The output is deterministic for a given
 * `(secretAccessKey, region)` pair (Req 11.8).
 */

import { createHmac } from 'node:crypto';

/** Fixed date stamp the SES SMTP derivation uses in place of a real SigV4 date. */
const DATE_STAMP = '11111111';
/** SigV4 service name for SES. */
const SERVICE = 'ses';
/** SigV4 terminating string for the signing-key chain. */
const TERMINAL = 'aws4_request';
/** SES action the SMTP credential is scoped to. */
const ACTION = 'SendRawEmail';
/** SigV4 version byte identifying the SMTP password algorithm (0x04 = SigV4). */
const VERSION_BYTE = 0x04;

/**
 * Compute one step of the HMAC-SHA256 signing-key chain.
 *
 * @param key the previous digest (or the initial key bytes) used as the HMAC key.
 * @param message the UTF-8 string signed at this step.
 * @returns the raw 32-byte HMAC-SHA256 digest.
 */
function hmac(key: Buffer, message: string): Buffer {
  return createHmac('sha256', key).update(message, 'utf8').digest();
}

/**
 * Derive the Amazon SES SMTP password for a secret access key and region.
 *
 * Applies the AWS-documented HMAC-SHA256 chain over the fixed SES SMTP scope and
 * prefixes the final digest with the `0x04` version byte before base64 encoding.
 *
 * @param secretAccessKey the IAM user's secret access key.
 * @param region the AWS region whose SES SMTP endpoint the password is for.
 * @returns the 44-character base64 SMTP password.
 */
export function deriveSesSmtpPassword(secretAccessKey: string, region: string): string {
  const k1 = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), DATE_STAMP);
  const k2 = hmac(k1, region);
  const k3 = hmac(k2, SERVICE);
  const k4 = hmac(k3, TERMINAL);
  const k5 = hmac(k4, ACTION);

  return Buffer.concat([Buffer.from([VERSION_BYTE]), k5]).toString('base64');
}
