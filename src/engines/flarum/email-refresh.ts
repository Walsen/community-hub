/**
 * Pure renderer for the Flarum `refresh-email.sh` body.
 *
 * The install script writes this body to `/opt/community-hub/bin/refresh-email.sh`
 * (`0700`) and installs it as a oneshot systemd unit that runs at boot before
 * the forum containers come up, so a rotated SES credential is picked up when
 * the instance comes back online. The initial install also runs it once (for
 * Flarum applying the settings causes no downtime, so `--no-restart` only skips
 * the trailing cache clear reload step).
 *
 * The body is a pure string: it contains Secret_References (the two SES
 * parameter names) and placeholders only, never secret values. Values are
 * fetched on the instance through the prelude's `fetch_secret` and are passed
 * to the substitution step through files and stdin, never argv.
 *
 * Flow (design "On-instance email configuration", Flarum):
 *  1. `fetch_secret` both `ses-smtp-*` parameters to tmpfs (`0600`).
 *  2. `sha256sum` both files; compare to the saved state hash. Equal → log
 *     `email settings unchanged`, shred, exit 0.
 *  3. A `python3` step reads the credential values from the files by path and
 *     emits an idempotent SQL `INSERT ... ON DUPLICATE KEY UPDATE` upsert into
 *     the Flarum `settings` table for `mail_driver`, `mail_host`, `mail_port`,
 *     `mail_encryption`, `mail_username`, `mail_password` and `mail_from`. The
 *     SQL is piped on stdin to `docker compose exec -T db mysql`; no secret
 *     reaches argv. Write the new hash, shred the temp files.
 *  4. Unless `--no-restart`: `docker compose exec -T app php flarum cache:clear`.
 *
 * The fragment runs under the shared prelude's `set -euo pipefail`, ERR trap
 * and `fail()`; it must stay shellcheck-clean on its own.
 */

import { FLARUM_ROOT } from './paths.js';
import type { InstallScriptInput } from '../engine-adapter.js';

/** tmpfs scratch for fetched credential files. */
const SES_USER_FILE = '/run/community-hub/ses-user';
const SES_PASS_FILE = '/run/community-hub/ses-pass';
/** Persisted hash of the last applied credential pair. */
const EMAIL_HASH_FILE = '/var/lib/community-hub/state/email.sha256';

/**
 * Render the body of the Flarum `refresh-email.sh`.
 *
 * @param input - Install inputs; reads {@link InstallScriptInput.email} (the
 *   SES host, port, sender and parameter names) only. No secret values appear.
 * @returns A pure bash fragment, safe to append after the shared prelude.
 */
export function renderEmailRefreshScript(input: InstallScriptInput): string {
  const { host, port, senderAddress, usernameParameter, passwordParameter } = input.email;
  const compose = `docker compose -f ${FLARUM_ROOT}/docker-compose.yml`;

  return `# ---- Flarum SES credential refresh -------------------------------------
# Upserts the Flarum mail_* settings from the current SES parameters. Secret
# values live only in 0600 tmpfs files and reach mysql through stdin SQL built
# by python3; they never appear in argv or in \$BASH_COMMAND.

no_restart=false
if [ "\${1:-}" = "--no-restart" ]; then
  no_restart=true
fi

mkdir -p /run/community-hub "$(dirname ${EMAIL_HASH_FILE})"

fetch_secret ssm '${usernameParameter}' '${SES_USER_FILE}'
fetch_secret ssm '${passwordParameter}' '${SES_PASS_FILE}'

cleanup_email_temps() {
  shred -u '${SES_USER_FILE}' '${SES_PASS_FILE}' 2>/dev/null || true
}
trap cleanup_email_temps EXIT

new_hash="$(sha256sum '${SES_USER_FILE}' '${SES_PASS_FILE}' | sha256sum | cut -d' ' -f1)"
if [ -f '${EMAIL_HASH_FILE}' ] && [ "$new_hash" = "$(cat '${EMAIL_HASH_FILE}')" ]; then
  echo "email settings unchanged"
  exit 0
fi

# Build the settings upsert. python3 reads the secret values from the files by
# path and SQL-escapes them; the generated statement is piped to mysql on stdin
# via the \`db\` service. Nothing secret appears in argv.
CH_SES_USER_FILE='${SES_USER_FILE}' CH_SES_PASS_FILE='${SES_PASS_FILE}' \\
  CH_MAIL_HOST='${host}' CH_MAIL_PORT='${String(port)}' \\
  CH_MAIL_FROM='${senderAddress}' python3 - <<'PYEOF' | ${compose} exec -T db \\
    sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot "$MYSQL_DATABASE"'
import os

def read(path):
    with open(path, "r", encoding="utf-8") as fh:
        return fh.read().strip()

def q(value):
    # MySQL string literal escaping for a single-quoted context.
    return "'" + value.replace("\\\\", "\\\\\\\\").replace("'", "\\\\'") + "'"

settings = {
    "mail_driver": "smtp",
    "mail_host": os.environ["CH_MAIL_HOST"],
    "mail_port": os.environ["CH_MAIL_PORT"],
    "mail_encryption": "tls",
    "mail_username": read(os.environ["CH_SES_USER_FILE"]),
    "mail_password": read(os.environ["CH_SES_PASS_FILE"]),
    "mail_from": os.environ["CH_MAIL_FROM"],
}

rows = ",".join("(" + q(k) + "," + q(v) + ")" for k, v in settings.items())
print(
    "INSERT INTO settings (\`key\`, \`value\`) VALUES "
    + rows
    + " ON DUPLICATE KEY UPDATE \`value\` = VALUES(\`value\`);"
)
PYEOF

umask 077
printf '%s\\n' "$new_hash" >'${EMAIL_HASH_FILE}'
cleanup_email_temps
trap - EXIT

if [ "$no_restart" = true ]; then
  echo "mail settings upserted; cache clear skipped (--no-restart)"
  exit 0
fi

${compose} exec -T app php flarum cache:clear
`;
}
