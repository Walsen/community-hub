/**
 * Pure composer for the full instance user data.
 *
 * This module exports two functions:
 *
 *  - {@link composeInnerScript} builds the complete forum install bash script
 *    (header + prelude + TLS section + adapter install script). This is the
 *    script content that tests assert on (tasks 16.4/16.5/16.6) and that the
 *    `render:user-data` shellcheck task (16.7) lints. It is what an operator
 *    runs on the instance.
 *
 *  - {@link composeUserData} returns the SELF-EXTRACTING wrapper that Lightsail
 *    actually runs as launch user data. The inner script is ~30-33 KB, which
 *    exceeds Lightsail's 16 KB launch-script limit, so the wrapper gzip+base64
 *    encodes the inner script and decodes it on the instance to a `0700` file
 *    at `/usr/local/sbin/community-hub-install`, which it then executes. bash
 *    compresses heavily, so the encoded wrapper stays well under 16 KB.
 *
 * The inner script assembles four parts, in the order the boot sequence
 * requires (Req 13.13):
 *
 *   1. Header: the shebang, `set -euo pipefail`, and the `readonly CH_*`
 *      variables every later section references.
 *   2. The shared prelude ({@link renderPrelude}): logging, pinned installs and
 *      SSM hybrid-node registration, so the Route 53 credentials DNS-01 issuance
 *      needs exist before the TLS section runs.
 *   3. The certificate manager ({@link renderTlsScript}): defines
 *      `issue_certificate` and the renewal units.
 *   4. The adapter install script (already rendered by the engine adapter),
 *      which calls `issue_certificate` before starting any port-80/443 listener.
 *
 * Composition is plain string concatenation. Only the header carries values
 * that may be CDK tokens at synth time — the bootstrap broker URL and, for
 * DNS-01 forums, the hosted zone id. Both are non-secret and are embedded
 * verbatim inside single quotes; they are never validated or transformed here.
 * Everything else is concrete.
 *
 * This module is pure: it creates no constructs and performs no I/O. It uses
 * `node:zlib` for a deterministic gzip of the inner script — a pure
 * computation with no clock, randomness or filesystem access. `gzipSync` with a
 * fixed compression level and the default zero mtime produces identical bytes
 * for identical input, so `composeUserData` is deterministic. The
 * `CH_HOSTED_ZONE_ID` header line is emitted only for DNS-01 forums, matching
 * the prelude and TLS section which reference it only in that mode.
 */

import { gzipSync } from 'node:zlib';
import { renderPrelude } from './prelude.js';
import { renderTlsScript } from './tls.js';
import type { PreludeInput } from './prelude.js';
import type { TlsSupport } from '../../engines/engine-adapter.js';

/** Inputs for {@link composeInnerScript} and {@link composeUserData}. References and derived settings only. */
export interface ComposeUserDataInput {
  /** Environment name (`environment.name`), used in the header and logging. */
  readonly env: string;
  /** Forum id, the key the broker and secret paths are scoped by. */
  readonly forumId: string;
  /** AWS region; SES and secret lookups on the instance use it. */
  readonly region: string;
  /** Fully qualified host name, `<subdomain>.<rootDomain>`. */
  readonly hostname: string;
  /** ACME account email and operational contact. */
  readonly adminEmail: string;
  /**
   * Bootstrap broker URL. A CDK token string at synth time; embedded verbatim
   * in the header and resolved on the instance. Non-secret.
   */
  readonly brokerUrl: string;
  /**
   * Hosted zone id for Route 53 DNS-01 issuance. A CDK token or literal;
   * present only for DNS-01 forums and embedded verbatim. Non-secret.
   */
  readonly hostedZoneId?: string;
  /** ACME challenge type selected for this forum (`tls/challenge.ts`). */
  readonly challenge: 'dns-01' | 'http-01';
  /** `environment.acmeStaging`: true routes to the Let's Encrypt staging CA. */
  readonly staging: boolean;
  /** TLS capability from the engine adapter (cert paths, reload, webroot). */
  readonly tls: TlsSupport;
  /** The adapter's `renderInstallScript(input)` output, already rendered. */
  readonly adapterScript: string;
  /** Optional pinned-version overrides forwarded to {@link renderPrelude}. */
  readonly prelude?: PreludeInput;
}

/**
 * Compose the full forum install bash script from the header, prelude, TLS
 * section and adapter install script.
 *
 * This is the script whose content the user-data tests assert on (tasks
 * 16.4/16.5/16.6) and that the `render:user-data` shellcheck task (16.7) lints.
 * {@link composeUserData} wraps the output of this function in a
 * self-extracting launcher to fit Lightsail's launch-script size limit; the
 * inner script here is what runs on the instance (written to
 * `/usr/local/sbin/community-hub-install`).
 *
 * @param input - Header values (which may be CDK token strings for `brokerUrl`
 *   and `hostedZoneId`), the selected challenge, staging flag, engine
 *   {@link TlsSupport} and the pre-rendered adapter script. No secret values.
 * @returns The complete, ordered forum install bash script as a plain string.
 */
