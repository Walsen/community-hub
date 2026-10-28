import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { renderTlsScript, type TlsScriptInput } from '../../../src/infra/user-data/tls.js';
import { LEGO_VERSION } from '../../../src/infra/user-data/versions.js';
import type { TlsSupport } from '../../../src/engines/engine-adapter.js';

/**
 * Property 30: TLS rendering.
 *
 * Validates: Requirements 13.1, 13.2, 13.10, 13.12
 *
 * For an arbitrary {@link TlsScriptInput} (hostname, ACME email, challenge in
 * {dns-01, http-01}, staging flag, and a {@link TlsSupport} whose paths,
 * reload command and webroot are arbitrary-but-valid and whose `dns01` flag is
 * consistent with the selected challenge), {@link renderTlsScript}:
 *  - always pins `lego` and checksum-verifies it, never downloading `latest`
 *    (Req 13.1);
 *  - selects the Let's Encrypt staging directory iff `staging` is true;
 *  - installs the engine's `certPaths` with the right modes and runs the
 *    engine's `reloadCommand` only when not called `--no-reload` (Req 13.2);
 *  - defines `issue_certificate` deploying with `--no-reload`, writing the
 *    issued marker, and calling `fail` on exhaustion (Req 13.12);
 *  - renews twice daily through `renew --days ${CH_TLS_RENEW_DAYS:-30}
 *    --renew-hook <deploy>` on an `OnCalendar=*-*-* 00,12:00:00` timer
 *    (Req 13.10);
 *  - never prints the private key;
 *  - carries the Route 53 provider for dns-01 and only `wait_for_dns` + HTTP-01
 *    for http-01;
 *  - is deterministic: identical input renders an identical script.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x7137_c0de;

/** Fully qualified host `<sub>.<root>.<tld>`, lowercase, no trailing dot. */
const hostnameArb = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/),
    fc.constantFrom('com', 'org', 'net', 'io', 'dev'),
  )
  .map(([sub, root, tld]) => `${sub}.${root}.${tld}`);

