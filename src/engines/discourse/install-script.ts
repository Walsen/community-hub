/**
 * Pure renderer for the Discourse install bash fragment.
 *
 * {@link renderInstallScript} returns the engine-specific bash that is appended
 * after the shared prelude and the TLS section (composed by task 16.3). It is a
 * pure string builder: no CDK tokens, no secret values. It references secrets
 * only by Secret_Reference and placeholder and fetches their values on the
 * instance through the prelude helpers `fetch_secret`, `write_secret` and
 * `issue_certificate`.
 *
 * Steps (design "Discourse adapter"):
 *  1. Clone `discourse_docker` and check out the pinned commit into
 *     `/var/discourse` (idempotent: skip if already at that SHA).
 *  2. Render `containers/app.yml` (`0600`) with the postgres, redis, web,
 *     web.ratelimited and web.ssl templates (no web.letsencrypt.ssl),
 *     `params.version` pinned, the acme-webroot volume, the port-80 challenge
 *     `run: replace` hook, and the SES env block with placeholders. Write
 *     `refresh-email.sh` + its systemd unit and run it `--no-restart`.
 *  3. `issue_certificate` (installs the cert into {@link DISCOURSE_CERT_PATHS})
 *     BEFORE any listener binds port 80/443, then `./launcher rebuild app`
 *     (skip if healthy).
 *  4. Bootstrap the admin user and a global API key with an idempotent Ruby
 *     script, `write_secret` the key, and `shred -u` the temp files.
 *
 * The fragment runs under the composed script's `set -euo pipefail`, ERR trap
 * and `fail()`; it stays shellcheck-clean on its own.
 *
 * NOTE for task 10.3 (`adapter.ts`): the adapter's {@link TlsSupport} must match
 * the paths exported here — {@link DISCOURSE_CERT_PATHS} (fullchain =
 * `ssl.crt`, privkey = `ssl.key`), {@link DISCOURSE_RELOAD_COMMAND} and
 * {@link DISCOURSE_HTTP01_WEBROOT} — and set `dns01: true`.
 */

import { renderEmailRefreshScript } from './email-refresh.js';
import {
  DISCOURSE_DEFAULT_ADMIN_USERNAME,
  DISCOURSE_DOCKER_COMMIT,
  DISCOURSE_VERSION_TAG,
} from './versions.js';
import type { InstallScriptInput } from '../engine-adapter.js';

/**
 * Path to the shared prelude helpers sourced by the standalone
 * `refresh-email.sh`. The composed user data (task 16.3) writes the prelude
 * functions (`fetch_secret`, `fail`, the ERR trap, logging) to this file so the
 * boot-time systemd unit can resolve them outside the one-shot install run.
 */
const PRELUDE_LIB = '/usr/local/lib/community-hub/prelude.sh';

/** Container launcher checkout path. */
const DISCOURSE_ROOT = '/var/discourse';
/** Rendered container definition. */
const APP_YML = `${DISCOURSE_ROOT}/containers/app.yml`;
/** Host directory mapped into the container as the ACME HTTP-01 webroot. */
const CONTAINER_ACME_WEBROOT = '/var/www/acme-webroot';

/**
 * Host directory the TLS manager serves `/.well-known/acme-challenge/` from for
 * HTTP-01. Matches `TlsSupport.http01Webroot` (task 10.3).
 */
export const DISCOURSE_HTTP01_WEBROOT = '/var/lib/community-hub/acme-webroot' as const;

/**
 * Host paths the TLS deploy hook installs the certificate into. Discourse's
 * `web.ssl` template reads `/shared/ssl/ssl.{crt,key}` inside the container,
 * which is this directory on the host's single shared volume. Matches
 * `TlsSupport.certPaths` (task 10.3): fullchain is the `.crt`, privkey the
 * `.key`.
 */
export const DISCOURSE_CERT_PATHS = {
  fullchain: `${DISCOURSE_ROOT}/shared/standalone/ssl/ssl.crt`,
  privkey: `${DISCOURSE_ROOT}/shared/standalone/ssl/ssl.key`,
} as const;

