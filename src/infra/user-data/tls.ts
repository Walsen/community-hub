/**
 * Pure renderer for the shared certificate-manager user-data section.
 *
 * {@link renderTlsScript} returns the engine-agnostic bash that runs AFTER the
 * shared prelude (`prelude.ts`) and BEFORE the adapter install script (composed
 * by task 16.3). It is a pure string builder: no CDK tokens, no secret values,
 * and the downloaded `lego` binary is pinned and SHA-256 verified (Req 13.1).
 *
 * It installs the `lego` ACME client, writes the issuance/renewal environment,
 * and defines three things the rest of the boot relies on:
 *  - `issue_certificate`: the function each adapter install script calls BEFORE
 *    it starts any listener on port 80 or 443 (Req 13.13). HTTP-01 waits for
 *    DNS and retries a few times; DNS-01 skips the wait and retries for longer
 *    while a fresh zone's delegation propagates.
 *  - `/opt/community-hub/bin/tls-deploy.sh`: the deploy/renew hook that installs
 *    the issued full chain (`0644`) and private key (`0600`) atomically into the
 *    canonical directory and the engine's `certPaths`, then runs the engine's
 *    reload command unless `--no-reload` (Req 13.2).
 *  - `community-hub-tls-renew.{timer,service}` + `/opt/community-hub/bin/
 *    tls-renew.sh`: twice-daily renewal that reuses the issuance challenge type
 *    and leaves the live certificate untouched on a failed renewal (Req 13.9–13.11).
 *
 * It assumes the prelude already defined `fail` and `wait_for_dns`, references
 * the header variable `CH_HOSTED_ZONE_ID` (DNS-01 forums only), and never
 * prints the ACME account key or the certificate private key. The fragment runs
 * under the composed script's `set -euo pipefail` and is shellcheck-clean on its
 * own.
 */

import { LEGO_SHA256_LINUX_AMD64, LEGO_VERSION } from './versions.js';
import type { TlsSupport } from '../../engines/engine-adapter.js';

/** Inputs for {@link renderTlsScript}. References and derived settings only. */
export interface TlsScriptInput {
  /** Fully qualified host name the certificate is issued for. */
  readonly hostname: string;
  /** ACME account email (operator contact, also the Let's Encrypt account). */
  readonly adminEmail: string;
  /** ACME challenge type selected for this forum (`tls/challenge.ts`). */
  readonly challenge: 'dns-01' | 'http-01';
  /** `environment.acmeStaging`: true routes to the Let's Encrypt staging CA. */
  readonly staging: boolean;
  /** TLS capability from the engine adapter (cert paths, reload, webroot). */
  readonly tls: TlsSupport;
}

/** Let's Encrypt production ACME v2 directory. */
const LE_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';
/** Let's Encrypt staging ACME v2 directory (tests only). */
const LE_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

/** lego working directory: ACME account key and issued certificates (`0700`). */
const LEGO_DIR = '/var/lib/community-hub/lego';
/** Directory holding idempotency step markers (created by the prelude). */
const STATE_DIR = '/var/lib/community-hub/state';
/** Marker written after the first successful issuance + deploy. */
const ISSUED_MARKER = `${STATE_DIR}/tls-issued.done`;
/** Issuance/renewal environment sourced by both paths (`0600`). */
const TLS_ENV = '/etc/community-hub/tls.env';
/** Canonical directory the deploy hook always installs the certificate into. */
const CANONICAL_CERT_DIR = '/etc/community-hub/tls';
/** On-instance bin directory for the deploy and renew scripts. */
const BIN_DIR = '/opt/community-hub/bin';
/** Deploy/renew hook invoked at issuance and by lego's `--renew-hook`. */
const DEPLOY_SCRIPT = `${BIN_DIR}/tls-deploy.sh`;
/** Renewal driver run by the systemd oneshot service. */
const RENEW_SCRIPT = `${BIN_DIR}/tls-renew.sh`;
/** The install log the renewal failure line is appended to (Req 13.11). */
const LOG_FILE = '/var/log/community-hub/install.log';