/** An operator-contact email on a plausible domain. */
const adminEmailArb = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9.]{0,12}[a-z0-9]$/),
    fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]$/),
    fc.constantFrom('com', 'org', 'net'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`);

/** A plausible absolute file path with no quotes or whitespace. */
const absFilePathArb = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/), { minLength: 1, maxLength: 4 })
  .map((segments) => `/${segments.join('/')}/cert.pem`);

/** A plausible absolute directory path with no quotes or whitespace. */
const absDirPathArb = fc
  .array(fc.stringMatching(/^[a-z][a-z0-9_-]{0,8}$/), { minLength: 1, maxLength: 4 })
  .map((segments) => `/${segments.join('/')}`);

/** A plausible, quote-free reload command. */
const reloadCommandArb = fc.constantFrom(
  'systemctl reload nginx',
  'docker compose -f /opt/flarum/docker-compose.yml exec caddy caddy reload',
  '/opt/community-hub/bin/discourse-reload.sh',
  'nginx -s reload',
);

/**
 * An arbitrary {@link TlsScriptInput}. The engine's `certPaths` are distinct so
 * the deploy hook renders its second (`certPaths != canonical`) install branch,
 * and `dns01` is kept consistent with the selected challenge.
 */
const tlsInputArb: fc.Arbitrary<TlsScriptInput> = fc
  .record({
    hostname: hostnameArb,
    adminEmail: adminEmailArb,
    challenge: fc.constantFrom<'dns-01' | 'http-01'>('dns-01', 'http-01'),
    staging: fc.boolean(),
    fullchain: absFilePathArb,
    privkey: absFilePathArb,
    reloadCommand: reloadCommandArb,
    http01Webroot: absDirPathArb,
  })
  .map(
    ({
      hostname,
      adminEmail,
      challenge,
      staging,
      fullchain,
      privkey,
      reloadCommand,
      http01Webroot,
    }) => {
      const tls: TlsSupport = {
        dns01: challenge === 'dns-01',
        certPaths: { fullchain, privkey },
        reloadCommand,
        http01Webroot,
      };
      return { hostname, adminEmail, challenge, staging, tls } satisfies TlsScriptInput;
    },
  );

const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

describe('Property 30: TLS rendering', () => {
  it('always pins lego and checksum-verifies it, never downloading latest (Req 13.1)', () => {
    fc.assert(
      fc.property(tlsInputArb, (input) => {
        const script = renderTlsScript(input);

        // Pinned version token appears, with a pinned release-tag download URL.
        expect(script).toContain(LEGO_VERSION);
        expect(script).toContain(
          `https://github.com/go-acme/lego/releases/download/${LEGO_VERSION}/`,
        );
        // Checksum is verified before the binary is trusted.
        expect(script).toContain('sha256sum -c');
        // No floating/unpinned download anywhere.
        expect(script).not.toMatch(/lego[^\n]*\/latest\//);
        expect(script.toLowerCase()).not.toContain('releases/latest');
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('selects the staging directory iff staging is true', () => {
    fc.assert(
      fc.property(tlsInputArb, (input) => {
        const script = renderTlsScript(input);
        if (input.staging) {
          expect(script).toContain(LE_STAGING);
          expect(script).not.toContain(LE_PRODUCTION);
        } else {
          expect(script).toContain(LE_PRODUCTION);
          expect(script).not.toContain(LE_STAGING);
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('installs certPaths with 0644/0600 modes and runs reloadCommand unless --no-reload (Req 13.2)', () => {
    fc.assert(
      fc.property(tlsInputArb, (input) => {
        const script = renderTlsScript(input);
        const { fullchain, privkey } = input.tls.certPaths;

        // The engine's cert paths are installed by the deploy hook.
        expect(script).toContain(fullchain);
        expect(script).toContain(privkey);
        // Full chain is world-readable (0644); private key is owner-only (0600).
        expect(script).toContain('install -m 0644');
        expect(script).toContain('install -m 0600');
        // The engine's reload command runs, guarded by the --no-reload flag.
        expect(script).toContain(input.tls.reloadCommand);
        expect(script).toContain('--no-reload');
        expect(script).toMatch(/if \[ "\$reload" -eq 1 \]; then/);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('defines issue_certificate: deploy --no-reload + marker on success, fail on exhaustion (Req 13.12)', () => {
    fc.assert(
      fc.property(tlsInputArb, (input) => {
        const script = renderTlsScript(input);

        expect(script).toContain('issue_certificate() {');
        // On a successful issuance the deploy hook runs with --no-reload...
        expect(script).toContain('"$CH_TLS_DEPLOY" --no-reload');
        // ...and the issued marker is written.
        expect(script).toContain('touch "$CH_TLS_ISSUED_MARKER"');
        // On exhaustion of all attempts the script fails (non-zero exit).
        expect(script).toContain(
          `fail "TLS certificate issuance for $CH_TLS_HOST failed (${input.challenge})"`,
        );
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('renews twice daily via renew --days ${CH_TLS_RENEW_DAYS:-30} --renew-hook <deploy> (Req 13.10)', () => {
    fc.assert(
      fc.property(tlsInputArb, (input) => {
        const script = renderTlsScript(input);

        // Renewal honours the 30-day default window and runs the deploy hook.
        expect(script).toContain('renew --days "$days" --renew-hook');
        expect(script).toContain('days="${CH_TLS_RENEW_DAYS:-30}"');
        expect(script).toContain("--renew-hook '/opt/community-hub/bin/tls-deploy.sh'");
        // The timer fires at 00:00 and 12:00 (at least once per 24h, Req 13.9/13.10).
        expect(script).toContain('OnCalendar=*-*-* 00,12:00:00');
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('never echoes or prints the private key', () => {
    fc.assert(
      fc.property(tlsInputArb, (input) => {
        const script = renderTlsScript(input);
        const { privkey } = input.tls.certPaths;

        // The key path is only ever installed/moved, never read to stdout.
        const keyPaths = [privkey, '$src_key', '"$src_key"', '$dest_key', '"$dest_key"'];
        for (const path of keyPaths) {
          expect(script).not.toContain(`cat ${path}`);
          expect(script).not.toContain(`echo ${path}`);
          expect(script).not.toContain(`printf ${path}`);
          expect(script).not.toContain(`cat "${path}"`);
        }
        // Defensive: no line dumps a .key / privkey file via cat.
        expect(script).not.toMatch(/\bcat\b[^\n]*(privkey|\.key)/);
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('carries the Route 53 provider and env for dns-01', () => {
    fc.assert(
      fc.property(
        tlsInputArb.filter((i) => i.challenge === 'dns-01'),
        (input) => {
          const script = renderTlsScript(input);
          expect(script).toContain('--dns route53');
          expect(script).toContain('AWS_HOSTED_ZONE_ID=${CH_HOSTED_ZONE_ID}');
          expect(script).toContain('AWS_REGION=');
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('uses HTTP-01 only and no Route 53 access for http-01 forums', () => {
    fc.assert(
      fc.property(
        tlsInputArb.filter((i) => i.challenge === 'http-01'),
        (input) => {
          const script = renderTlsScript(input);
          expect(script).toContain('wait_for_dns');
          expect(script).toContain('--http');
          expect(script).not.toContain('--dns route53');
          expect(script).not.toContain('AWS_HOSTED_ZONE_ID');
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('is deterministic: identical input renders an identical script', () => {
    fc.assert(
      fc.property(tlsInputArb, (input) => {
        expect(renderTlsScript(input)).toBe(renderTlsScript(input));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