/**
 * Command the TLS renewal hook runs to reload nginx inside the Discourse
 * container. Matches `TlsSupport.reloadCommand` (task 10.3).
 */
export const DISCOURSE_RELOAD_COMMAND = 'docker exec app sv reload nginx' as const;

/** On-host directory for the bootstrap Ruby script and its output. */
const SHARED_CH_DIR = `${DISCOURSE_ROOT}/shared/standalone/community-hub`;
/** tmpfs scratch for the admin password and the extracted API key. */
const RUN_DIR = '/run/community-hub';

/** engineOptions shape this renderer reads (validated by the adapter, 10.3). */
interface DiscourseEngineOptions {
  readonly adminUsername?: string;
  readonly version?: string;
}

function readOptions(engineOptions: unknown): Required<DiscourseEngineOptions> {
  const opts = (engineOptions ?? {}) as DiscourseEngineOptions;
  return {
    adminUsername: opts.adminUsername ?? DISCOURSE_DEFAULT_ADMIN_USERNAME,
    version: opts.version ?? DISCOURSE_VERSION_TAG,
  };
}

/**
 * Render the Discourse install fragment.
 *
 * @param input - Derived settings and Secret_References for the forum; no
 *   secret values.
 * @returns A pure bash fragment appended after the prelude and TLS section.
 */