/**
 * Render the shared certificate-manager bash fragment.
 *
 * @param input - Host, ACME email, selected challenge, staging flag and the
 *   engine's {@link TlsSupport}. No secret values, no CDK tokens.
 * @returns A pure, idempotent, shellcheck-clean bash fragment defining
 *   `issue_certificate`, the deploy hook and the renewal units.
 */
export function renderTlsScript(input: TlsScriptInput): string {
  const { hostname, adminEmail, challenge, staging, tls } = input;
  const server = staging ? LE_STAGING : LE_PRODUCTION;
  const isDns01 = challenge === 'dns-01';

  // lego release asset and the pinned checksum the install step verifies.
  const tarball = `lego_${LEGO_VERSION}_linux_amd64.tar.gz`;
  const releaseUrl = `https://github.com/go-acme/lego/releases/download/${LEGO_VERSION}/${tarball}`;

  // Challenge flags differ between issuance and renewal for HTTP-01: at issuance
  // nothing listens on port 80 so lego may use its own listener; at renewal the
  // engine's port-80 server is up, so lego must use the shared webroot.
  const dns01IssueFlags = '--dns route53';
  const dns01RenewFlags = '--dns route53';
  const http01WebrootFlags = `--http --http.webroot '${tls.http01Webroot}'`;

  // Canonical certificate files the engine (via bind mount) and renew hook read.
  const canonicalHostDir = `${CANONICAL_CERT_DIR}/${hostname}`;
  const canonicalFullchain = `${canonicalHostDir}/fullchain.pem`;
  const canonicalPrivkey = `${canonicalHostDir}/privkey.pem`;

  // The DNS-01 env block only when this forum uses DNS-01; HTTP-01 forums get
  // neither the route53 variables nor any reference to CH_HOSTED_ZONE_ID.
  const dns01EnvLines = isDns01
    ? [
        `AWS_HOSTED_ZONE_ID=\${CH_HOSTED_ZONE_ID}`,
        `AWS_SHARED_CREDENTIALS_FILE=/root/.aws/credentials`,
        `AWS_PROFILE=default`,
        `AWS_REGION=us-east-1`,
        `AWS_PROPAGATION_TIMEOUT=600`,
        `AWS_POLLING_INTERVAL=10`,
        `AWS_TTL=60`,
      ]
    : [];

  return `# ====================================================================
# Certificate manager (shared, engine-agnostic; after prelude, before adapter)
# ====================================================================
# Issues and renews the Let's Encrypt certificate for ${hostname} with a pinned,
# checksum-verified lego (${LEGO_VERSION}). Challenge: ${challenge}. Defines
# issue_certificate(), the deploy hook and the renewal units. Assumes fail() and
# wait_for_dns() from the prelude. Never prints the private key.

readonly CH_TLS_HOST='${hostname}'
readonly CH_LEGO_DIR='${LEGO_DIR}'
readonly CH_TLS_ENV='${TLS_ENV}'
readonly CH_TLS_DEPLOY='${DEPLOY_SCRIPT}'
readonly CH_TLS_RENEW='${RENEW_SCRIPT}'
readonly CH_TLS_CANONICAL_DIR='${canonicalHostDir}'
readonly CH_TLS_ISSUED_MARKER='${ISSUED_MARKER}'

install -d -m 0755 '${BIN_DIR}'
install -d -m 0700 "$CH_LEGO_DIR"
install -d -m 0700 '${CANONICAL_CERT_DIR}'
install -d -m 0700 "$CH_TLS_CANONICAL_DIR"
install -d -m 0755 "$(dirname "$CH_TLS_ENV")"
install -d -m 0755 '${tls.http01Webroot}'

# ---- Install lego (pinned + SHA-256 verified, idempotent) -----------
install_lego() {
  if command -v lego >/dev/null 2>&1 && \\
     lego --version 2>/dev/null | grep -qF '${LEGO_VERSION.replace(/^v/, '')}'; then
    return 0
  fi
  local tmp tarball
  tmp="$(mktemp -d)"
  tarball="$tmp/${tarball}"
  curl -fsSL --retry 5 --connect-timeout 15 \\
    '${releaseUrl}' -o "$tarball"
  printf '%s  %s\\n' '${LEGO_SHA256_LINUX_AMD64}' "$tarball" | sha256sum -c - \\
    || fail "lego checksum mismatch"
  tar -xzf "$tarball" -C "$tmp" lego
  install -m 0755 "$tmp/lego" /usr/local/bin/lego
  rm -rf "$tmp"
}

install_lego

# ---- Issuance / renewal environment (0600) --------------------------
# Both issuance and renewal source this file, so a renewal always uses the same
# challenge type as the issuance (Req 13.10). No secret values live here.
# NOTE: the heredoc delimiter is UNQUOTED so the single runtime shell variable
# in the DNS-01 env block (the hosted zone id the plaintext wrapper exports)
# expands to its real value. A quoted delimiter wrote it literally and broke
# lego's route53 provider ("Missing Region" / zone lookup) on a real deploy.
umask 077
cat >"$CH_TLS_ENV" <<TLSENVEOF
CH_TLS_CHALLENGE=${challenge}
CH_TLS_SERVER=${server}
${dns01EnvLines.join('\n')}
TLSENVEOF
chmod 0600 "$CH_TLS_ENV"

# ---- Deploy / renew hook (0700) -------------------------------------
# Installs the issued full chain (0644) and private key (0600) atomically into
# the canonical directory and the engine's certPaths, then reloads the engine
# unless called with --no-reload. lego exposes LEGO_CERT_PATH / LEGO_CERT_KEY_PATH
# to hooks; fall back to the known paths under --path otherwise. Never prints the
# key.
cat >"$CH_TLS_DEPLOY" <<'TLSDEPLOYEOF'
#!/bin/bash
set -euo pipefail

reload=1
if [ "\${1:-}" = "--no-reload" ]; then
  reload=0
fi

host='${hostname}'
lego_dir='${LEGO_DIR}'
src_crt="\${LEGO_CERT_PATH:-\${lego_dir}/certificates/\${host}.crt}"
src_key="\${LEGO_CERT_KEY_PATH:-\${lego_dir}/certificates/\${host}.key}"

if [ ! -s "\$src_crt" ] || [ ! -s "\$src_key" ]; then
  echo "tls-deploy: issued certificate for \$host not found" >&2
  exit 1
fi

# install_pair: atomic install of cert+key. Parents are 0755-traversable; only
# the key's leaf dir is 0700. (0700 on the cert dir would pre-create an engine
# shared volume's parents as 0700 root and lock out its db/redis users.)
install_pair() {
  local dest_crt="\$1" dest_key="\$2" crt_dir key_dir
  crt_dir="\$(dirname "\$dest_crt")"
  key_dir="\$(dirname "\$dest_key")"
  install -d -m 0755 "\$crt_dir" "\$key_dir"
  chmod 0700 "\$key_dir"
  umask 077
  install -m 0644 "\$src_crt" "\$dest_crt.tmp"
  install -m 0600 "\$src_key" "\$dest_key.tmp"
  mv -f "\$dest_crt.tmp" "\$dest_crt"
  mv -f "\$dest_key.tmp" "\$dest_key"
}

# Canonical location first (always), then the engine's certPaths if different.
install_pair '${canonicalFullchain}' '${canonicalPrivkey}'
if [ '${tls.certPaths.fullchain}' != '${canonicalFullchain}' ] || \\
   [ '${tls.certPaths.privkey}' != '${canonicalPrivkey}' ]; then
  install_pair '${tls.certPaths.fullchain}' '${tls.certPaths.privkey}'
fi

if [ "\$reload" -eq 1 ]; then
  ${tls.reloadCommand}
fi
TLSDEPLOYEOF
chmod 0700 "$CH_TLS_DEPLOY"

# ---- issue_certificate ----------------------------------------------
# Called by the adapter install script BEFORE it starts any port-80/443 listener
# (Req 13.13). HTTP-01 waits for DNS then retries 3x (5 min apart, under Let's
# Encrypt's 5-failures-per-hour limit); DNS-01 does not wait and retries 12x
# (10 min apart) for a fresh zone's delegation to propagate. On success it runs
# the deploy hook with --no-reload (no engine is up yet) and writes the marker;
# after the last attempt it fails and the script exits before the engine starts.
issue_certificate() {
  if [ -f "$CH_TLS_ISSUED_MARKER" ] && \\
     [ -s "$CH_LEGO_DIR/certificates/$CH_TLS_HOST.crt" ]; then
    echo "tls: certificate for $CH_TLS_HOST already issued; skipping"
    return 0
  fi

  local attempts interval attempt
${
  isDns01
    ? `  attempts=12
  interval=600`
    : `  wait_for_dns
  attempts=3
  interval=300`
}

  # Load the issuance environment (challenge type and, for DNS-01, the route53
  # provider variables incl. the hosted zone id and region) into lego's process.
  # Without this, lego's route53 provider has no region or zone id, reports a
  # missing-region error and falls back to a zone lookup the node role denies — a
  # real deploy stalled through all 12 issuance attempts. The renewal driver
  # already sources this file; issuance must do the same.
  set -a
  # shellcheck source=/dev/null  # tls.env is a runtime file, not in the repo
  . "$CH_TLS_ENV"
  set +a

  for attempt in $(seq 1 "$attempts"); do
    echo "tls: issuing certificate for $CH_TLS_HOST (${challenge}) attempt $attempt/$attempts"
    if lego --accept-tos --email '${adminEmail}' --domains "$CH_TLS_HOST" \\
         --key-type ec256 --path "$CH_LEGO_DIR" --server '${server}' \\
         ${isDns01 ? dns01IssueFlags : '--http --http.port :80'} run; then
      "$CH_TLS_DEPLOY" --no-reload
      touch "$CH_TLS_ISSUED_MARKER"
      echo "tls: certificate issued for $CH_TLS_HOST"
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      echo "tls: issuance attempt $attempt failed; retrying in $interval s"
      sleep "$interval"
    fi
  done
  fail "TLS certificate issuance for $CH_TLS_HOST failed (${challenge})"
}

# ---- Renewal driver + systemd timer/service -------------------------
# Sources tls.env (so renewal reuses the issuance challenge) and renews only when
# fewer than CH_TLS_RENEW_DAYS (default 30) remain. On failure it logs one line
# to install.log and exits 1, leaving the live certificate untouched (Req 13.11).
cat >"$CH_TLS_RENEW" <<'TLSRENEWEOF'
#!/bin/bash
set -euo pipefail

host='${hostname}'
lego_dir='${LEGO_DIR}'
log_file='${LOG_FILE}'

# shellcheck source=/dev/null  # tls.env is a runtime file, not in the repo
. '${TLS_ENV}'

days="\${CH_TLS_RENEW_DAYS:-30}"

set +e
lego --accept-tos --email '${adminEmail}' --domains "\$host" \\
  --key-type ec256 --path "\$lego_dir" --server "\$CH_TLS_SERVER" \\
  ${isDns01 ? dns01RenewFlags : http01WebrootFlags} \\
  renew --days "\$days" --renew-hook '${DEPLOY_SCRIPT}'
rc=\$?
set -e

if [ "\$rc" -ne 0 ]; then
  printf 'TLS renewal failed for %s (%s, exit %s)\\n' \\
    "\$host" "\$CH_TLS_CHALLENGE" "\$rc" >>"\$log_file"
  exit 1
fi
TLSRENEWEOF
chmod 0700 "$CH_TLS_RENEW"

cat >/etc/systemd/system/community-hub-tls-renew.service <<'TLSRENEWUNITEOF'
[Unit]
Description=Community Hub TLS certificate renewal (${hostname})
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${RENEW_SCRIPT}
TLSRENEWUNITEOF

cat >/etc/systemd/system/community-hub-tls-renew.timer <<'TLSRENEWTIMEREOF'
[Unit]
Description=Community Hub TLS certificate renewal timer (${hostname})

[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
TLSRENEWTIMEREOF

systemctl daemon-reload
systemctl enable --now community-hub-tls-renew.timer
`;
}
