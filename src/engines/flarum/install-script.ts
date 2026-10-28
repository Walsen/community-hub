/**
 * Pure renderer for the Flarum install bash fragment.
 *
 * {@link renderInstallScript} returns the engine-specific bash that is appended
 * after the shared prelude and the TLS section (composed by task 16.3). It is a
 * pure string builder: no CDK tokens, no secret values. It references secrets
 * only by Secret_Reference and placeholder and fetches their values on the
 * instance through the prelude helpers `fetch_secret`, `write_secret` and
 * `issue_certificate`.
 *
 * Steps (design "Flarum adapter"):
 *  1. Write `/opt/community-hub/flarum/` with a multi-stage `Dockerfile`
 *     (pinned `composer` build stage → `composer create-project
 *     flarum/flarum:<pinned>`; runtime pinned `php:<tag>-apache-bookworm` with
 *     `pdo_mysql`, `gd`, `zip`, `mod_rewrite`), `docker-compose.yml`,
 *     `Caddyfile`, and a `0600` `.env` whose DB password comes from
 *     `fetch_secret`.
 *  2. Compose `app` (built image, named volumes `flarum-assets` /
 *     `flarum-storage`), `db` (pinned `mysql`, named `db-data` volume,
 *     healthcheck) and `proxy` (pinned `caddy`, ports 80/443, `caddy-data` /
 *     `caddy-config` volumes, read-only bind mounts
 *     `/etc/community-hub/tls:/certs` and the acme webroot
 *     `:/acme`). The `Caddyfile` uses `auto_https off`, an `http://` site
 *     serving the challenge from `/acme` and 308-redirecting otherwise, and an
 *     `https://` site serving the host-issued certificate and reverse-proxying
 *     `app:80`.
 *  3. `docker compose up -d --build db app`; wait for DB health; run
 *     `php flarum install --file=/run/community-hub/install.yml` only if
 *     `config.php` is absent (the `0600` install file holds DB + admin
 *     credentials and is shredded afterwards).
 *  4. Email: write `refresh-email.sh` + its systemd unit, then run it. It
 *     upserts the `mail_*` settings and clears the cache.
 *  5. API key: `openssl rand -hex 20` into a `0600` tmpfs file, delete the
 *     admin user's existing keys and insert the new one into `api_keys` via
 *     stdin SQL, `write_secret <apiKey ref>`, then `shred -u`.
 *  6. `issue_certificate` (port 80 is still free, so HTTP-01 uses lego's own
 *     listener), then `docker compose up -d proxy`.
 *
 * The fragment runs under the composed script's `set -euo pipefail`, ERR trap
 * and `fail()`; it stays shellcheck-clean on its own.
 *
 * NOTE for task 11.3 (`adapter.ts`): the adapter's {@link TlsSupport} must match
 * the values exported from `paths.ts` — the static `FLARUM_CERT_PATHS`,
 * {@link FLARUM_RELOAD_COMMAND} and {@link FLARUM_HTTP01_WEBROOT} — and set
 * `dns01: true`, because Flarum serves the externally supplied certificate
 * through Caddy's static `tls` directive.
 */

import { renderEmailRefreshScript } from './email-refresh.js';
import { FLARUM_CERT_DIR, FLARUM_HTTP01_WEBROOT, FLARUM_ROOT } from './paths.js';
import {
  CADDY_IMAGE_TAG,
  COMPOSER_IMAGE_TAG,
  FLARUM_DEFAULT_ADMIN_USERNAME,
  FLARUM_VERSION,
  MYSQL_IMAGE_TAG,
  PHP_IMAGE_TAG,
} from './versions.js';
import type { InstallScriptInput } from '../engine-adapter.js';

/**
 * Path to the shared prelude helpers sourced by the standalone
 * `refresh-email.sh`. The composed user data (task 16.3) writes the prelude
 * functions (`fetch_secret`, `fail`, the ERR trap, logging) to this file so the
 * boot-time systemd unit can resolve them outside the one-shot install run.
 */
const PRELUDE_LIB = '/usr/local/lib/community-hub/prelude.sh';

/** tmpfs scratch for fetched secrets and the generated API key. */
const RUN_DIR = '/run/community-hub';

