/**
 * Pinned versions and digests for the Flarum engine.
 *
 * This module is the single source of version truth for everything the Flarum
 * install script lays down on the instance. Every value is an explicit pin: no
 * `latest` tags, no floating ranges. Changing a Flarum version happens only
 * here, which keeps the rendered user data reproducible and auditable.
 *
 * The shared prelude (`src/infra/user-data/`, task 16.1) installs the Docker
 * Engine, AWS CLI and SSM agent from the apt / package pins below (kept in sync
 * with the Discourse pins so the prelude behaves identically whatever engine a
 * forum runs). The install script (`install-script.ts`) consumes the Flarum
 * image and version pins.
 */

/**
 * Docker Engine apt package version (the `5:<version>` epoch-qualified string
 * used with `apt-get install docker-ce=<version>`), pinned for the prelude's
 * Docker install step. Matches the Compose plugin pulled from the same repo.
 * Kept identical to the Discourse pin so the shared prelude is engine-agnostic.
 */
export const DOCKER_ENGINE_APT_VERSION = '5:27.5.1-1~ubuntu.22.04~jammy' as const;

/**
 * Docker Compose plugin apt package version, installed from Docker's apt repo
 * alongside the engine. Flarum uses `docker compose` (the plugin) directly.
 */
export const DOCKER_COMPOSE_APT_VERSION = '2.32.4-1~ubuntu.22.04~jammy' as const;

/**
 * AWS CLI v2 version the prelude installs (pinned installer download). Used by
 * `fetch_secret` / `write_secret` and lego's Route 53 provider.
 */
export const AWS_CLI_VERSION = '2.24.5' as const;

/**
 * Amazon SSM agent `.deb` version the prelude registers the hybrid managed node
 * with, when the preinstalled snap is not present.
 */
export const SSM_AGENT_VERSION = '3.3.1611.0' as const;

/**
 * Composer image tag used in the Dockerfile's build stage to run
 * `composer create-project`. Pinned to an explicit release tag, never `latest`.
 */
export const COMPOSER_IMAGE_TAG = '2.8.4' as const;

/**
 * The Flarum release the build stage installs via
 * `composer create-project flarum/flarum:<FLARUM_VERSION>`. An exact release,
 * not a `^`/`~` range or `*`, so every build resolves the same tree. This is
 * also the adapter's default `engineOptions.version` (task 11.3).
 */
export const FLARUM_VERSION = 'v1.8.5' as const;

/**
 * Runtime PHP image tag for the Flarum `app` service. The Dockerfile's runtime
 * stage builds `php:<PHP_IMAGE_TAG>-apache-bookworm` and enables `pdo_mysql`,
 * `gd`, `zip` and `mod_rewrite`. Pinned to a specific patch release.
 */
export const PHP_IMAGE_TAG = '8.3.15' as const;

/**
 * MySQL image tag for the Flarum `db` service (named `db-data` volume plus a
 * healthcheck). Pinned to a specific release line Flarum supports.
 */
export const MYSQL_IMAGE_TAG = '8.0.40' as const;

/**
 * Caddy image tag for the Flarum `proxy` service. Caddy terminates TLS with the
 * shared manager's certificate (`auto_https off`) and reverse-proxies the app.
 */
export const CADDY_IMAGE_TAG = '2.8.4' as const;

/**
 * Default admin username when `engineOptions.adminUsername` is not set. Kept
 * here so the install script and the adapter (task 11.3) agree on one default.
 */
export const FLARUM_DEFAULT_ADMIN_USERNAME = 'admin' as const;
