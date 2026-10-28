/**
 * Pure renderer for the shared user-data prelude.
 *
 * {@link renderPrelude} returns the engine-agnostic bash that runs first in the
 * composed user data (task 16.3), after the `#!/bin/bash`, `set -euo pipefail`
 * and the `readonly CH_*` header that `compose.ts` emits. It is a pure string
 * builder: no CDK tokens, no secret values. The only runtime inputs are the
 * header variables `CH_ENV`, `CH_FORUM`, `CH_REGION`, `CH_HOST`,
 * `CH_BROKER_URL` and (DNS-01 forums only) `CH_HOSTED_ZONE_ID`, which the
 * composed script declares before this prelude; the prelude references them but
 * never declares them.
 *
 * Responsibilities (design "User data"):
 *  - Logging to `/var/log/community-hub/install.log`, `set +x`, an ERR trap and
 *    `fail()` (Req 5.6, 6.7).
 *  - `umask 077` and a 2 GB swap file when absent (idempotent).
 *  - Pinned installs of Docker Engine + Compose plugin, AWS CLI v2, `jq` and
 *    the SSM agent, all idempotent (Req 5.1, 6.1).
 *  - `claim_and_register`: claim a single-use activation from the per-Environment
 *    bootstrap broker and register the instance as an SSM hybrid managed node
 *    (Req 6.1). The activation code is never logged, echoed or placed in
 *    `$BASH_COMMAND`.
 *  - `fetch_secret` / `write_secret`: resolve and persist Secret_References via
 *    files, never argv (Req 2.4, 2.6).
 *  - `wait_for_dns`: poll until `CH_HOST` resolves to this instance's public IP.
 *  - The reusable functions are also written to
 *    `/usr/local/lib/community-hub/prelude.sh` (`0644`) so the boot-time
 *    `refresh-email.sh` units can source them.
 *
 * It deliberately does NOT define `issue_certificate`; that comes from the TLS
 * section (`tls.ts`, task 16.2). Every function is idempotent and guarded by a
 * marker under `/var/lib/community-hub/state/<step>.done` where a step must run
 * at most once.
 *
 * The fragment runs under the composed script's `set -euo pipefail` and stays
 * shellcheck-clean on its own.
 */

import {
  AWS_CLI_VERSION,
  DOCKER_COMPOSE_APT_VERSION,
  DOCKER_ENGINE_APT_VERSION,
  SSM_AGENT_VERSION,
} from './versions.js';

/**
 * Path the reusable prelude functions are written to, so standalone boot-time
 * units (for example each engine's `refresh-email.sh`) can source `fail`,
 * `fetch_secret`, `write_secret` and the logging setup outside the one-shot
 * install run. The engine install scripts source this exact path.
 */
export const PRELUDE_LIB = '/usr/local/lib/community-hub/prelude.sh';

/** On-instance directory for the install log. */
const LOG_DIR = '/var/log/community-hub';
/** The install log every step appends to. */
const LOG_FILE = `${LOG_DIR}/install.log`;
/** Directory holding idempotency step markers. */
const STATE_DIR = '/var/lib/community-hub/state';
/** File the instance's observed public IP is persisted to. */
const PUBLIC_IP_FILE = '/var/lib/community-hub/public-ip';
/** Hybrid-managed-node credentials the SSM agent writes after registration. */
const SSM_CREDENTIALS = '/root/.aws/credentials';
/** 2 GB swap file path. */
const SWAP_FILE = '/swapfile';

/**
 * Inputs for {@link renderPrelude}. All pinned versions default to the shared
 * `versions.ts` values; they are parameters so a test can render with explicit
 * pins and assert no `latest` slips in.
 */
export interface PreludeInput {
  /** Docker Engine apt package version (`docker-ce=<version>`). */
  readonly dockerEngineAptVersion?: string;
  /** Docker Compose plugin apt package version. */
  readonly dockerComposeAptVersion?: string;
  /** AWS CLI v2 installer version. */
  readonly awsCliVersion?: string;
  /** Amazon SSM agent `.deb` version. */
  readonly ssmAgentVersion?: string;
}

/**
 * Render the shared prelude bash fragment.
 *
 * @param input - Optional pinned-version overrides; defaults come from
 *   `versions.ts`. No secret values and no CDK tokens are accepted.
 * @returns A pure, idempotent, shellcheck-clean bash fragment that provides the
 *   shared helpers (`fail`, `fetch_secret`, `write_secret`, `wait_for_dns`,
 *   `claim_and_register`) and prepares the instance.
 */
