/**
 * Pinned versions and digests for the Discourse engine.
 *
 * This module is the single source of version truth for everything the
 * Discourse install script lays down on the instance. Every value is an
 * explicit pin: no `latest` tags, no floating ranges, and downloaded artefacts
 * are tied to a commit SHA or image tag. A change here is the only place a
 * Discourse version moves, which keeps the rendered user data reproducible and
 * auditable.
 *
 * The shared prelude (`src/infra/user-data/`, task 16.1) installs the Docker
 * Engine, AWS CLI and SSM agent from the apt / package pins below. The install
 * script (`install-script.ts`) consumes {@link DISCOURSE_DOCKER_COMMIT} and
 * {@link DISCOURSE_VERSION_TAG}.
 */

/**
 * Docker Engine apt package version (the `5:<version>` epoch-qualified string
 * used with `apt-get install docker-ce=<version>`), pinned for the prelude's
 * Docker install step. Matches the Compose plugin pulled from the same repo.
 */
export const DOCKER_ENGINE_APT_VERSION = '5:27.5.1-1~ubuntu.22.04~jammy' as const;

/**
 * Docker Compose plugin apt package version, installed from Docker's apt repo
 * alongside the engine.
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
 * The `discourse/discourse_docker` git commit SHA the install script checks out
 * into `/var/discourse`. Pinning the launcher repo to a commit (rather than a
 * branch) fixes the `app.yml` template set and `launcher` behaviour.
 */
export const DISCOURSE_DOCKER_COMMIT = '8ae1fa150db91b333bae13e7339deb808dd4850c' as const;

/**
 * The Discourse release tag written as `params.version` in `containers/app.yml`.
 * The `launcher` bootstrap checks out this tag of the Discourse application
 * inside the container. A stable release tag, never `latest` or a branch.
 */
export const DISCOURSE_VERSION_TAG = 'v2026.10.0' as const;

/**
 * Default admin username when `engineOptions.adminUsername` is not set. Kept
 * here so the install script and the adapter (task 10.3) agree on one default.
 */
export const DISCOURSE_DEFAULT_ADMIN_USERNAME = 'admin' as const;
