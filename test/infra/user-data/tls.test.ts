import { describe, expect, it } from 'vitest';

import type { TlsSupport } from '../../../src/engines/engine-adapter.js';
import { renderTlsScript, type TlsScriptInput } from '../../../src/infra/user-data/tls.js';
import { LEGO_SHA256_LINUX_AMD64, LEGO_VERSION } from '../../../src/infra/user-data/versions.js';

/** A representative TlsSupport literal (matches the Flarum/Discourse shape). */
const TLS: TlsSupport = {
  dns01: true,
  certPaths: {
    fullchain: '/etc/community-hub/tls/fullchain.pem',
    privkey: '/etc/community-hub/tls/privkey.pem',
  },
  reloadCommand: 'docker compose exec -T proxy caddy reload --force',
  http01Webroot: '/var/lib/community-hub/acme-webroot',
};

function input(overrides: Partial<TlsScriptInput> = {}): TlsScriptInput {
  return {
    hostname: 'forum.example.org',
    adminEmail: 'ops@example.org',
    challenge: 'dns-01',
    staging: false,
    tls: TLS,
    ...overrides,
  };
}

describe('renderTlsScript (common)', () => {
  const dns01 = renderTlsScript(input({ challenge: 'dns-01' }));
  const http01 = renderTlsScript(input({ challenge: 'http-01' }));

  it.each([
    ['dns-01', dns01],
    ['http-01', http01],
  ])('defines issue_certificate for %s', (_name, script) => {
    expect(script).toContain('issue_certificate() {');
  });

  it.each([
    ['dns-01', dns01],
    ['http-01', http01],
  ])('installs the deploy hook for %s', (_name, script) => {
    expect(script).toContain('/opt/community-hub/bin/tls-deploy.sh');
    expect(script).toContain(TLS.reloadCommand);
  });

  it.each([
    ['dns-01', dns01],
    ['http-01', http01],
  ])('sets the renew timer to run twice daily for %s', (_name, script) => {
    expect(script).toContain('OnCalendar=*-*-* 00,12:00:00');
    expect(script).toContain('community-hub-tls-renew.timer');
    expect(script).toContain('community-hub-tls-renew.service');
  });

  it.each([
    ['dns-01', dns01],
    ['http-01', http01],
  ])('downloads lego pinned and checksum-verified for %s', (_name, script) => {
    expect(script).toContain(LEGO_VERSION);
    expect(script).toContain(`https://github.com/go-acme/lego/releases/download/${LEGO_VERSION}/`);
    expect(script).toContain(LEGO_SHA256_LINUX_AMD64);
    expect(script).toContain('sha256sum -c');
    // No unpinned download: the release URL must carry the pinned version tag.
    expect(script).not.toMatch(/releases\/latest/);
    expect(script).not.toMatch(/:latest\b/);
  });

  it.each([
    ['dns-01', dns01],
    ['http-01', http01],
  ])('never echoes the certificate private key for %s', (_name, script) => {
    expect(script).not.toMatch(/echo[^\n]*privkey/i);
    expect(script).not.toMatch(/cat[^\n]*privkey\.pem/i);
    expect(script).not.toMatch(/echo[^\n]*src_key/);
  });
});

describe('renderTlsScript (dns-01)', () => {
  const script = renderTlsScript(input({ challenge: 'dns-01' }));

  it('uses the route53 DNS provider', () => {
    expect(script).toContain('--dns route53');
  });

  it('exports the route53 AWS_* environment variables', () => {
    expect(script).toContain('AWS_HOSTED_ZONE_ID=${CH_HOSTED_ZONE_ID}');
    expect(script).toContain('AWS_REGION=');
    expect(script).toContain('AWS_PROPAGATION_TIMEOUT=');
    expect(script).toContain('AWS_POLLING_INTERVAL=');
  });

  it('sources the TLS env inside issue_certificate so lego gets the route53 vars', () => {
    // issue_certificate must load tls.env (set -a; . "$CH_TLS_ENV") BEFORE it
    // invokes lego. Without it, lego's route53 provider has no AWS_REGION or
    // AWS_HOSTED_ZONE_ID, reports "Missing Region" and calls ListHostedZonesByName
    // (denied by the node role) — issuance failed through all retries on a real
    // deploy. The env sourcing must appear before the lego ... run invocation.
    const sourceIdx = script.indexOf('. "$CH_TLS_ENV"');
    const issueLoopIdx = script.indexOf('issuing certificate for');
    expect(sourceIdx).toBeGreaterThanOrEqual(0);
    expect(issueLoopIdx).toBeGreaterThan(sourceIdx);
  });

  it('writes the TLS env with an UNQUOTED heredoc so CH_HOSTED_ZONE_ID expands', () => {
    // The env block references the runtime shell variable ${CH_HOSTED_ZONE_ID}.
    // With a quoted heredoc delimiter it was written literally, so lego's
    // route53 provider saw an invalid zone id, fell back to ListHostedZonesByName
    // (denied by the node role) and failed with "Missing Region" on a real
    // deploy. The heredoc delimiter must be unquoted so the zone id expands.
    expect(script).toContain('cat >"$CH_TLS_ENV" <<TLSENVEOF');
    expect(script).not.toContain('cat >"$CH_TLS_ENV" <<\'TLSENVEOF\'');
  });

  it('references CH_HOSTED_ZONE_ID', () => {
    expect(script).toContain('CH_HOSTED_ZONE_ID');
  });

  it('retries issuance 12 times for delegation propagation', () => {
    expect(script).toContain('attempts=12');
  });

  it('does not call wait_for_dns in the issuance path', () => {
    // The top comment names wait_for_dns as a prelude dependency, but the DNS-01
    // issuance path must not invoke it (it does not wait on the A record).
    expect(script).not.toMatch(/^ {2}wait_for_dns$/m);
  });
});

describe('renderTlsScript (http-01)', () => {
  const script = renderTlsScript(input({ challenge: 'http-01' }));

  it('waits for DNS before issuance', () => {
    expect(script).toContain('wait_for_dns');
  });

  it('issues over port 80 and renews from the webroot', () => {
    expect(script).toContain('--http --http.port :80');
    expect(script).toContain(`--http --http.webroot '${TLS.http01Webroot}'`);
  });

  it('has no route53 AWS variables and no --dns route53', () => {
    expect(script).not.toContain('--dns route53');
    expect(script).not.toContain('AWS_HOSTED_ZONE_ID');
    expect(script).not.toContain('CH_HOSTED_ZONE_ID');
  });
});

describe('renderTlsScript (staging)', () => {
  it("routes to the Let's Encrypt staging CA when staging is true", () => {
    const staging = renderTlsScript(input({ staging: true }));
    const production = renderTlsScript(input({ staging: false }));
    expect(staging).toContain('acme-staging-v02.api.letsencrypt.org');
    expect(production).toContain('acme-v02.api.letsencrypt.org');
    expect(production).not.toContain('acme-staging-v02');
  });
});
