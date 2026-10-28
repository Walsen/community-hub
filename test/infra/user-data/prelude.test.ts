import { describe, expect, it } from 'vitest';

import {
  AWS_CLI_VERSION,
  DOCKER_COMPOSE_APT_VERSION,
  DOCKER_ENGINE_APT_VERSION,
  SSM_AGENT_VERSION,
} from '../../../src/infra/user-data/versions.js';
import { PRELUDE_LIB, renderPrelude } from '../../../src/infra/user-data/prelude.js';

describe('renderPrelude', () => {
  const script = renderPrelude();

  it('sets up logging to the install.log', () => {
    expect(script).toContain('/var/log/community-hub/install.log');
    expect(script).toContain("exec >>'/var/log/community-hub/install.log' 2>&1");
  });

  it('defines fail() and an ERR trap', () => {
    expect(script).toContain('fail() {');
    expect(script).toMatch(/trap 'fail "line \$LINENO: \$BASH_COMMAND"' ERR/);
  });

  it('sets up a swap file idempotently', () => {
    expect(script).toContain('/swapfile');
    expect(script).toContain("mkswap '/swapfile'");
    expect(script).toContain("if [ ! -f '/swapfile' ]; then");
  });

  it('pins the Docker, AWS CLI and SSM agent versions (no floating versions)', () => {
    expect(script).toContain(`docker-ce=${DOCKER_ENGINE_APT_VERSION}`);
    expect(script).toContain(`docker-ce-cli=${DOCKER_ENGINE_APT_VERSION}`);
    expect(script).toContain(`docker-compose-plugin=${DOCKER_COMPOSE_APT_VERSION}`);
    expect(script).toContain(AWS_CLI_VERSION);
    expect(script).toContain(SSM_AGENT_VERSION);
  });

  it('honours pinned-version overrides', () => {
    const overridden = renderPrelude({
      dockerEngineAptVersion: '5:99.0.0-1~ubuntu.22.04~jammy',
      dockerComposeAptVersion: '9.9.9-1~ubuntu.22.04~jammy',
      awsCliVersion: '2.99.99',
      ssmAgentVersion: '9.9.9999.0',
    });
    expect(overridden).toContain('docker-ce=5:99.0.0-1~ubuntu.22.04~jammy');
    expect(overridden).toContain('docker-compose-plugin=9.9.9-1~ubuntu.22.04~jammy');
    expect(overridden).toContain('2.99.99');
    expect(overridden).toContain('9.9.9999.0');
  });

  it('defines the shared helper functions', () => {
    expect(script).toContain('claim_and_register() {');
    expect(script).toContain('fetch_secret() {');
    expect(script).toContain('write_secret() {');
    expect(script).toContain('wait_for_dns() {');
  });

  it('resolves its own public IP from instance metadata, not from the broker', () => {
    // The HTTP-01 TLS path calls wait_for_dns, which needs this instance's
    // public IP. The broker intentionally does NOT report a source IP (Lightsail
    // NATs outbound away from the static IP), so the instance must derive its
    // own address from IMDS. Regression for a gap where the public-ip file was
    // only written from a broker `observedIp` field the broker never sends.
    expect(script).toContain('resolve_public_ip() {');
    // IMDSv2 token-first, with the metadata public-ipv4 lookup.
    expect(script).toContain('http://169.254.169.254/latest/api/token');
    expect(script).toContain('http://169.254.169.254/latest/meta-data/public-ipv4');
    // wait_for_dns must call resolve_public_ip before reading the IP file.
    const resolveIdx = script.indexOf('resolve_public_ip() {');
    const waitIdx = script.indexOf('wait_for_dns() {');
    const callIdx = script.indexOf('resolve_public_ip', waitIdx);
    expect(resolveIdx).toBeGreaterThanOrEqual(0);
    expect(waitIdx).toBeGreaterThan(resolveIdx);
    expect(callIdx).toBeGreaterThan(waitIdx);
    // The dead broker-sourced public-IP write is gone.
    expect(script).not.toContain('observedIp');
    expect(script).not.toContain('observed_ip');
  });

  it('claims the activation over IPv4 so the broker source-IP check matches', () => {
    // The broker authorizes a claim by matching the request source IP to the
    // forum's Lightsail static IP, which is IPv4-only. Lightsail instances are
    // dual-stack and curl prefers IPv6 when the Lambda function URL resolves
    // over IPv6, which made the broker see an IPv6 source and reject every
    // claim as a source-IP mismatch. The claim curl must force IPv4.
    expect(script).toMatch(/curl -fsS --ipv4 --connect-timeout 15 -X POST/);
  });

  it('restarts the SSM agent after registration so it adopts the on-prem identity', () => {
    // On a Lightsail instance the agent starts at boot, detects EC2-ish
    // metadata, fails to get EC2 credentials and backs off ~25 minutes. A plain
    // start after our hybrid -register is then a no-op and the agent never
    // switches to the OnPrem identity, so it never writes credentials and the
    // install hangs until the 10-minute credential wait fails. The prelude must
    // RESTART the agent so it re-reads the on-prem registration.
    expect(script).toMatch(/snap restart amazon-ssm-agent/);
    expect(script).toMatch(/systemctl restart snap\.amazon-ssm-agent/);
  });

  it('writes the reusable prelude library to the published path', () => {
    expect(PRELUDE_LIB).toBe('/usr/local/lib/community-hub/prelude.sh');
    expect(script).toContain(`cat >'${PRELUDE_LIB}'`);
    expect(script).toContain(`chmod 0644 '${PRELUDE_LIB}'`);
  });

  it('references the header CH_ variables but does not declare them', () => {
    expect(script).toContain('$CH_ENV');
    expect(script).toContain('$CH_FORUM');
    expect(script).toContain('$CH_REGION');
    expect(script).toContain('$CH_HOST');
    expect(script).toContain('$CH_BROKER_URL');
    // The prelude never declares the header variables (compose.ts does).
    expect(script).not.toMatch(/readonly CH_ENV=/);
    expect(script).not.toMatch(/readonly CH_BROKER_URL=/);
  });

  it('never echoes the activation code', () => {
    // The activation code is a secret: it must never be echoed, printed or
    // placed on argv anywhere a trace/log could capture it.
    expect(script).not.toMatch(/echo\s+"?\$activation_code/);
    expect(script).not.toMatch(/printf[^\n]*\$activation_code/);
    // It lives only in a local variable and is unset after use.
    expect(script).toContain('unset activation_code');
  });

  it('contains no `latest` tag', () => {
    expect(script).not.toMatch(/:latest\b/);
    expect(script).not.toMatch(/=latest\b/);
  });
});