export function composeInnerScript(input: ComposeUserDataInput): string {
  const { env, forumId, region, hostname, adminEmail, challenge, staging, tls } = input;

  // CH_BROKER_URL and (DNS-01) CH_HOSTED_ZONE_ID are CDK tokens, resolved only at
  // deploy time. They must NOT be baked into this gzip+base64 payload: CDK cannot
  // substitute a token once it is encoded into an opaque blob, so the literal
  // `${Token[...]}` placeholder would be frozen into the script. Instead the
  // plaintext self-extracting wrapper (composeUserData) exports them into the
  // environment before exec, where CDK does resolve them. Here they are consumed
  // from the environment; `set -u` is satisfied because the wrapper always
  // exports both (CH_HOSTED_ZONE_ID as '' for HTTP-01 forums). The references are
  // in the prelude/TLS sections below, so shellcheck sees no unused declaration.
  const header =
    `#!/bin/bash\n` +
    `set -euo pipefail\n` +
    `readonly CH_ENV='${env}' CH_FORUM='${forumId}' CH_REGION='${region}' CH_HOST='${hostname}'\n`;

  const prelude = renderPrelude(input.prelude ?? {});
  const tlsSection = renderTlsScript({ hostname, adminEmail, challenge, staging, tls });

  // Ordering is load-bearing (Req 13.13): prelude (SSM creds for DNS-01) ->
  // TLS section (defines issue_certificate) -> adapter (calls it before serving).
  return [header, prelude, tlsSection, input.adapterScript].join('\n');
}

/**
 * Strip top-level comments and blank lines from the inner install script before
 * it is gzip+base64 encoded into the launch wrapper.
 *
 * The rendered script (what shellcheck lints and the tests assert on) keeps its
 * full comments; only the gzipped PAYLOAD the instance decodes is stripped. This
 * is purely a size reduction: the Lightsail launch user data has a hard 16 KB
 * limit on the encoded wrapper, and the documented install script had grown close
 * enough that a real forum's metadata pushed the encoded payload over the limit.
 * Removing comments cuts the encoded size by roughly 40%, restoring ample
 * headroom without changing a single executed statement.
 *
 * The stripper is HEREDOC-AWARE: it removes a line only when it is at the bash
 * top level (outside any heredoc body) AND its trimmed text starts with `#` but
 * is not the `#!` shebang, or it is blank. Lines inside heredoc bodies (Python,
 * YAML, Ruby, Caddyfile, Dockerfile, systemd units, the prelude library, ...)
 * are preserved verbatim, so `#`-prefixed content in those languages is never
 * corrupted. Heredocs are tracked by their opener `<<DELIM` / `<<'DELIM'` and the
 * matching closing line `^DELIM$`; the generated scripts use only this simple
 * form. A `<<-` opener throws (it cannot be tracked by this scanner) instead of
 * silently corrupting the payload; here-strings (`<<<`) are not heredocs and
 * are ignored.
 *
 * @param script - The composed inner install script.
 * @returns The script with top-level comments and blank lines removed.
 */
export function stripInnerScriptComments(script: string): string {
  const lines = script.split('\n');
  const out: string[] = [];
  let heredocDelimiter: string | undefined;
  // Matches a heredoc opener and captures the delimiter word, with or without
  // surrounding single or double quotes: `<<EOF`, `<<'EOF'`, `<<"EOF"`.
  // `(?<!<)` excludes here-strings (`<<<word`), which are not heredocs. The
  // optional `-` is captured so the `<<-` (tab-stripping) form can be rejected.
  const openerRe = /(?<!<)<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/;

  for (const line of lines) {
    if (heredocDelimiter !== undefined) {
      // Inside a heredoc body: emit verbatim; the body ends at a line that is
      // exactly the delimiter (bash allows no leading whitespace without `<<-`).
      out.push(line);
      if (line === heredocDelimiter) {
        heredocDelimiter = undefined;
      }
      continue;
    }

    const trimmed = line.trim();
    // Top-level comment (not the shebang) or blank line: drop it.
    if (trimmed === '' || (trimmed.startsWith('#') && !trimmed.startsWith('#!'))) {
      continue;
    }

    out.push(line);
    // If this line opens a heredoc, enter heredoc mode until its delimiter.
    const match = openerRe.exec(line);
    if (match) {
      if (match[1] === '-') {
        // `<<-` strips leading tabs from the body AND the closing delimiter, so
        // the plain `line === delimiter` close detection below would never see
        // the end of the heredoc and would pass the rest of the script through
        // as "body". Fail synth rather than silently emit a mangled payload.
        throw new Error(
          'stripInnerScriptComments: the <<- (tab-stripping) heredoc form is not supported; ' +
            `use a plain <<DELIM heredoc (line: ${line.trim().slice(0, 80)})`,
        );
      }
      heredocDelimiter = match[3];
    }
  }

  return out.join('\n');
}

/** Heredoc delimiter the wrapper uses for the encoded payload. Bash does no expansion inside a single-quoted delimiter. */
const PAYLOAD_DELIMITER = 'CH_PAYLOAD';

