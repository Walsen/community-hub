import { describe, expect, it } from 'vitest';

import type { TlsSupport } from '../../../src/engines/engine-adapter.js';
import { isRoute53Mode, selectChallenge, type DnsMode } from '../../../src/infra/tls/challenge.js';

/** A minimal TlsSupport literal; only `dns01` affects challenge selection. */
function tlsSupport(dns01: boolean): TlsSupport {
  return {
    dns01,
    certPaths: { fullchain: '/etc/ssl/fullchain.pem', privkey: '/etc/ssl/privkey.pem' },
    reloadCommand: 'reload',
    http01Webroot: '/var/www/acme',
  };
}

describe('isRoute53Mode', () => {
  it('is true for the two Route 53 modes', () => {
    expect(isRoute53Mode('route53')).toBe(true);
    expect(isRoute53Mode('route53-existing')).toBe(true);
  });

  it('is false for the external mode', () => {
    expect(isRoute53Mode('external')).toBe(false);
  });
});

describe('selectChallenge', () => {
  const modes: readonly DnsMode[] = ['route53', 'route53-existing', 'external'];

  // All 6 combinations: 3 DNS modes x dns01 true/false.
  const cases: ReadonlyArray<{ mode: DnsMode; dns01: boolean; expected: 'dns-01' | 'http-01' }> = [
    { mode: 'route53', dns01: true, expected: 'dns-01' },
    { mode: 'route53', dns01: false, expected: 'http-01' },
    { mode: 'route53-existing', dns01: true, expected: 'dns-01' },
    { mode: 'route53-existing', dns01: false, expected: 'http-01' },
    { mode: 'external', dns01: true, expected: 'http-01' },
    { mode: 'external', dns01: false, expected: 'http-01' },
  ];

  it.each(cases)('returns $expected for mode=$mode dns01=$dns01', ({ mode, dns01, expected }) => {
    expect(selectChallenge(mode, tlsSupport(dns01))).toBe(expected);
  });

  it('returns dns-01 only when a Route 53 mode and the engine supports dns01', () => {
    for (const mode of modes) {
      const dns01True = selectChallenge(mode, tlsSupport(true));
      const dns01False = selectChallenge(mode, tlsSupport(false));

      // dns01=false always falls back to http-01.
      expect(dns01False).toBe('http-01');
      // dns01=true yields dns-01 iff the mode is a Route 53 mode.
      expect(dns01True).toBe(isRoute53Mode(mode) ? 'dns-01' : 'http-01');
    }
  });
});
