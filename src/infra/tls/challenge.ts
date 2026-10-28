/**
 * Pure ACME challenge selection for the shared certificate manager.
 *
 * The certificate manager runs `lego` on each instance and must pick one of two
 * challenge types. DNS-01 proves control of the domain through a TXT record and
 * needs Route 53 write access; it is used only when DNS is managed in Route 53
 * and the engine can serve externally supplied certificates. Otherwise the
 * manager falls back to HTTP-01, which proves control through a file served on
 * port 80 (Req 13.3–13.5).
 *
 * This module has no I/O, creates no CDK constructs and makes no SDK calls.
 */

import type { TlsSupport } from '../../engines/engine-adapter.js';
import type { EnvironmentModel } from '../../metadata/schema.js';

/** DNS provisioning mode, mirrored from the metadata model to avoid duplication. */
export type DnsMode = EnvironmentModel['dnsMode'];

/**
 * True for the two modes where DNS records live in a Route 53 hosted zone
 * (`route53` and `route53-existing`). In these modes the node can be granted
 * scoped Route 53 write access for the DNS-01 challenge; the `external` mode
 * manages no Route 53 resources and therefore always uses HTTP-01.
 *
 * @param dnsMode the Environment's DNS provisioning mode.
 * @returns `true` when DNS is served from a Route 53 zone.
 */
export function isRoute53Mode(dnsMode: DnsMode): boolean {
  return dnsMode === 'route53' || dnsMode === 'route53-existing';
}

/**
 * Select the ACME challenge type for a forum. Returns `'dns-01'` if and only if
 * the DNS mode is a Route 53 mode and the engine declares it can consume the
 * certificate files (`tls.dns01`); otherwise `'http-01'` (Req 13.3–13.5).
 *
 * @param dnsMode the Environment's DNS provisioning mode.
 * @param tls the engine's TLS capability.
 * @returns the challenge type the certificate manager should use.
 */
export function selectChallenge(dnsMode: DnsMode, tls: TlsSupport): 'dns-01' | 'http-01' {
  return isRoute53Mode(dnsMode) && tls.dns01 ? 'dns-01' : 'http-01';
}
