/**
 * Static table of AWS Lightsail Linux/Unix bundle ids and their RAM, used by the
 * Metadata_Loader to enforce each Engine_Adapter's minimum RAM (Req 4.5).
 *
 * The RAM values are the standard `_3_0` plan sizes. Verify against
 * `aws lightsail get-bundles` when adding entries.
 */

/** A Lightsail bundle entry: the one property the Platform needs for the RAM check. */
interface LightsailBundle {
  /** Instance RAM in megabytes. */
  readonly ramMb: number;
}

/**
 * Lightsail Linux/Unix bundle ids mapped to their specification. `as const satisfies`
 * both constrains every entry to {@link LightsailBundle} and keeps the literal keys so
 * {@link BundleId} can be derived from the table rather than duplicated by hand.
 */
export const LIGHTSAIL_BUNDLES = {
  nano_3_0: { ramMb: 512 },
  micro_3_0: { ramMb: 1024 },
  small_3_0: { ramMb: 2048 },
  medium_3_0: { ramMb: 4096 },
  large_3_0: { ramMb: 8192 },
  xlarge_3_0: { ramMb: 16384 },
  '2xlarge_3_0': { ramMb: 32768 },
} as const satisfies Record<string, LightsailBundle>;

/** The id of a known Lightsail bundle, derived from {@link LIGHTSAIL_BUNDLES}. */
export type BundleId = keyof typeof LIGHTSAIL_BUNDLES;

/** Narrow an arbitrary string to a known {@link BundleId}. */
export function isKnownBundleId(bundleId: string): bundleId is BundleId {
  return Object.prototype.hasOwnProperty.call(LIGHTSAIL_BUNDLES, bundleId);
}

/**
 * The RAM in MB for a known bundle id, or `undefined` when the id is unknown so the
 * loader can reject it and list the known ids.
 */
export function bundleRamMb(bundleId: string): number | undefined {
  return isKnownBundleId(bundleId) ? LIGHTSAIL_BUNDLES[bundleId].ramMb : undefined;
}
