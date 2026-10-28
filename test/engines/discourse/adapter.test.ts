import { describe, expect, it } from 'vitest';

import { discourseAdapter } from '../../../src/engines/discourse/adapter.js';
import {
  DISCOURSE_CERT_PATHS,
  DISCOURSE_HTTP01_WEBROOT,
  DISCOURSE_RELOAD_COMMAND,
} from '../../../src/engines/discourse/install-script.js';
import { discourseOptionsSchema } from '../../../src/engines/discourse/options.js';
import {
  DISCOURSE_DEFAULT_ADMIN_USERNAME,
  DISCOURSE_DOCKER_COMMIT,
  DISCOURSE_VERSION_TAG,
} from '../../../src/engines/discourse/versions.js';
import { EngineRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import type { EnvironmentModel, ForumModel } from '../../../src/metadata/schema.js';
import type { InstallScriptInput } from '../../../src/engines/engine-adapter.js';
import { sesSettings } from '../../../src/metadata/mail.js';

/**
 * Unit tests for the Discourse {@link EngineAdapter} (task 10.4).
 *
 * The adapter is driven end-to-end through the loader where practical: a small
 * metadata document is loaded with an {@link EngineRegistry} holding the real
 * {@link discourseAdapter}, so the strict options schema, required secrets and
 * cross-field `validate` all run against realistic `ForumModel` values. The
 * pure `validate` cases are also exercised by calling `adapter.validate(forum,
 * env)` directly on the loaded model. No network, no AWS; placeholder secrets.
 */

const registry = new EngineRegistry([discourseAdapter]);

/** Build a metadata YAML doc from an optional forum `config` block. */
function metadataYaml(configBlock = ''): string {
  return `version: 1
environment:
  name: community-test
  region: us-east-1
  availabilityZone: us-east-1a
  dnsMode: route53
  rootDomain: example.org
  adminEmail: ops@example.org
  sshAllowedCidrs:
    - 203.0.113.0/24
forums:
  - id: main
    engine: discourse
    subdomain: forum
    bundleId: medium_3_0
    senderAddress: noreply
    secrets:
      adminPassword: ssm:/community-hub/community-test/main/admin-password
      apiKey: ssm:/community-hub/community-test/main/api-key
${configBlock ? indent(configBlock, 4) : ''}`;
}

/** Indent a block by `spaces` columns (every non-empty line). */
function indent(block: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Load the single forum and environment from a config block. */
function loadForum(configBlock = ''): { forum: ForumModel; env: EnvironmentModel } {
  const model = loadMetadata(metadataYaml(configBlock), registry);
  const forum = model.forums[0];
  if (forum === undefined) {
    throw new Error('expected one forum');
  }
  return { forum, env: model.environment };
}

/** A declared config group (name + members). */
interface ConfigGroup {
  readonly name: string;
  readonly members: readonly string[];
}

/** A declared config user. */
interface ConfigUser {
  readonly username: string;
  readonly email: string;
  readonly trustLevel: number;
}

/**
 * Build a minimal {@link ForumModel} / {@link EnvironmentModel} pair directly
 * for the pure `validate` unit tests. Going through the loader is not an option
 * for the invalid cases, because the loader runs `adapter.validate` itself and
 * would throw before the test could inspect the issues. The adapter's
 * `validate` reads only `forum.config.{groups,users,settings}`, so only those
 * need to be realistic.
 */
function buildForum(config: {
  groups?: readonly ConfigGroup[];
  users?: readonly ConfigUser[];
  settings?: Readonly<Record<string, unknown>>;
}): { forum: ForumModel; env: EnvironmentModel } {
  const forum = {
    id: 'main',
    engine: 'discourse',
    subdomain: 'forum',
    bundleId: 'medium_3_0',
    senderAddress: 'noreply@example.org',
    credentialRotation: 0,
    secrets: {},
    engineOptions: {},
    config: {
      settings: config.settings ?? {},
      groups: config.groups ?? [],
      categories: [],
      users: config.users ?? [],
    },
  } as unknown as ForumModel;
  const env = {
    name: 'community-test',
    region: 'us-east-1',
    availabilityZone: 'us-east-1a',
    dnsMode: 'route53',
    rootDomain: 'example.org',
    adminEmail: 'ops@example.org',
    sshAllowedCidrs: ['203.0.113.0/24'],
    snapshotTimeUtc: '06:00',
    dmarcPolicy: 'none',
    acmeStaging: false,
    mailDomain: 'example.org',
  } as unknown as EnvironmentModel;
  return { forum, env };
}

describe('discourseAdapter static shape', () => {
  it('declares id, minimum RAM, blueprint and required secrets', () => {
    expect(discourseAdapter.id).toBe('discourse');
    expect(discourseAdapter.minRamMb).toBe(2048);
    expect(discourseAdapter.blueprintId).toBe('ubuntu_22_04');
    expect([...discourseAdapter.requiredSecrets].sort()).toEqual(['adminPassword', 'apiKey']);
  });

  it('supports all seven resource types including colorScheme and trustLevel', () => {
    const types = discourseAdapter.seed.supportedTypes;
    for (const type of [
      'setting',
      'colorScheme',
      'group',
      'category',
      'user',
      'membership',
      'trustLevel',
    ] as const) {
      expect(types.has(type)).toBe(true);
    }
    expect(types.size).toBe(7);
  });

  it('exposes TLS capability matching the install-script constants', () => {
    expect(discourseAdapter.tls.dns01).toBe(true);
    expect(discourseAdapter.tls.certPaths).toEqual(DISCOURSE_CERT_PATHS);
    expect(discourseAdapter.tls.reloadCommand).toBe(DISCOURSE_RELOAD_COMMAND);
    expect(discourseAdapter.tls.http01Webroot).toBe(DISCOURSE_HTTP01_WEBROOT);
  });
});

describe('discourseOptionsSchema', () => {
  it('accepts {} and applies the pinned defaults', () => {
    const parsed = discourseOptionsSchema.parse({});
    expect(parsed).toEqual({
      adminUsername: DISCOURSE_DEFAULT_ADMIN_USERNAME,
      version: DISCOURSE_VERSION_TAG,
    });
  });

  it('accepts explicit overrides', () => {
    const parsed = discourseOptionsSchema.parse({ adminUsername: 'root', version: 'v3.4.0' });
    expect(parsed).toEqual({ adminUsername: 'root', version: 'v3.4.0' });
  });

  it('rejects unknown keys', () => {
    expect(discourseOptionsSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it('rejects an empty admin username', () => {
    expect(discourseOptionsSchema.safeParse({ adminUsername: '' }).success).toBe(false);
  });
});

describe('discourseAdapter.validate', () => {
  it('returns no issues for a clean forum', () => {
    const { forum, env } = buildForum({
      groups: [{ name: 'moderators', members: [] }],
      settings: { title: 'Example Community' },
    });
    expect(discourseAdapter.validate(forum, env)).toEqual([]);
  });

  it('allows a group named moderators', () => {
    const { forum, env } = buildForum({ groups: [{ name: 'moderators', members: [] }] });
    expect(discourseAdapter.validate(forum, env)).toEqual([]);
  });

  it.each([
    'admins',
    'staff',
    'everyone',
    'trust_level_0',
    'trust_level_1',
    'trust_level_2',
    'trust_level_3',
    'trust_level_4',
  ])('rejects a config group named %s', (reserved) => {
    const { forum, env } = buildForum({ groups: [{ name: reserved, members: [] }] });
    const issues = discourseAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.groups[0].name');
  });

  it('rejects a reserved group name case-insensitively', () => {
    const { forum, env } = buildForum({ groups: [{ name: 'Admins', members: [] }] });
    const issues = discourseAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.groups[0].name');
  });

  it('points at the offending group index when earlier groups are valid', () => {
    const { forum, env } = buildForum({
      groups: [
        { name: 'moderators', members: [] },
        { name: 'staff', members: [] },
      ],
    });
    const issues = discourseAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.groups[1].name');
  });

  it('rejects seeding the notification_email setting', () => {
    const { forum, env } = buildForum({ settings: { notification_email: 'someone@example.org' } });
    const issues = discourseAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.settings.notification_email');
  });
});

describe('discourseAdapter validate through the loader', () => {
  it('surfaces a reserved group name as a prefixed loader issue', () => {
    expect(() =>
      loadMetadata(
        metadataYaml(`config:
  groups:
    - name: admins
      members: []`),
        registry,
      ),
    ).toThrow(/forums\[0\]\.config\.groups\[0\]\.name/);
  });

  it('surfaces a forbidden notification_email setting as a prefixed loader issue', () => {
    expect(() =>
      loadMetadata(
        metadataYaml(`config:
  settings:
    notification_email: someone@example.org`),
        registry,
      ),
    ).toThrow(/forums\[0\]\.config\.settings\.notification_email/);
  });

  it('rejects unknown engineOptions keys at the loader boundary', () => {
    expect(() =>
      loadMetadata(
        metadataYaml(`engineOptions:
  unknownKey: true`),
        registry,
      ),
    ).toThrow(/forums\[0\]\.engineOptions/);
  });
});

describe('discourseAdapter.renderInstallScript', () => {
  function installInput(): InstallScriptInput {
    const { forum, env } = loadForum();
    const adminPassword = forum.secrets['adminPassword'];
    const apiKey = forum.secrets['apiKey'];
    if (adminPassword === undefined || apiKey === undefined) {
      throw new Error('expected adminPassword and apiKey references');
    }
    return {
      environmentName: env.name,
      region: env.region,
      forumId: forum.id,
      hostname: `${forum.subdomain}.${env.rootDomain}`,
      adminEmail: env.adminEmail,
      email: sesSettings(env, forum),
      secrets: { adminPassword, apiKey },
      engineOptions: discourseOptionsSchema.parse(forum.engineOptions),
    };
  }

  it('contains the hostname, admin email and pinned versions', () => {
    const script = discourseAdapter.renderInstallScript(installInput());
    expect(script).toContain('DISCOURSE_HOSTNAME: forum.example.org');
    expect(script).toContain('DISCOURSE_DEVELOPER_EMAILS: "ops@example.org"');
    expect(script).toContain(DISCOURSE_DOCKER_COMMIT);
    expect(script).toContain(`version: ${DISCOURSE_VERSION_TAG}`);
  });

  it('references the SES parameter names but no secret values', () => {
    const script = discourseAdapter.renderInstallScript(installInput());
    expect(script).toContain('/community-hub/community-test/main/admin-password');
    expect(script).toContain('/community-hub/community-test/main/api-key');
    expect(script).toContain('write_secret');
    // Placeholders stand in for the SMTP credentials; no resolved value.
    expect(script).toContain('CH_SMTP_USER_PLACEHOLDER');
    expect(script).toContain('CH_SMTP_PASSWORD_PLACEHOLDER');
  });

  it('issues the certificate before rebuilding the app container', () => {
    const script = discourseAdapter.renderInstallScript(installInput());
    const issueIdx = script.indexOf('issue_certificate');
    const rebuildIdx = script.indexOf('./launcher rebuild app');
    expect(issueIdx).toBeGreaterThanOrEqual(0);
    expect(rebuildIdx).toBeGreaterThan(issueIdx);
  });

  it('wires the port-80 acme-challenge replace hook', () => {
    const script = discourseAdapter.renderInstallScript(installInput());
    expect(script).toContain('replace:');
    expect(script).toContain('/.well-known/acme-challenge/');
  });

  it('chowns the bootstrap files to uid 1000 so the in-container discourse user can read them', () => {
    // rails runner runs as the container 'discourse' user (uid 1000). The
    // bootstrap.rb, admin-password and out/ are written by root at 0600 and were
    // unreadable by that user, so bootstrap failed with a LoadError on its own
    // script. The install must chown them to 1000:1000 before the docker exec.
    const script = discourseAdapter.renderInstallScript(installInput());
    const chownIdx = script.indexOf('chown 1000:1000');
    const execIdx = script.indexOf('rails runner /shared/community-hub/bootstrap.rb');
    expect(chownIdx).toBeGreaterThanOrEqual(0);
    expect(chownIdx).toBeLessThan(execIdx);
    expect(script).toContain('"$CH_SHARED_CH_DIR/bootstrap.rb"');
    expect(script).toContain('"$CH_SHARED_CH_DIR/out"');
  });

  it('creates the shared volume traversable (0755) so container db/redis users can reach it', () => {
    // The prelude/TLS sections run under umask 077; without resetting it the
    // Discourse shared volume (/var/discourse/shared/standalone) is created 0700
    // root and the container's unprivileged postgres/redis users cannot traverse
    // into their data dirs, failing the rebuild (Redis 'dir /shared/redis_data'
    // Permission denied; psql socket denied). The install must set umask 022
    // before the clone/mkdir and chmod the parents 0755 (idempotent across boots).
    const script = discourseAdapter.renderInstallScript(installInput());
    const umaskIdx = script.indexOf('umask 022');
    const cloneIdx = script.indexOf('git clone');
    expect(umaskIdx).toBeGreaterThanOrEqual(0);
    expect(umaskIdx).toBeLessThan(cloneIdx);
    expect(script).toMatch(
      /chmod 0755 "\$CH_DISCOURSE_ROOT" "\$CH_DISCOURSE_ROOT\/shared" "\$CH_DISCOURSE_ROOT\/shared\/standalone"/,
    );
  });

  it('declares the CH_ header in the generated standalone refresh-email.sh', () => {
    // refresh-email.sh sources the shared prelude, which aborts unless CH_REGION
    // is set. The script is run both as a child of the install run and by a
    // systemd oneshot unit, neither of which exports CH_REGION, so the generated
    // file must declare the non-secret CH_ header itself (a real deploy failed at
    // `refresh-email.sh --no-restart` with "CH_REGION must be set").
    const script = discourseAdapter.renderInstallScript(installInput());
    // Within the refresh-email.sh heredoc, the CH_ header must be declared before
    // the prelude is sourced. Match the header line then the prelude source line.
    const refreshBlock = /refresh-email\.sh <<'REFRESHEOF'[\s\S]*?REFRESHEOF/.exec(script)?.[0];
    expect(refreshBlock).toBeDefined();
    expect(refreshBlock).toMatch(/readonly CH_ENV=.*CH_REGION='us-east-1'/);
    const headerIdx = refreshBlock!.indexOf('readonly CH_ENV=');
    const sourceIdx = refreshBlock!.indexOf('prelude.sh');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(headerIdx).toBeLessThan(sourceIdx);
  });

  it('renders an email-refresh script that short-circuits and honours --no-restart', () => {
    const script = discourseAdapter.renderEmailRefreshScript(installInput());
    expect(script).toContain('--no-restart');
    expect(script).toContain('email settings unchanged');
  });
});
