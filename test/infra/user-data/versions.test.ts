import { describe, expect, it } from 'vitest';

import {
  AWS_CLI_VERSION,
  DOCKER_COMPOSE_APT_VERSION,
  DOCKER_ENGINE_APT_VERSION,
  LEGO_SHA256_LINUX_AMD64,
  LEGO_VERSION,
  SSM_AGENT_VERSION,
} from '../../../src/infra/user-data/versions.js';

describe('user-data versions', () => {
  const allVersions = [
    AWS_CLI_VERSION,
    DOCKER_COMPOSE_APT_VERSION,
    DOCKER_ENGINE_APT_VERSION,
    LEGO_VERSION,
    SSM_AGENT_VERSION,
  ];

  it('pins every version (no `latest`)', () => {
    for (const version of allVersions) {
      expect(version.toLowerCase()).not.toContain('latest');
    }
  });

  it('pins lego to a `v...` release tag', () => {
    expect(LEGO_VERSION).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('declares a 64-hex lego checksum', () => {
    expect(LEGO_SHA256_LINUX_AMD64).toMatch(/^[0-9a-f]{64}$/);
  });
});
