/**
 * Pure firewall rule builder for a forum's Lightsail instance.
 *
 * Lightsail replaces an instance's default open ports whenever `networking.ports`
 * is specified, so the array returned here is the complete inbound surface: HTTP
 * (80) and HTTPS (443) open to the world over IPv4 and IPv6, and SSH (22) open only
 * to the operator-declared CIDRs. When no SSH CIDRs are declared, port 22 is omitted
 * entirely and operators reach the instance through Session Manager (Req 4.4).
 *
 * The loader rejects any SSH CIDR with a `/0` prefix, so no wildcard SSH rule is
 * ever added here. This module is pure: it creates no constructs and performs no I/O.
 */

import type * as lightsail from 'aws-cdk-lib/aws-lightsail';

/** CIDR allowing any IPv4 address. */
const ANY_IPV4 = '0.0.0.0/0';
/** CIDR allowing any IPv6 address. */
const ANY_IPV6 = '::/0';

/** SSH port, restricted to declared CIDRs. */
const SSH_PORT = 22;
/** HTTP port, open to the world. */
const HTTP_PORT = 80;
/** HTTPS port, open to the world. */
const HTTPS_PORT = 443;

/**
 * Build the inbound port rules for a forum instance's `networking.ports`.
 *
 * Returns, in ascending port order, a single-port TCP rule for SSH (22) scoped to
 * `sshAllowedCidrs` (omitted when the list is empty), then HTTP (80) and HTTPS (443)
 * each open to `0.0.0.0/0` and `::/0`. The result is deterministic for a given input.
 *
 * @param sshAllowedCidrs the IPv4 CIDRs allowed to reach SSH; the loader guarantees
 *   none is a `/0` wildcard. An empty list yields no SSH rule.
 * @returns the `CfnInstance.PortProperty` array for `networking.ports`.
 */
export function buildPortRules(
  sshAllowedCidrs: readonly string[],
): lightsail.CfnInstance.PortProperty[] {
  const rules: lightsail.CfnInstance.PortProperty[] = [];

  if (sshAllowedCidrs.length > 0) {
    rules.push({
      fromPort: SSH_PORT,
      toPort: SSH_PORT,
      protocol: 'tcp',
      cidrs: [...sshAllowedCidrs],
    });
  }

  for (const port of [HTTP_PORT, HTTPS_PORT]) {
    rules.push({
      fromPort: port,
      toPort: port,
      protocol: 'tcp',
      cidrs: [ANY_IPV4],
      ipv6Cidrs: [ANY_IPV6],
    });
  }

  return rules;
}
