import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { buildPortRules } from '../../src/infra/firewall.js';
import { ipv4Cidr } from '../support/arbitraries.js';

/**
 * Property 7: Firewall rules.
 *
 * Validates: Requirements 4.4 (ports 80/443 open to the world; SSH on 22 only to
 * declared CIDRs; no `0.0.0.0/0` for SSH).
 *
 * For any list C of valid non-`/0` IPv4 CIDRs, `buildPortRules(C)`:
 *  - always opens TCP 80 and TCP 443 to `0.0.0.0/0` (and `::/0`);
 *  - adds exactly one TCP 22 rule whose cidrs equal C when C is non-empty, and
 *    no port-22 rule at all when C is empty;
 *  - never opens any port other than 80/443 to `0.0.0.0/0` or `::/0`, so the
 *    SSH rule is never a wildcard;
 *  - emits only single-port TCP rules; and
 *  - is deterministic for a given input.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0xf17e7a11;

const ANY_IPV4 = '0.0.0.0/0';
const ANY_IPV6 = '::/0';

/** Lists of valid non-`/0` IPv4 CIDRs, including the empty list. */
const cidrList: fc.Arbitrary<string[]> = fc.array(ipv4Cidr, { minLength: 0, maxLength: 5 });

/** The flattened set of every cidr value (IPv4 and IPv6) a rule opens. */
function openCidrs(rule: { cidrs?: string[]; ipv6Cidrs?: string[] }): string[] {
  return [...(rule.cidrs ?? []), ...(rule.ipv6Cidrs ?? [])];
}

describe('Property 7: Firewall rules', () => {
  it('always opens TCP 80 and 443 to the world (Req 4.4)', () => {
    fc.assert(
      fc.property(cidrList, (cidrs) => {
        const rules = buildPortRules(cidrs);

        for (const port of [80, 443]) {
          const portRules = rules.filter((r) => r.fromPort === port);
          expect(portRules).toHaveLength(1);
          const rule = portRules[0]!;
          expect(rule.protocol).toBe('tcp');
          expect(rule.toPort).toBe(port);
          expect(rule.cidrs).toContain(ANY_IPV4);
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('adds exactly one SSH rule equal to C when non-empty, and none when empty (Req 4.4)', () => {
    fc.assert(
      fc.property(cidrList, (cidrs) => {
        const rules = buildPortRules(cidrs);
        const sshRules = rules.filter((r) => r.fromPort === 22);

        if (cidrs.length === 0) {
          expect(sshRules).toHaveLength(0);
          return;
        }

        expect(sshRules).toHaveLength(1);
        const ssh = sshRules[0]!;
        expect(ssh.protocol).toBe('tcp');
        expect(ssh.fromPort).toBe(22);
        expect(ssh.toPort).toBe(22);
        expect(ssh.cidrs).toEqual([...cidrs]);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('never opens any port other than 80/443 to a wildcard, so SSH is never open to the world (Req 4.4)', () => {
    fc.assert(
      fc.property(cidrList, (cidrs) => {
        const rules = buildPortRules(cidrs);

        for (const rule of rules) {
          const opensWildcard =
            openCidrs(rule).includes(ANY_IPV4) || openCidrs(rule).includes(ANY_IPV6);
          if (rule.fromPort === 80 || rule.fromPort === 443) {
            expect(opensWildcard).toBe(true);
          } else {
            expect(opensWildcard).toBe(false);
          }
        }

        // The SSH rule in particular never carries a wildcard cidr.
        const ssh = rules.find((r) => r.fromPort === 22);
        if (ssh) {
          expect(openCidrs(ssh)).not.toContain(ANY_IPV4);
          expect(openCidrs(ssh)).not.toContain(ANY_IPV6);
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('emits only single-port TCP rules on ports 22/80/443 (Req 4.4)', () => {
    fc.assert(
      fc.property(cidrList, (cidrs) => {
        const rules = buildPortRules(cidrs);

        for (const rule of rules) {
          expect(rule.protocol).toBe('tcp');
          expect(rule.fromPort).toBe(rule.toPort);
          expect([22, 80, 443]).toContain(rule.fromPort);
        }

        // No ports beyond 80/443 (plus 22 when declared) appear.
        const ports = new Set(rules.map((r) => r.fromPort));
        const expected = cidrs.length === 0 ? [80, 443] : [22, 80, 443];
        expect([...ports].sort((a, b) => Number(a) - Number(b))).toEqual(expected);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('is deterministic for a given input (Req 4.4)', () => {
    fc.assert(
      fc.property(cidrList, (cidrs) => {
        expect(buildPortRules(cidrs)).toEqual(buildPortRules(cidrs));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('produces no SSH rule for the explicit empty-list case (Req 4.4)', () => {
    const rules = buildPortRules([]);
    expect(rules.some((r) => r.fromPort === 22)).toBe(false);
    expect(rules.map((r) => r.fromPort)).toEqual([80, 443]);
  });
});