/** Width the base64 payload is wrapped to for readability. `base64 -d` ignores newlines. */
const BASE64_WRAP_COLUMNS = 76;

/**
 * Compose the Lightsail launch user data: a self-extracting wrapper around the
 * full forum install script from {@link composeInnerScript}.
 *
 * The inner script is ~30-33 KB, which exceeds Lightsail's 16 KB launch-script
 * limit (asserted by task 16.4). To fit, the wrapper gzip+base64 encodes the
 * inner script and, on the instance, decodes it to a `0700` file at
 * `/usr/local/sbin/community-hub-install` and executes it. That file path also
 * satisfies the design's "composed script is written to
 * `/usr/local/sbin/community-hub-install` so an operator can re-run it" note.
 *
 * The payload is embedded inside a single-quoted heredoc so bash performs no
 * expansion on it. Encoding is deterministic: `gzipSync` with a fixed
 * compression level and the default zero mtime yields identical bytes for
 * identical input, so the same `input` always produces the same wrapper string.
 * No secret values are present (the inner script carries Secret_References only).
 *
 * @param input - Same inputs as {@link composeInnerScript}; no secret values.
 * @returns The self-extracting bash wrapper to set as the instance user data.
 */
export function composeUserData(input: ComposeUserDataInput): string {
  // Strip top-level comments/blank lines from the payload only (the rendered
  // script keeps them). This keeps the gzip+base64 launch user data well under
  // the Lightsail 16 KB limit as the install script grows.
  const inner = stripInnerScriptComments(composeInnerScript(input));

  // Guard: the inner script is gzip+base64 encoded below, which freezes its
  // bytes at synth. An unresolved CDK token (`${Token[...]}`) encoded into that
  // opaque blob can never be substituted by CloudFormation, so it would reach
  // the instance literally and break the install. Token-valued inputs (broker
  // URL, hosted zone id) must instead live in the plaintext wrapper. Fail synth
  // loudly if any token leaked into the payload. (Matches CDK's own
  // `Token.isUnresolved` placeholder shape.)
  if (/\$\{Token\[/.test(inner)) {
    throw new Error(
      'composeUserData: the gzipped inner script contains an unresolved CDK token ' +
        '(${Token[...]}). Token-valued values must be placed in the plaintext wrapper, ' +
        'not baked into the gzip+base64 payload.',
    );
  }

  // Deterministic gzip: level 9 with the default mtime of 0 (gzipSync embeds no
  // timestamp). The only non-input byte gzip writes is the fixed OS field, so
  // the same inner script always encodes to the same bytes.
  const gzipped = gzipSync(Buffer.from(inner, 'utf8'), { level: 9 });
  const base64 = gzipped.toString('base64');

  // Wrap to fixed-width lines for readability; base64 -d tolerates the newlines.
  const payload = wrapBase64(base64, BASE64_WRAP_COLUMNS);

  return (
    // Cloud-init concatenates this after Lightsail's own `#!/bin/sh` block and
    // runs the combined user data under /bin/sh (dash on Ubuntu), so the wrapper
    // body must be POSIX sh: no `pipefail` or other bashisms. The decoded inner
    // script is executed with bash explicitly, which honors its `set -euo pipefail`.
    `#!/bin/sh\n` +
    `set -eu\n` +
    `umask 077\n` +
    `# Community Hub self-extracting launch script. The forum install script is\n` +
    `# gzip+base64 encoded below to fit the Lightsail user-data size limit; it is\n` +
    `# decoded to a 0700 file and executed. No secret values are present.\n` +
    `install -d -m 0755 /usr/local/sbin\n` +
    `base64 -d <<'${PAYLOAD_DELIMITER}' | gunzip > /usr/local/sbin/community-hub-install\n` +
    `${payload}\n` +
    `${PAYLOAD_DELIMITER}\n` +
    `chmod 0700 /usr/local/sbin/community-hub-install\n` +
    // CH_BROKER_URL and CH_HOSTED_ZONE_ID are CDK tokens; they live in THIS
    // plaintext wrapper (never in the gzipped payload) so CDK resolves them at
    // deploy time, then they are exported into the inner script's environment.
    // CH_HOSTED_ZONE_ID is always exported (empty for HTTP-01 forums) so the
    // inner script's `set -u` never trips. Single-quoted; broker URLs and zone
    // ids contain no single quotes.
    `export CH_BROKER_URL='${input.brokerUrl}'\n` +
    `export CH_HOSTED_ZONE_ID='${input.hostedZoneId ?? ''}'\n` +
    `exec /bin/bash /usr/local/sbin/community-hub-install\n`
  );
}

/**
 * Split a base64 string into fixed-width lines.
 *
 * @param base64 - The base64 payload.
 * @param columns - Line width; each line holds at most this many characters.
 * @returns The payload with newlines inserted every `columns` characters.
 */
function wrapBase64(base64: string, columns: number): string {
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += columns) {
    lines.push(base64.slice(i, i + columns));
  }
  return lines.join('\n');
}
