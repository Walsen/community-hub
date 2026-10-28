/**
 * Shared on-instance paths and TLS capability constants for the Flarum engine.
 *
 * Kept in one module so the install script, the email-refresh renderer and the
 * adapter ({@link EngineAdapter.tls}, task 11.3) all agree on the same host
 * paths, reload command and HTTP-01 webroot. Nothing here is a secret value.
 *
 * TLS design (design "Decision: TLS with Let's Encrypt on the instance" and the
 * per-engine TLS table): the shared certificate manager issues and renews the
 * certificate on the host and copies the files into {@link FLARUM_CERT_DIR}.
 * That directory is bind-mounted read-only into the Caddy `proxy` container as
 * `/certs`, and the `Caddyfile`'s `https://` site serves it with
 * `tls /certs/fullchain.pem /certs/privkey.pem`. Because Flarum serves an
 * externally supplied certificate, it supports the ACME DNS-01 challenge in the
 * Route 53 DNS modes (`dns01: true`); when DNS-01 is unavailable the manager
 * falls back to HTTP-01 against {@link FLARUM_HTTP01_WEBROOT}, which the
 * `http://` Caddy site exposes under `/.well-known/acme-challenge/` from the
 * `/acme` bind mount.
 *
 * The certificate directory and paths are hostname-independent: exactly one
 * forum runs per instance, so a fixed `/etc/community-hub/tls` directory is
 * already unique to that forum. This lets {@link EngineAdapter.tls} carry the
 * static {@link FLARUM_CERT_PATHS} the contract's `TlsSupport.certPaths`
 * requires without knowing the host name at adapter-construction time, matching
 * the Discourse adapter's static `certPaths`.
 */

/** Root of the generated Flarum compose project on the instance. */
export const FLARUM_ROOT = '/opt/community-hub/flarum' as const;

/**
 * Host directory the TLS manager copies the certificate into. Bind-mounted
 * read-only into the Caddy `proxy` container as `/certs`. One forum runs per
 * instance, so this fixed path is already unique to that forum and carries no
 * `<hostname>` segment.
 */
export const FLARUM_CERT_DIR = '/etc/community-hub/tls' as const;

/**
 * Host directory the Caddy `http://` site serves `/.well-known/acme-challenge/`
 * from (bind-mounted as `/acme`). Matches `TlsSupport.http01Webroot`.
 */
export const FLARUM_HTTP01_WEBROOT = '/var/lib/community-hub/acme-webroot' as const;

/**
 * Host paths the TLS deploy hook installs the certificate into (full chain
 * `0644`, private key `0600`). Static, so it slots directly into the adapter's
 * `TlsSupport.certPaths`. Matches the files the `Caddyfile` serves from the
 * `/certs` bind mount.
 */
export const FLARUM_CERT_PATHS = {
  fullchain: `${FLARUM_CERT_DIR}/fullchain.pem`,
  privkey: `${FLARUM_CERT_DIR}/privkey.pem`,
} as const;

/**
 * Command the TLS renewal hook runs after a renewed certificate is copied into
 * the cert directory. `caddy reload` skips unchanged configuration, so `--force`
 * is required for Caddy to re-read the certificate files. Run inside the
 * `proxy` container through the compose project. Matches `TlsSupport.reloadCommand`.
 */
export const FLARUM_RELOAD_COMMAND =
  `docker compose -f ${FLARUM_ROOT}/docker-compose.yml exec -T proxy ` +
  `caddy reload --config /etc/caddy/Caddyfile --force`;