/** engineOptions shape this renderer reads (validated by the adapter, 11.3). */
interface FlarumEngineOptions {
  readonly adminUsername?: string;
  readonly version?: string;
}

function readOptions(engineOptions: unknown): Required<FlarumEngineOptions> {
  const opts = (engineOptions ?? {}) as FlarumEngineOptions;
  return {
    adminUsername: opts.adminUsername ?? FLARUM_DEFAULT_ADMIN_USERNAME,
    version: opts.version ?? FLARUM_VERSION,
  };
}

/** JSON-encode a string for safe embedding as a JSON/YAML scalar literal. */
function jsonString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the Flarum install fragment.
 *
 * @param input - Derived settings and Secret_References for the forum; no
 *   secret values.
 * @returns A pure bash fragment appended after the prelude and TLS section.
 */
export function renderInstallScript(input: InstallScriptInput): string {
  const { hostname, adminEmail, secrets } = input;
  const { adminUsername, version } = readOptions(input.engineOptions);

  const adminPasswordRef = secrets.adminPassword;
  const apiKeyRef = secrets.apiKey;
  const databasePasswordRef = secrets.databasePassword;
  if (
    adminPasswordRef === undefined ||
    apiKeyRef === undefined ||
    databasePasswordRef === undefined
  ) {
    // Guarded by the loader (requiredSecrets); fail loudly if ever reached.
    throw new Error(
      'Flarum install requires adminPassword, apiKey and databasePassword references',
    );
  }

  const certDir = FLARUM_CERT_DIR;

  return `# ====================================================================
# Flarum install (engine fragment, runs after prelude + TLS section)
# ====================================================================
readonly CH_FLARUM_ROOT='${FLARUM_ROOT}'
readonly CH_RUN_DIR='${RUN_DIR}'
readonly CH_FLARUM_COMPOSE="${FLARUM_ROOT}/docker-compose.yml"

mkdir -p "$CH_FLARUM_ROOT" "$CH_RUN_DIR"
mkdir -p '${FLARUM_HTTP01_WEBROOT}' '${certDir}'

# ---- Step 1: project files (Dockerfile, compose, Caddyfile, .env) ----
umask 077

cat >"$CH_FLARUM_ROOT/Dockerfile" <<'DOCKERFILE'
# syntax=docker/dockerfile:1

# Build stage: pinned composer resolves the Flarum skeleton at a fixed release.
FROM composer:${COMPOSER_IMAGE_TAG} AS build
RUN composer create-project --no-interaction --no-dev --prefer-dist \\
      flarum/flarum:${version} /var/www/flarum

# Runtime stage: pinned PHP + Apache with the extensions Flarum requires.
FROM php:${PHP_IMAGE_TAG}-apache-bookworm
RUN set -eux; \\
    apt-get update; \\
    apt-get install -y --no-install-recommends libzip-dev libpng-dev libjpeg-dev; \\
    docker-php-ext-configure gd --with-jpeg; \\
    docker-php-ext-install -j"$(nproc)" pdo_mysql gd zip; \\
    a2enmod rewrite; \\
    rm -rf /var/lib/apt/lists/*
COPY --from=build /var/www/flarum /var/www/flarum
RUN set -eux; \\
    sed -ri 's!/var/www/html!/var/www/flarum/public!g' \\
      /etc/apache2/sites-available/000-default.conf /etc/apache2/apache2.conf; \\
    printf '%s\\n' '<Directory /var/www/flarum/public>' '  AllowOverride All' '</Directory>' \\
      >/etc/apache2/conf-available/flarum.conf; \\
    a2enconf flarum; \\
    chown -R www-data:www-data /var/www/flarum
WORKDIR /var/www/flarum
DOCKERFILE

cat >"$CH_FLARUM_ROOT/docker-compose.yml" <<'COMPOSEFILE'
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    image: community-hub/flarum:${version}
    restart: unless-stopped
    env_file:
      - .env
    depends_on:
      db:
        condition: service_healthy
    volumes:
      - flarum-assets:/var/www/flarum/public/assets
      - flarum-storage:/var/www/flarum/storage
    networks:
      - internal

  db:
    image: mysql:${MYSQL_IMAGE_TAG}
    restart: unless-stopped
    env_file:
      - .env
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    volumes:
      - db-data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "--silent"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 30s
    networks:
      - internal

  proxy:
    image: caddy:${CADDY_IMAGE_TAG}
    restart: unless-stopped
    depends_on:
      - app
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ${certDir}:/certs:ro
      - ${FLARUM_HTTP01_WEBROOT}:/acme:ro
      - caddy-data:/data
      - caddy-config:/config
    networks:
      - internal

volumes:
  flarum-assets:
  flarum-storage:
  db-data:
  caddy-data:
  caddy-config:

networks:
  internal:
COMPOSEFILE

# Caddy serves the shared manager's certificate (auto_https off). The http site
# answers the ACME HTTP-01 challenge from /acme and 308-redirects everything
# else; the https site terminates TLS with the copied cert and proxies the app.
cat >"$CH_FLARUM_ROOT/Caddyfile" <<'CADDYFILE'
{
	auto_https off
}

http://${hostname} {
	handle /.well-known/acme-challenge/* {
		root * /acme
		file_server
	}
	handle {
		redir https://${hostname}{uri} 308
	}
}

https://${hostname} {
	tls /certs/fullchain.pem /certs/privkey.pem
	reverse_proxy app:80
}
CADDYFILE

# .env (0600): DB credentials fetched on the instance. The DB password value is
# written here from fetch_secret; it is never present in the rendered template.
fetch_secret ${databasePasswordRef.store} '${databasePasswordRef.id}' "$CH_RUN_DIR/db-password"
db_password="$(cat "$CH_RUN_DIR/db-password")"
umask 077
cat >"$CH_FLARUM_ROOT/.env" <<ENVEOF
MYSQL_DATABASE=flarum
MYSQL_USER=flarum
MYSQL_PASSWORD=\${db_password}
MYSQL_ROOT_PASSWORD=\${db_password}
ENVEOF
chmod 0600 "$CH_FLARUM_ROOT/.env"
unset db_password
shred -u "$CH_RUN_DIR/db-password" 2>/dev/null || true

# ---- Step 3: bring up db + app, then install Flarum if needed --------
cd "$CH_FLARUM_ROOT"
docker compose -f "$CH_FLARUM_COMPOSE" up -d --build db app

echo "waiting for the flarum database to become healthy"
for _ in $(seq 1 60); do
  status="$(docker compose -f "$CH_FLARUM_COMPOSE" ps --format '{{.Health}}' db 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 5
done
if [ "$status" != "healthy" ]; then
  fail "flarum database did not become healthy in time"
fi

# Install only on first boot (config.php is created by \`flarum install\`). The
# install file carries DB + admin credentials; it lives in 0600 tmpfs and is
# shredded afterwards. Admin password is fetched by reference, never argv.
if ! docker compose -f "$CH_FLARUM_COMPOSE" exec -T app test -f /var/www/flarum/config.php; then
  fetch_secret ${databasePasswordRef.store} '${databasePasswordRef.id}' "$CH_RUN_DIR/db-password"
  fetch_secret ${adminPasswordRef.store} '${adminPasswordRef.id}' "$CH_RUN_DIR/admin-password"

  CH_DB_PASS_FILE="$CH_RUN_DIR/db-password" CH_ADMIN_PASS_FILE="$CH_RUN_DIR/admin-password" \\
    CH_ADMIN_USER=${jsonString(adminUsername)} CH_ADMIN_EMAIL=${jsonString(adminEmail)} \\
    CH_BASE_URL=${jsonString(`https://${hostname}`)} python3 - >"$CH_RUN_DIR/install.yml" <<'PYEOF'
import json, os

def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read().strip()

doc = {
    "debug": False,
    "baseUrl": os.environ["CH_BASE_URL"],
    "databaseConfiguration": {
        "driver": "mysql",
        "host": "db",
        "port": 3306,
        "database": "flarum",
        "username": "flarum",
        "password": read(os.environ["CH_DB_PASS_FILE"]),
        "prefix": "",
    },
    "adminUser": {
        "username": json.loads(os.environ["CH_ADMIN_USER"]),
        "password": read(os.environ["CH_ADMIN_PASS_FILE"]),
        "email": json.loads(os.environ["CH_ADMIN_EMAIL"]),
    },
}

# Minimal valid YAML: every scalar is JSON-encoded, which is also valid YAML.
def emit(obj, indent=0):
    pad = "  " * indent
    lines = []
    for key, value in obj.items():
        if isinstance(value, dict):
            lines.append(pad + key + ":")
            lines.extend(emit(value, indent + 1))
        else:
            lines.append(pad + key + ": " + json.dumps(value))
    return lines

print("\\n".join(emit(doc)))
PYEOF
  chmod 0600 "$CH_RUN_DIR/install.yml"

  docker compose -f "$CH_FLARUM_COMPOSE" cp "$CH_RUN_DIR/install.yml" app:/run/community-hub-install.yml
  docker compose -f "$CH_FLARUM_COMPOSE" exec -T app php flarum install --file=/run/community-hub-install.yml
  docker compose -f "$CH_FLARUM_COMPOSE" exec -T app rm -f /run/community-hub-install.yml

  shred -u \\
    "$CH_RUN_DIR/install.yml" \\
    "$CH_RUN_DIR/db-password" \\
    "$CH_RUN_DIR/admin-password" 2>/dev/null || true
else
  echo "flarum already installed; skipping install"
fi

# ---- Step 4: refresh-email.sh + oneshot unit, then apply settings ----
install -d -m 0755 /opt/community-hub/bin
cat >/opt/community-hub/bin/refresh-email.sh <<'REFRESHEOF'
#!/bin/bash
set -euo pipefail
# The shared prelude requires the CH_ header variables (CH_REGION drives
# fetch_secret). This script is standalone: it is invoked by the install run as
# a child process and by the community-hub-email-refresh.service oneshot unit,
# and NEITHER provides CH_REGION in the environment. Declare the non-secret,
# deterministic header here so sourcing the prelude never aborts on the
# CH_REGION guard.
readonly CH_ENV='${input.environmentName}' CH_FORUM='${input.forumId}' CH_REGION='${input.region}' CH_HOST='${input.hostname}'
# shellcheck source=/dev/null
. '${PRELUDE_LIB}'

${renderEmailRefreshScript(input)}
REFRESHEOF
chmod 0700 /opt/community-hub/bin/refresh-email.sh

cat >/etc/systemd/system/community-hub-email-refresh.service <<'UNITEOF'
[Unit]
Description=Community Hub SES credential refresh (Flarum)
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

# Apply the current SES settings (no downtime for Flarum; clears cache).
/opt/community-hub/bin/refresh-email.sh

# ---- Step 5: admin API key (idempotent) ------------------------------
# A fresh random key is generated into a 0600 tmpfs file. The admin user's
# existing keys are removed and the new one inserted via stdin SQL; the key
# value is read from the file inside the python3 helper, never placed in argv.
umask 077
openssl rand -hex 20 >"$CH_RUN_DIR/api-key"

CH_API_KEY_FILE="$CH_RUN_DIR/api-key" CH_ADMIN_USER=${jsonString(adminUsername)} \\
  python3 - <<'PYEOF' | docker compose -f "$CH_FLARUM_COMPOSE" exec -T db \\
    sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE"'
import json, os

def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read().strip()

def q(value):
    return "'" + value.replace("\\\\", "\\\\\\\\").replace("'", "\\\\'") + "'"

api_key = read(os.environ["CH_API_KEY_FILE"])
admin = json.loads(os.environ["CH_ADMIN_USER"])

print(
    "SET @uid = (SELECT id FROM users WHERE username = " + q(admin) + " LIMIT 1);\\n"
    "DELETE FROM api_keys WHERE user_id = @uid;\\n"
    "INSERT INTO api_keys (\`key\`, user_id, created_at) VALUES ("
    + q(api_key) + ", @uid, NOW());"
)
PYEOF

write_secret ${apiKeyRef.store} '${apiKeyRef.id}' "$CH_RUN_DIR/api-key"
shred -u "$CH_RUN_DIR/api-key" 2>/dev/null || true

# ---- Step 6: certificate, then start the proxy ----------------------
# Port 80 is still free (proxy not up yet), so issue_certificate can use lego's
# own HTTP-01 listener (or DNS-01 in the Route 53 modes). The cert lands in
# ${certDir}, which is bind-mounted into the proxy as /certs.
issue_certificate
docker compose -f "$CH_FLARUM_COMPOSE" up -d proxy

echo "flarum install complete for ${hostname}"
`;
}
