/**
 * Helper for reading a custom resource's `ResourceProperties` off a
 * CloudFormation / CDK Provider framework event.
 *
 * CloudFormation always injects a `ServiceToken` key INTO `ResourceProperties`
 * (alongside the properties the construct declares), so a handler that
 * validates `ResourceProperties` with a `.strict()` schema would reject the
 * real event. {@link stripServiceToken} removes only that known
 * CloudFormation-injected key, leaving every other key intact so a genuine
 * typo in a declared property is still caught by the strict schema.
 *
 * Pure: no I/O, no SDK calls.
 */

/** The CloudFormation-injected key removed before strict validation. */
const SERVICE_TOKEN_KEY = 'ServiceToken';

/**
 * Return `raw` with the CloudFormation-injected `ServiceToken` key removed.
 *
 * When `raw` is not a plain object it is returned unchanged (the caller's
 * schema then rejects it as malformed). Only `ServiceToken` is stripped; all
 * other keys pass through so the strict property schema still rejects
 * unexpected ones.
 *
 * @param raw - The event's `ResourceProperties` (untyped).
 * @returns The properties without `ServiceToken`.
 */
export function stripServiceToken(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return raw;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== SERVICE_TOKEN_KEY) {
      result[key] = value;
    }
  }
  return result;
}