export function renderInstallScript(input: InstallScriptInput): string {
  const { hostname, adminEmail, email, secrets } = input;
  const { adminUsername, version } = readOptions(input.engineOptions);

  const adminPasswordRef = secrets.adminPassword;
  const apiKeyRef = secrets.apiKey;
  if (adminPasswordRef === undefined || apiKeyRef === undefined) {
    // Guarded by the loader (requiredSecrets); fail loudly if ever reached.
    throw new Error('Discourse install requires adminPassword and apiKey references');
  }
  const adminPasswordStore = adminPasswordRef.store;
  const adminPasswordId = adminPasswordRef.id;
  const apiKeyStore = apiKeyRef.store;
  const apiKeyId = apiKeyRef.id;

  return `# ====================================================================
# Discourse install (engine fragment, runs after prelude + TLS section)
# ====================================================================
readonly CH_DISCOURSE_ROOT='${DISCOURSE_ROOT}'
readonly CH_DISCOURSE_COMMIT='${DISCOURSE_DOCKER_COMMIT}'
readonly CH_SHARED_CH_DIR='${SHARED_CH_DIR}'
readonly CH_RUN_DIR='${RUN_DIR}'

# ---- Step 1: discourse_docker at the pinned commit (idempotent) ------
# The prelude and TLS sections run earlier under umask 077. Discourse's shared
# volume (/var/discourse/shared/standalone) is bind-mounted into the container
# where unprivileged postgres/redis users must TRAVERSE it to reach their data
# dirs; created at 0700 root they get "Permission denied" and the rebuild fails
# (Redis: 'dir /shared/redis_data' Permission denied; psql socket denied). Create
# the repo and shared tree with a standard umask so the directories are 0755.
# app.yml and secret files below set their own restrictive modes explicitly.
umask 022
if [ ! -d "$CH_DISCOURSE_ROOT/.git" ]; then
  git clone https://github.com/discourse/discourse_docker.git "$CH_DISCOURSE_ROOT"
fi
cd "$CH_DISCOURSE_ROOT"
current_commit="$(git rev-parse HEAD 2>/dev/null || echo none)"
if [ "$current_commit" != "$CH_DISCOURSE_COMMIT" ]; then
  git fetch --depth 1 origin "$CH_DISCOURSE_COMMIT"
  git checkout --quiet "$CH_DISCOURSE_COMMIT"
fi

mkdir -p "$CH_DISCOURSE_ROOT/containers" "$CH_SHARED_CH_DIR/out" "$CH_RUN_DIR"
mkdir -p '${DISCOURSE_HTTP01_WEBROOT}'
# Ensure the shared volume parents are traversable even if a prior boot created
# them 0700 (idempotent across reboots and re-runs).
chmod 0755 "$CH_DISCOURSE_ROOT" "$CH_DISCOURSE_ROOT/shared" "$CH_DISCOURSE_ROOT/shared/standalone" 2>/dev/null || true

# ---- Step 2: render containers/app.yml (0600) ------------------------
# No web.letsencrypt.ssl: the certificate comes from the shared TLS manager and
# is installed into shared/standalone/ssl/ssl.{crt,key}. SMTP user/password are
# placeholders filled by refresh-email.sh; no secret value appears here.
umask 077
cat >'${APP_YML}' <<'APPYML'
templates:
  - "templates/postgres.template.yml"
  - "templates/redis.template.yml"
  - "templates/web.template.yml"
  - "templates/web.ratelimited.template.yml"
  - "templates/web.ssl.template.yml"

expose:
  - "80:80"
  - "443:443"

params:
  version: ${version}

env:
  LANG: en_US.UTF-8
  UNICORN_WORKERS: 2
  DISCOURSE_HOSTNAME: ${hostname}
  DISCOURSE_DEVELOPER_EMAILS: "${adminEmail}"
  DISCOURSE_SMTP_ADDRESS: ${email.host}
  DISCOURSE_SMTP_PORT: ${String(email.port)}
  DISCOURSE_SMTP_ENABLE_START_TLS: "true"
  DISCOURSE_SMTP_USER_NAME: "CH_SMTP_USER_PLACEHOLDER"
  DISCOURSE_SMTP_PASSWORD: "CH_SMTP_PASSWORD_PLACEHOLDER"
  DISCOURSE_NOTIFICATION_EMAIL: ${email.senderAddress}

volumes:
  - volume:
      host: /var/discourse/shared/standalone
      guest: /shared
  - volume:
      host: /var/discourse/shared/standalone/log/var-log
      guest: /var/log
  - volume:
      host: ${DISCOURSE_HTTP01_WEBROOT}
      guest: ${CONTAINER_ACME_WEBROOT}

run:
  - replace:
      filename: "/etc/nginx/conf.d/discourse.conf"
      from: /listen 80;/
      to: |
        listen 80;
        location /.well-known/acme-challenge/ { root ${CONTAINER_ACME_WEBROOT}; }
APPYML

# ---- Step 2b: refresh-email.sh + oneshot unit, then initial no-restart run
# The body sources the shared prelude so the boot-time unit has fetch_secret and
# fail() available outside the one-shot install run.
install -d -m 0755 /opt/community-hub/bin
cat >/opt/community-hub/bin/refresh-email.sh <<'REFRESHEOF'
#!/bin/bash
set -euo pipefail
# The shared prelude requires the CH_ header variables (CH_REGION drives
# fetch_secret). This script is standalone: it is invoked by the install run as
# a child process and by the community-hub-email-refresh.service oneshot unit,
# and NEITHER provides CH_REGION in the environment. Declare the non-secret,
# deterministic header here so sourcing the prelude never aborts on the
# CH_REGION guard (a real deploy failed at 'refresh-email.sh --no-restart').
readonly CH_ENV='${input.environmentName}' CH_FORUM='${input.forumId}' CH_REGION='${input.region}' CH_HOST='${input.hostname}'
# shellcheck source=/dev/null
. '${PRELUDE_LIB}'

${indentNone(renderEmailRefreshScript(input))}
REFRESHEOF
chmod 0700 /opt/community-hub/bin/refresh-email.sh

cat >/etc/systemd/system/community-hub-email-refresh.service <<'UNITEOF'
[Unit]
Description=Community Hub SES credential refresh (Discourse)
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/community-hub/bin/refresh-email.sh

[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload
systemctl enable community-hub-email-refresh.service

# Initial fill of the SMTP placeholders without a restart (rebuild follows).
/opt/community-hub/bin/refresh-email.sh --no-restart

# ---- Step 3: certificate BEFORE any port 80/443 listener ------------
# issue_certificate installs ssl.crt/ssl.key into shared/standalone/ssl/.
# web.ssl refuses to start without the certificate, so the order is required.
issue_certificate

if docker inspect -f '{{.State.Health.Status}}' app 2>/dev/null | grep -q healthy; then
  echo "discourse app container already healthy; skipping rebuild"
else
  cd "$CH_DISCOURSE_ROOT"
  ./launcher rebuild app
fi

# ---- Step 4: admin user + global API key (idempotent) ---------------
# Admin password is fetched to a 0600 tmpfs file and passed to the Ruby script
# by path through a container mount; never in argv.
fetch_secret ${adminPasswordStore} '${adminPasswordId}' "$CH_RUN_DIR/admin-password"
install -m 0600 "$CH_RUN_DIR/admin-password" "$CH_SHARED_CH_DIR/admin-password"

cat >"$CH_SHARED_CH_DIR/bootstrap.rb" <<'RUBYEOF'
# Idempotent admin + API key bootstrap. Reads the admin password from a mounted
# 0600 file; writes the new API key to a 0600 file. No secret reaches argv.
username = ${jsonString(adminUsername)}
email = ${jsonString(adminEmail)}
password = File.read('/shared/community-hub/admin-password').strip

user = User.find_or_initialize_by(username: username)
user.email = email if user.email.blank?
user.password = password
user.active = true
user.approved = true
user.admin = true
user.save!
user.email_tokens.update_all(confirmed: true)
user.activate

ApiKey.where(description: 'community-hub-seeder').find_each(&:destroy!)
api_key = ApiKey.create!(description: 'community-hub-seeder', created_by: user)

require 'fileutils'
FileUtils.mkdir_p('/shared/community-hub/out')
File.open('/shared/community-hub/out/api-key', File::WRONLY | File::CREAT | File::TRUNC, 0o600) do |f|
  f.write(api_key.key)
end
RUBYEOF
chmod 0600 "$CH_SHARED_CH_DIR/bootstrap.rb"

# rails runner below runs as the in-container 'discourse' user (uid 1000). The
# files above were written by root at 0600, which that user cannot read, and the
# 'out' dir must be writable by it for the generated API key. The shared volume
# is a host bind mount so uids match: give the community-hub files and out dir to
# uid/gid 1000, keeping the secret-bearing files at 0600 (now 0600 discourse, not
# world-readable). Without this the bootstrap failed with a LoadError on its own
# script (root-owned 0600, unreadable by discourse).
chown 1000:1000 \
  "$CH_SHARED_CH_DIR/bootstrap.rb" \
  "$CH_SHARED_CH_DIR/admin-password" \
  "$CH_SHARED_CH_DIR/out"

docker exec app su discourse -c 'cd /var/www/discourse && bundle exec rails runner /shared/community-hub/bootstrap.rb'

install -m 0600 "$CH_SHARED_CH_DIR/out/api-key" "$CH_RUN_DIR/api-key"
write_secret ${apiKeyStore} '${apiKeyId}' "$CH_RUN_DIR/api-key"

shred -u \\
  "$CH_RUN_DIR/api-key" \\
  "$CH_RUN_DIR/admin-password" \\
  "$CH_SHARED_CH_DIR/out/api-key" \\
  "$CH_SHARED_CH_DIR/admin-password" \\
  "$CH_SHARED_CH_DIR/bootstrap.rb" 2>/dev/null || true

echo "discourse install complete for ${hostname}"
`;
}

/**
 * The refresh body is top-level bash and is embedded verbatim inside the
 * quoted here-document. This passthrough exists to make that intent explicit at
 * the call site and to leave one place to hook future normalization.
 */
function indentNone(body: string): string {
  return body;
}

/** JSON-encode a string for safe embedding as a Ruby/JSON literal. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}