export function renderPrelude(input: PreludeInput = {}): string {
  const dockerEngineAptVersion = input.dockerEngineAptVersion ?? DOCKER_ENGINE_APT_VERSION;
  const dockerComposeAptVersion = input.dockerComposeAptVersion ?? DOCKER_COMPOSE_APT_VERSION;
  const awsCliVersion = input.awsCliVersion ?? AWS_CLI_VERSION;
  const ssmAgentVersion = input.ssmAgentVersion ?? SSM_AGENT_VERSION;

  return `# ====================================================================
# Shared prelude (engine-agnostic, runs before the TLS and adapter sections)
# ====================================================================
# References header vars declared by the composed script: CH_ENV, CH_FORUM,
# CH_REGION, CH_HOST, CH_BROKER_URL and (DNS-01 forums only) CH_HOSTED_ZONE_ID.

# ---- Logging, failure handling and tracing --------------------------
mkdir -p '${LOG_DIR}' '${STATE_DIR}' "$(dirname '${PUBLIC_IP_FILE}')"
exec >>'${LOG_FILE}' 2>&1
# Never enable xtrace: a traced command touching a secret would leak it.
set +x

# fail <reason>: record a single FAILED line and stop. Called by the ERR trap
# and directly by helpers. The reason is a plain message, never a secret value.
fail() {
  echo "FAILED: \${1:-unknown error}"
  exit 1
}

# Report the failing line and command. Secret-bearing commands below are written
# so \$BASH_COMMAND holds only variable names and file paths, never values.
trap 'fail "line \$LINENO: \$BASH_COMMAND"' ERR

umask 077

# step_done / mark_done: idempotency markers so a step runs at most once.
step_done() { [ -f "${STATE_DIR}/\$1.done" ]; }
mark_done() { touch "${STATE_DIR}/\$1.done"; }

echo "prelude start: env=\$CH_ENV forum=\$CH_FORUM host=\$CH_HOST region=\$CH_REGION"

# ---- Swap (2 GB, idempotent) ----------------------------------------
if [ ! -f '${SWAP_FILE}' ]; then
  fallocate -l 2G '${SWAP_FILE}' || dd if=/dev/zero of='${SWAP_FILE}' bs=1M count=2048
  chmod 0600 '${SWAP_FILE}'
  mkswap '${SWAP_FILE}'
fi
if ! swapon --show=NAME --noheadings | grep -qx '${SWAP_FILE}'; then
  swapon '${SWAP_FILE}'
fi
if ! grep -q '^${SWAP_FILE} ' /etc/fstab; then
  printf '%s\\n' '${SWAP_FILE} none swap sw 0 0' >>/etc/fstab
fi

# ---- Pinned package installs (idempotent) ---------------------------
export DEBIAN_FRONTEND=noninteractive

install_docker() {
  if step_done docker; then return 0; fi
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL --retry 5 --connect-timeout 15 https://download.docker.com/linux/ubuntu/gpg \\
      -o /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
  fi
  local arch codename
  arch="$(dpkg --print-architecture)"
  # shellcheck source=/dev/null  # os-release is a runtime file, not in the repo
  codename="$(. /etc/os-release && echo "\$VERSION_CODENAME")"
  printf '%s\\n' \\
    "deb [arch=\$arch signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \$codename stable" \\
    >/etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y --no-install-recommends \\
    "docker-ce=${dockerEngineAptVersion}" \\
    "docker-ce-cli=${dockerEngineAptVersion}" \\
    containerd.io \\
    "docker-compose-plugin=${dockerComposeAptVersion}"
  systemctl enable --now docker
  mark_done docker
}

install_jq() {
  if command -v jq >/dev/null 2>&1; then return 0; fi
  apt-get update
  apt-get install -y --no-install-recommends jq
}

install_aws_cli() {
  if command -v aws >/dev/null 2>&1; then return 0; fi
  local arch url tmp
  case "$(uname -m)" in
    x86_64) arch=x86_64 ;;
    aarch64) arch=aarch64 ;;
    *) fail "unsupported architecture for AWS CLI: $(uname -m)" ;;
  esac
  url="https://awscli.amazonaws.com/awscli-exe-linux-\${arch}-${awsCliVersion}.zip"
  tmp="$(mktemp -d)"
  apt-get install -y --no-install-recommends unzip >/dev/null 2>&1 || true
  curl -fsSL --retry 5 --connect-timeout 15 "\$url" -o "\$tmp/awscliv2.zip"
  unzip -q "\$tmp/awscliv2.zip" -d "\$tmp"
  "\$tmp/aws/install" --update
  rm -rf "\$tmp"
}

install_ssm_agent() {
  if command -v amazon-ssm-agent >/dev/null 2>&1; then return 0; fi
  if command -v snap >/dev/null 2>&1 && snap list amazon-ssm-agent >/dev/null 2>&1; then
    return 0
  fi
  if command -v snap >/dev/null 2>&1; then
    if snap install amazon-ssm-agent --classic; then
      return 0
    fi
  fi
  local arch deb tmp
  case "$(dpkg --print-architecture)" in
    amd64) arch=amd64 ;;
    arm64) arch=arm64 ;;
    *) fail "unsupported architecture for SSM agent: $(dpkg --print-architecture)" ;;
  esac
  tmp="$(mktemp -d)"
  deb="\$tmp/amazon-ssm-agent.deb"
  curl -fsSL --retry 5 --connect-timeout 15 \\
    "https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/${ssmAgentVersion}/debian_\${arch}/amazon-ssm-agent.deb" \\
    -o "\$deb"
  dpkg -i "\$deb" || apt-get install -y -f
  rm -rf "\$tmp"
}

install_docker
install_jq
install_aws_cli
install_ssm_agent

# Resolve how to invoke the SSM agent binary. The Lightsail Ubuntu image ships
# the agent as a snap whose binary is NOT on PATH as amazon-ssm-agent; a .deb
# install (our fallback) does put it on PATH. Echo the right invocation so both
# -register and the service start use it.
ssm_agent_cmd() {
  if command -v amazon-ssm-agent >/dev/null 2>&1; then
    echo amazon-ssm-agent
  elif [ -x /snap/amazon-ssm-agent/current/amazon-ssm-agent ]; then
    echo /snap/amazon-ssm-agent/current/amazon-ssm-agent
  elif command -v snap >/dev/null 2>&1 && snap list amazon-ssm-agent >/dev/null 2>&1; then
    echo 'snap run amazon-ssm-agent'
  else
    fail 'amazon-ssm-agent not found after install (neither PATH, snap, nor .deb)'
  fi
}

# ---- claim_and_register ---------------------------------------------
# Claim a single-use, 1-hour activation from the per-Environment bootstrap
# broker (which only answers this forum's static IP) and register as an SSM
# hybrid managed node. The activation code is a secret: it is held only in a
# local variable, never echoed, logged or placed in \$BASH_COMMAND, and is unset
# immediately after use.
claim_and_register() {
  if step_done register; then return 0; fi
  if [ -f '${SSM_CREDENTIALS}' ]; then
    mark_done register
    return 0
  fi

  local body='' deadline
  deadline=\$(( \$(date +%s) + 1800 ))   # up to 30 minutes
  while :; do
    # Force IPv4: the broker authorizes by matching the request source IP to the
    # forum's Lightsail static IP, which is IPv4-only. Lightsail instances have
    # IPv6 and curl prefers it when the Lambda function URL resolves dual-stack,
    # so without --ipv4 the broker sees the instance's IPv6 address and rejects
    # the claim as a source-IP mismatch (a real 30-minute deploy failure).
    body="$(curl -fsS --ipv4 --connect-timeout 15 -X POST \\
      -H 'Content-Type: application/json' \\
      --data "{\\"environment\\":\\"\$CH_ENV\\",\\"forumId\\":\\"\$CH_FORUM\\"}" \\
      "\$CH_BROKER_URL" 2>/dev/null || true)"
    if [ -n "\$body" ] && printf '%s' "\$body" | jq -e '.activationId and .activationCode' >/dev/null 2>&1; then
      break
    fi
    if [ "\$(date +%s)" -ge "\$deadline" ]; then
      fail "bootstrap broker did not return an activation within 30 minutes"
    fi
    sleep 15
  done

  # Parse into locals. activation_code holds a secret; keep it off argv and logs.
  local activation_id activation_code region
  activation_id="$(printf '%s' "\$body" | jq -r '.activationId')"
  activation_code="$(printf '%s' "\$body" | jq -r '.activationCode')"
  region="$(printf '%s' "\$body" | jq -r '.region // empty')"
  body=''
  if [ -z "\$region" ]; then region="\$CH_REGION"; fi

  # Register. The code is passed on argv to amazon-ssm-agent only; this single
  # command is the one place the value appears, and the ERR trap is temporarily
  # neutralised so a failure reason never includes \$BASH_COMMAND with the code.
  trap - ERR
  local ssm_cmd
  ssm_cmd="\$(ssm_agent_cmd)"
  # shellcheck disable=SC2086  # ssm_cmd may be 'snap run amazon-ssm-agent' (two words)
  \$ssm_cmd -register -y \\
    -code "\$activation_code" -id "\$activation_id" -region "\$region" \\
    >/dev/null 2>>'${LOG_FILE}'
  local rc=\$?
  trap 'fail "line \$LINENO: \$BASH_COMMAND"' ERR
  activation_code=''
  unset activation_code
  if [ "\$rc" -ne 0 ]; then
    fail "SSM managed-node registration failed (code redacted)"
  fi

  # Restart (not just start) the agent so it re-reads the on-prem registration we
  # just wrote. On a Lightsail instance the agent starts at boot, detects EC2-ish
  # metadata, fails to get EC2/default-host-management credentials
  # (AccessDenied), and backs off for ~25 minutes. A plain start is then a no-op
  # and it never switches to the hybrid (OnPrem) identity, so it never writes
  # credentials and this install hangs. A restart forces it onto the OnPrem
  # identity from the registration file. Cover snap and .deb service unit names.
  systemctl restart snap.amazon-ssm-agent.amazon-ssm-agent.service 2>/dev/null \\
    || snap restart amazon-ssm-agent 2>/dev/null \\
    || systemctl restart amazon-ssm-agent 2>/dev/null \\
    || true

  # Wait for the agent to write hybrid credentials.
  local waited=0
  until [ -f '${SSM_CREDENTIALS}' ]; do
    sleep 5
    waited=\$(( waited + 5 ))
    if [ "\$waited" -ge 600 ]; then
      fail "SSM credentials did not appear at ${SSM_CREDENTIALS} within 10 minutes"
    fi
  done

  mark_done register
}

# ---- fetch_secret <store> <id> <dest> -------------------------------
# Resolve a Secret_Reference and write its value to <dest> (0600). The value is
# redirected straight to the file; it never reaches a variable, argv or the log.
# On any failure the reference name is reported, never the value (Req 2.4).
fetch_secret() {
  local store="\$1" id="\$2" dest="\$3"
  umask 077
  : >"\$dest"
  chmod 0600 "\$dest"
  case "\$store" in
    ssm)
      if ! aws ssm get-parameter \\
        --name "\$id" --with-decryption \\
        --query 'Parameter.Value' --output text \\
        --region "\$CH_REGION" >"\$dest" 2>/dev/null; then
        fail "unable to resolve secret reference \$store:\$id"
      fi
      ;;
    secretsmanager)
      if ! aws secretsmanager get-secret-value \\
        --secret-id "\$id" \\
        --query 'SecretString' --output text \\
        --region "\$CH_REGION" >"\$dest" 2>/dev/null; then
        fail "unable to resolve secret reference \$store:\$id"
      fi
      ;;
    *)
      fail "unknown secret store \$store for reference \$store:\$id"
      ;;
  esac
  if [ ! -s "\$dest" ]; then
    fail "unable to resolve secret reference \$store:\$id"
  fi
}

# ---- write_secret <store> <id> <file> -------------------------------
# Persist the contents of <file> as a secret. The value is passed via file://
# only, never on argv. For Secrets Manager the secret must already exist (the
# operator creates it with a placeholder); creation would need broader IAM.
write_secret() {
  local store="\$1" id="\$2" file="\$3"
  case "\$store" in
    ssm)
      if ! aws ssm put-parameter \\
        --name "\$id" --type SecureString --overwrite \\
        --value "file://\$file" \\
        --region "\$CH_REGION" >/dev/null 2>&1; then
        fail "unable to write secret reference \$store:\$id"
      fi
      ;;
    secretsmanager)
      if ! aws secretsmanager put-secret-value \\
        --secret-id "\$id" \\
        --secret-string "file://\$file" \\
        --region "\$CH_REGION" >/dev/null 2>&1; then
        fail "unable to write secret reference \$store:\$id"
      fi
      ;;
    *)
      fail "unknown secret store \$store for reference \$store:\$id"
      ;;
  esac
}

# ---- wait_for_dns ---------------------------------------------------
# Resolve THIS instance's public IPv4 and cache it in the public-ip file. The
# instance derives its own address from the instance metadata service (IMDSv2,
# token-first with a v1 fallback) rather than depending on any external input:
# the bootstrap broker intentionally does not report a source IP (Lightsail NATs
# outbound traffic away from the attached static IP), so there is nothing else
# to learn it from. Idempotent: writes the file once, reuses it thereafter.
resolve_public_ip() {
  if [ -s '${PUBLIC_IP_FILE}' ]; then
    return 0
  fi
  local ip token
  token="$(curl -fsS --max-time 5 -X PUT 'http://169.254.169.254/latest/api/token' \\
    -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' 2>/dev/null || true)"
  if [ -n "\$token" ]; then
    ip="$(curl -fsS --max-time 5 -H "X-aws-ec2-metadata-token: \$token" \\
      'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null || true)"
  fi
  if [ -z "\${ip:-}" ]; then
    ip="$(curl -fsS --max-time 5 'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null || true)"
  fi
  if [ -z "\${ip:-}" ]; then
    fail "could not determine this instance's public IP from instance metadata"
  fi
  printf '%s\\n' "\$ip" >'${PUBLIC_IP_FILE}'
}

# Poll until CH_HOST resolves to this instance's public IP. 120 min limit, then
# fail. Only the HTTP-01 path calls this; DNS-01 issuance does not wait for the
# A record.
wait_for_dns() {
  local expected_ip deadline resolved
  resolve_public_ip
  expected_ip="$(cat '${PUBLIC_IP_FILE}')"
  deadline=\$(( \$(date +%s) + 7200 ))   # 120 minutes
  while :; do
    resolved="$(getent ahostsv4 "\$CH_HOST" | awk '{ print \$1 }' | sort -u || true)"
    if printf '%s\\n' "\$resolved" | grep -qx "\$expected_ip"; then
      return 0
    fi
    if [ "\$(date +%s)" -ge "\$deadline" ]; then
      fail "DNS for \$CH_HOST does not resolve to \$expected_ip"
    fi
    sleep 30
  done
}

# ---- Publish reusable helpers for boot-time units -------------------
# refresh-email.sh units source these outside the one-shot install run, so they
# get logging, fail(), the ERR trap and the secret helpers from one place.
install -d -m 0755 "$(dirname '${PRELUDE_LIB}')"
umask 022
cat >'${PRELUDE_LIB}' <<'PRELUDELIB'
#!/bin/bash
# Community Hub shared prelude helpers. Sourced by boot-time units such as
# refresh-email.sh. Logging and failure handling mirror the install run.
set -euo pipefail

mkdir -p '${LOG_DIR}'
exec >>'${LOG_FILE}' 2>&1
set +x

fail() {
  echo "FAILED: \${1:-unknown error}"
  exit 1
}
trap 'fail "line \$LINENO: \$BASH_COMMAND"' ERR

: "\${CH_REGION:?CH_REGION must be set by the sourcing unit}"

fetch_secret() {
  local store="\$1" id="\$2" dest="\$3"
  umask 077
  : >"\$dest"
  chmod 0600 "\$dest"
  case "\$store" in
    ssm)
      if ! aws ssm get-parameter \\
        --name "\$id" --with-decryption \\
        --query 'Parameter.Value' --output text \\
        --region "\$CH_REGION" >"\$dest" 2>/dev/null; then
        fail "unable to resolve secret reference \$store:\$id"
      fi
      ;;
    secretsmanager)
      if ! aws secretsmanager get-secret-value \\
        --secret-id "\$id" \\
        --query 'SecretString' --output text \\
        --region "\$CH_REGION" >"\$dest" 2>/dev/null; then
        fail "unable to resolve secret reference \$store:\$id"
      fi
      ;;
    *)
      fail "unknown secret store \$store for reference \$store:\$id"
      ;;
  esac
  if [ ! -s "\$dest" ]; then
    fail "unable to resolve secret reference \$store:\$id"
  fi
}

write_secret() {
  local store="\$1" id="\$2" file="\$3"
  case "\$store" in
    ssm)
      if ! aws ssm put-parameter \\
        --name "\$id" --type SecureString --overwrite \\
        --value "file://\$file" \\
        --region "\$CH_REGION" >/dev/null 2>&1; then
        fail "unable to write secret reference \$store:\$id"
      fi
      ;;
    secretsmanager)
      if ! aws secretsmanager put-secret-value \\
        --secret-id "\$id" \\
        --secret-string "file://\$file" \\
        --region "\$CH_REGION" >/dev/null 2>&1; then
        fail "unable to write secret reference \$store:\$id"
      fi
      ;;
    *)
      fail "unknown secret store \$store for reference \$store:\$id"
      ;;
  esac
}
PRELUDELIB
chmod 0644 '${PRELUDE_LIB}'
umask 077

# ---- Self-copy so an operator can re-run after a fix ----------------
# The composed script writes itself here in compose.ts; keep the directory.
install -d -m 0755 /usr/local/sbin

# Run bootstrapping steps.
claim_and_register
`;
}
