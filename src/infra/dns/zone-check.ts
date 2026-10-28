/**
 * Pure validation that a looked-up public Route 53 hosted zone matches the
 * declared Hosted_Zone_ID.
 *
 * In `route53-existing` mode the stack resolves the zone with
 * `HostedZone.fromLookup(rootDomain)` and must confirm that the zone the
 * toolkit found is the one the operator declared, so synthesis stops before any
 * DNS record is created against the wrong zone (Req 12.6, 12.7). This module is
 * pure: it creates no constructs and performs no I/O, CDK or SDK calls.
 */

import { HostedZoneMismatchError } from '../../shared/errors.js';

/** Prefix some AWS APIs prepend to a hosted zone id (for example `/hostedzone/Z123`). */
const HOSTED_ZONE_PREFIX = '/hostedzone/';

/**
 * Strip a single leading `/hostedzone/` prefix from a hosted zone id.
 *
 * Hosted zone ids surface in two shapes depending on the source: bare (`Z123`)
 * or path-prefixed (`/hostedzone/Z123`). Normalizing both to the bare form lets
 * the comparison and the resulting error message use clean `Z`-ids.
 */
function normalizeZoneId(id: string): string {
  return id.startsWith(HOSTED_ZONE_PREFIX) ? id.slice(HOSTED_ZONE_PREFIX.length) : id;
}

/**
 * Assert that the looked-up hosted zone id matches the declared Hosted_Zone_ID.
 *
 * Both ids are normalized by stripping a leading `/hostedzone/` before
 * comparison, so a bare id and its path-prefixed form are treated as equal.
 * When the normalized ids match, the function returns normally. When they
 * differ, it throws {@link HostedZoneMismatchError} carrying the normalized
 * bare `Z`-ids and the root domain, producing the message
 * `hosted zone <declaredId> is not the public hosted zone for <rootDomain> (found <lookedUpId>)`.
 *
 * This function does not handle CDK's `DUMMY` lookup sentinel. The caller is
 * responsible for skipping the check while the context value is still missing
 * (`HostedZone.fromLookup` returns `DUMMY` on the first synthesis pass, before
 * the toolkit runs the lookup and synthesizes again).
 *
 * @param input.declaredId the Hosted_Zone_ID from metadata (bare or `/hostedzone/`-prefixed).
 * @param input.lookedUpId the id returned by `HostedZone.fromLookup` (bare or prefixed).
 * @param input.rootDomain the root domain the zone is expected to serve, for the error message.
 * @throws {HostedZoneMismatchError} when the normalized ids differ.
 */
export function checkLookedUpZone(input: {
  declaredId: string;
  lookedUpId: string;
  rootDomain: string;
}): void {
  const declaredId = normalizeZoneId(input.declaredId);
  const lookedUpId = normalizeZoneId(input.lookedUpId);

  if (declaredId === lookedUpId) {
    return;
  }

  throw new HostedZoneMismatchError({
    declaredId,
    lookedUpId,
    rootDomain: input.rootDomain,
  });
}
