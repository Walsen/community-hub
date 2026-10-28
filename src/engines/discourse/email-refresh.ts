/**
 * Pure renderer for the Discourse `refresh-email.sh` body.
 *
 * The install script writes this body to `/opt/community-hub/bin/refresh-email.sh`
 * (`0700`) and installs it as a oneshot systemd unit that runs at boot before
 * the forum containers start, so a rotated SES credential is picked up when the
 * instance comes back online. The initial install also runs it once with
 * `--no-restart`.
 *
 * The body is a pure string: it contains Secret_References (the two SES
 * parameter names) and placeholders only, never secret values. Values are
 * fetched on the instance through the prelude's `fetch_secret` and are passed
 * to the substitution step through files, never argv.
 *
 * Flow (design "On-instance email configuration"):
 *  1. `fetch_secret` both `ses-smtp-*` parameters to tmpfs (`0600`).
 *  2. `sha256sum` both files; compare to the saved state hash. Equal → log
 *     `email settings unchanged`, shred, exit 0.
 *  3. Substitute the `DISCOURSE_SMTP_USER_NAME` / `DISCOURSE_SMTP_PASSWORD`
 *     placeholders in `app.yml` via a `python3` step that JSON-encodes the
 *     values read from the files (valid YAML scalars) without placing them in
 *     argv, write the new hash, shred the temp files.
 *  4. Unless `--no-restart`: `./launcher destroy app && ./launcher start app`.
 *
 * The fragment runs under the shared prelude's `set -euo pipefail`, ERR trap
 * and `fail()`; it must stay shellcheck-clean on its own.
 */

import type { InstallScriptInput } from '../engine-adapter.js';

/** Container launcher checkout path (shared with the install script). */
const DISCOURSE_ROOT = '/var/discourse';
/** Rendered container definition the refresh step rewrites in place. */
const APP_YML = `${DISCOURSE_ROOT}/containers/app.yml`;
/** tmpfs scratch for fetched credential files. */
const SES_USER_FILE = '/run/community-hub/ses-user';
const SES_PASS_FILE = '/run/community-hub/ses-pass';
/** Persisted hash of the last applied credential pair. */
const EMAIL_HASH_FILE = '/var/lib/community-hub/state/email.sha256';

/**
 * Render the body of the Discourse `refresh-email.sh`.
 *
 * @param input - Install inputs; only {@link InstallScriptInput.email} (the SES
 *   parameter names) is read. No secret values are referenced.
 * @returns A pure bash fragment, safe to append after the shared prelude.
 */
export function renderEmailRefreshScript(input: InstallScriptInput): string {
  const { usernameParameter, passwordParameter } = input.email;

  return `# ---- Discourse SES credential refresh ----------------------------------
# Rewrites the DISCOURSE_SMTP_USER_NAME / DISCOURSE_SMTP_PASSWORD placeholders in
# app.yml from the current SES parameters. Secret values live only in 0600 tmpfs
# files and are passed to python3 by path, never on the command line.

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

# Substitute placeholders. python3 reads the secret values from the files by
# path and json-encodes them into valid YAML double-quoted scalars; nothing
# secret appears in argv or in \$BASH_COMMAND.
CH_SES_USER_FILE='${SES_USER_FILE}' CH_SES_PASS_FILE='${SES_PASS_FILE}' \\
  CH_APP_YML='${APP_YML}' python3 - <<'PYEOF'
import json, os, re

app_yml = os.environ["CH_APP_YML"]
with open(os.environ["CH_SES_USER_FILE"], "r", encoding="utf-8") as fh:
    user = fh.read().strip()
with open(os.environ["CH_SES_PASS_FILE"], "r", encoding="utf-8") as fh:
    password = fh.read().strip()

with open(app_yml, "r", encoding="utf-8") as fh:
    text = fh.read()

def set_env(text, key, value):
    encoded = json.dumps(value)  # valid YAML double-quoted scalar
    pattern = re.compile(r'^(\\s*)' + re.escape(key) + r':.*$', re.MULTILINE)
    replacement = r'\\g<1>' + key + ': ' + encoded.replace('\\\\', '\\\\\\\\')
    new_text, count = pattern.subn(lambda m: m.group(1) + key + ': ' + encoded, text, count=1)
    if count != 1:
        raise SystemExit("placeholder " + key + " not found in app.yml")
    return new_text

text = set_env(text, "DISCOURSE_SMTP_USER_NAME", user)
text = set_env(text, "DISCOURSE_SMTP_PASSWORD", password)

fd = os.open(app_yml + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as fh:
    fh.write(text)
os.replace(app_yml + ".tmp", app_yml)
PYEOF

umask 077
printf '%s\\n' "$new_hash" >'${EMAIL_HASH_FILE}'
cleanup_email_temps
trap - EXIT

if [ "$no_restart" = true ]; then
  echo "app.yml rewritten; restart skipped (--no-restart)"
  exit 0
fi

cd ${DISCOURSE_ROOT} || fail "cannot cd to ${DISCOURSE_ROOT}"
./launcher destroy app
./launcher start app
`;
}
