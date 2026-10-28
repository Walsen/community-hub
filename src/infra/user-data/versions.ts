/**
 * Shared, engine-agnostic pinned versions for the on-instance user data.
 *
 * This module is the single source of version truth for everything the shared
 * prelude (`prelude.ts`) and the TLS section (`tls.ts`, task 16.2) lay down on
 * the instance, independent of which forum engine runs there. Every value is an
 * explicit pin: no `latest` tags, no floating ranges, and the downloaded `lego`
 * binary is tied to a release tag plus a SHA-256 of its tarball so the TLS
 * install can `sha256sum -c` before it runs (Req 13.1).
 *
 * The Docker / AWS CLI / SSM agent pins are deliberately kept identical to the
 * per-engine `engines/<engine>/versions.ts` values so the prelude behaves the
 * same whatever engine a forum runs. When those engine pins move, update these
 * to match in the same `chore:` commit.
 */

/**
 * The `lego` ACME client release the TLS section downloads and runs on the
 * instance (`https://github.com/go-acme/lego/releases/download/<version>/`).
 * A tagged release, never a branch or `latest`, so the certificate tooling is
 * reproducible and the checksum below stays valid.
 */
export const LEGO_VERSION = 'v4.21.0' as const;

/**
 * SHA-256 of the `lego_<version>_linux_amd64.tar.gz` release asset, used by the
 * TLS section's `sha256sum -c` step (Req 13.1) before the binary is trusted.
 *
 * NOTE: this is a placeholder-shaped 64-hex digest. It MUST be replaced with
 * the real checksum of the pinned {@link LEGO_VERSION} `linux_amd64` tarball
 * (published in the release's `*_checksums.txt`) and verified before any
 * deploy. A deploy with a mismatched or placeholder checksum fails the
 * `sha256sum -c` gate on the instance by design.
 */
export const LEGO_SHA256_LINUX_AMD64 =
  'c8cc7fb636f8a5f1167e013dbd01485a72eb7393faf1776664c765a722cd6070' as const;

/**
 * Docker Engine apt package version (the `5:<version>` epoch-qualified string
 * used with `apt-get install docker-ce=<version>`), pinned for the prelude's
 * Docker install step. Kept identical to the engine pins so the shared prelude
 * is engine-agnostic.
 */
export const DOCKER_ENGINE_APT_VERSION = '5:27.5.1-1~ubuntu.22.04~jammy' as const;

/**
 * Docker Compose plugin apt package version, installed from Docker's apt repo
 * alongside the engine. Matches the engine pins.
 */
export const DOCKER_COMPOSE_APT_VERSION = '2.32.4-1~ubuntu.22.04~jammy' as const;

/**
 * AWS CLI v2 version the prelude installs (pinned installer download). Used by
 * `fetch_secret` / `write_secret`, the broker claim, and lego's Route 53
 * provider in the TLS section.
 */
export const AWS_CLI_VERSION = '2.24.5' as const;

/**
 * Amazon SSM agent `.deb` version the prelude registers the hybrid managed node
 * with, when the preinstalled snap is not present.
 */
export const SSM_AGENT_VERSION = '3.3.1611.0' as const;
