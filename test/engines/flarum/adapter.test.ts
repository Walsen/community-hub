import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

import { flarumAdapter } from '../../../src/engines/flarum/adapter.js';
import { flarumOptionsSchema } from '../../../src/engines/flarum/options.js';
import {
  FLARUM_CERT_PATHS,
  FLARUM_HTTP01_WEBROOT,
  FLARUM_RELOAD_COMMAND,
  FLARUM_ROOT,
} from '../../../src/engines/flarum/paths.js';
import {
  CADDY_IMAGE_TAG,
  COMPOSER_IMAGE_TAG,
  FLARUM_DEFAULT_ADMIN_USERNAME,
  FLARUM_VERSION,
  MYSQL_IMAGE_TAG,
  PHP_IMAGE_TAG,
} from '../../../src/engines/flarum/versions.js';
import { EngineRegistry } from '../../../src/engines/registry.js';
import { loadMetadata } from '../../../src/metadata/loader.js';
import { sesSettings } from '../../../src/metadata/mail.js';
import type { InstallScriptInput } from '../../../src/engines/engine-adapter.js';
import type { EnvironmentModel, ForumModel } from '../../../src/metadata/schema.js';

/**
 * Unit tests for the Flarum {@link EngineAdapter} (task 11.4).
 *
 * Mirrors the Discourse adapter tests: the adapter is driven through the loader
 * where practical (a small metadata document loaded with an
 * {@link EngineRegistry} holding the real {@link flarumAdapter}) so the strict
 * options schema, required secrets and cross-field `validate` run against
 * realistic `ForumModel` values. The pure `validate` cases are exercised by
 * calling `adapter.validate(forum, env)` directly on minimal models, because
 * the loader runs `validate` itself and would throw before the test could
 * inspect the issues. No network, no AWS; placeholder secrets only.
 */

const registry = new EngineRegistry([flarumAdapter]);

/** Indent a block by `spaces` columns (every non-empty line). */
function indent(block: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return block
    .split('\n')
    .map((line) => (line.length > 0 ? pad + line : line))
    .join('\n');
}

/** Build a metadata YAML doc from an optional forum extra block. */
function metadataYaml(extraBlock = ''): string {
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
  - id: dev
    engine: flarum
    subdomain: dev
    bundleId: small_3_0
    senderAddress: dev-forum@example.org
    secrets:
      adminPassword: ssm:/community-hub/community-test/dev/admin-password
      apiKey: ssm:/community-hub/community-test/dev/api-key
      databasePassword: ssm:/community-hub/community-test/dev/database-password
${extraBlock ? indent(extraBlock, 4) : ''}`;
}

/** Load the single forum and environment from an extra block. */
function loadForum(extraBlock = ''): { forum: ForumModel; env: EnvironmentModel } {
  const model = loadMetadata(metadataYaml(extraBlock), registry);
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
 * for the pure `validate` unit tests. The adapter's `validate` reads only
 * `forum.config.{groups,users,settings}` and `forum.engineOptions`, so only
 * those need to be realistic.
 */
function buildForum(config: {
  groups?: readonly ConfigGroup[];
  users?: readonly ConfigUser[];
  settings?: Readonly<Record<string, unknown>>;
  engineOptions?: unknown;
}): { forum: ForumModel; env: EnvironmentModel } {
  const forum = {
    id: 'dev',
    engine: 'flarum',
    subdomain: 'dev',
    bundleId: 'small_3_0',
    senderAddress: 'dev-forum@example.org',
    credentialRotation: 0,
    secrets: {},
    engineOptions: config.engineOptions ?? {},
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

describe('flarumAdapter static shape', () => {
  it('declares id, minimum RAM, blueprint and required secrets', () => {
    expect(flarumAdapter.id).toBe('flarum');
    expect(flarumAdapter.minRamMb).toBe(1024);
    expect(flarumAdapter.blueprintId).toBe('ubuntu_22_04');
    expect([...flarumAdapter.requiredSecrets].sort()).toEqual([
      'adminPassword',
      'apiKey',
      'databasePassword',
    ]);
  });

  it('supports the five resource types and NOT trustLevel', () => {
    const types = flarumAdapter.seed.supportedTypes;
    for (const type of ['setting', 'group', 'category', 'user', 'membership'] as const) {
      expect(types.has(type)).toBe(true);
    }
    expect(types.has('trustLevel')).toBe(false);
    expect(types.size).toBe(5);
  });

  it('exposes TLS capability matching the paths.ts constants', () => {
    expect(flarumAdapter.tls.dns01).toBe(true);
    expect(flarumAdapter.tls.certPaths).toEqual(FLARUM_CERT_PATHS);
    expect(flarumAdapter.tls.reloadCommand).toBe(FLARUM_RELOAD_COMMAND);
    expect(flarumAdapter.tls.http01Webroot).toBe(FLARUM_HTTP01_WEBROOT);
  });
});

describe('flarumOptionsSchema', () => {
  it('accepts {} and applies the pinned defaults', () => {
    const parsed = flarumOptionsSchema.parse({});
    expect(parsed).toEqual({
      adminUsername: FLARUM_DEFAULT_ADMIN_USERNAME,
      version: FLARUM_VERSION,
    });
  });

  it('accepts a trustLevelGroups record', () => {
    const parsed = flarumOptionsSchema.parse({
      trustLevelGroups: { '0': 'members', '3': 'veterans' },
    });
    expect(parsed).toEqual({
      adminUsername: FLARUM_DEFAULT_ADMIN_USERNAME,
      version: FLARUM_VERSION,
      trustLevelGroups: { '0': 'members', '3': 'veterans' },
    });
  });

  it('rejects unknown keys', () => {
    expect(flarumOptionsSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it('rejects an empty admin username', () => {
    expect(flarumOptionsSchema.safeParse({ adminUsername: '' }).success).toBe(false);
  });

  it('rejects an unknown trust-level key', () => {
    expect(flarumOptionsSchema.safeParse({ trustLevelGroups: { '5': 'x' } }).success).toBe(false);
  });
});

describe('flarumAdapter.validate: built-in group names', () => {
  it.each(['Admin', 'Guest', 'Mod', 'Member'])('rejects a config group named %s', (reserved) => {
    const { forum, env } = buildForum({ groups: [{ name: reserved, members: [] }] });
    const issues = flarumAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.groups[0].name');
  });

  it('rejects a built-in group name case-insensitively', () => {
    const { forum, env } = buildForum({ groups: [{ name: 'aDmIn', members: [] }] });
    const issues = flarumAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.groups[0].name');
  });

  it('points at the offending group index when earlier groups are valid', () => {
    const { forum, env } = buildForum({
      groups: [
        { name: 'veterans', members: [] },
        { name: 'guest', members: [] },
      ],
    });
    const issues = flarumAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.groups[1].name');
  });

  it('allows a non-built-in group name', () => {
    const { forum, env } = buildForum({ groups: [{ name: 'veterans', members: [] }] });
    expect(flarumAdapter.validate(forum, env)).toEqual([]);
  });
});

describe('flarumAdapter.validate: trust-level mapping', () => {
  it('reports an unmapped trust level at config.users[i].trustLevel', () => {
    const { forum, env } = buildForum({
      users: [{ username: 'alice', email: 'alice@example.org', trustLevel: 3 }],
      engineOptions: { trustLevelGroups: {} },
    });
    const issues = flarumAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.users[0].trustLevel');
  });

  it('reports a level mapped to an undeclared, non-Member group at engineOptions.trustLevelGroups', () => {
    const { forum, env } = buildForum({
      users: [{ username: 'alice', email: 'alice@example.org', trustLevel: 3 }],
      engineOptions: { trustLevelGroups: { '3': 'veterans' } },
    });
    const issues = flarumAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('engineOptions.trustLevelGroups');
  });

  it('accepts a level mapped to the implicit Member group', () => {
    const { forum, env } = buildForum({
      users: [{ username: 'alice', email: 'alice@example.org', trustLevel: 0 }],
      engineOptions: { trustLevelGroups: { '0': 'members' } },
    });
    expect(flarumAdapter.validate(forum, env)).toEqual([]);
  });

  it('accepts a level mapped to a declared group', () => {
    const { forum, env } = buildForum({
      groups: [{ name: 'veterans', members: [] }],
      users: [{ username: 'alice', email: 'alice@example.org', trustLevel: 3 }],
      engineOptions: { trustLevelGroups: { '0': 'members', '3': 'veterans' } },
    });
    expect(flarumAdapter.validate(forum, env)).toEqual([]);
  });

  it('resolves to the greatest key <= the level (coverage by a lower key)', () => {
    const { forum, env } = buildForum({
      groups: [{ name: 'veterans', members: [] }],
      users: [{ username: 'alice', email: 'alice@example.org', trustLevel: 4 }],
      engineOptions: { trustLevelGroups: { '0': 'members', '3': 'veterans' } },
    });
    expect(flarumAdapter.validate(forum, env)).toEqual([]);
  });
});

describe('flarumAdapter.validate: settings allowlist', () => {
  it('rejects a non-allowlisted setting (mail_driver) at config.settings.<key>', () => {
    const { forum, env } = buildForum({ settings: { mail_driver: 'smtp' } });
    const issues = flarumAdapter.validate(forum, env);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe('config.settings.mail_driver');
  });

  it('allows an allowlisted setting (forum_title)', () => {
    const { forum, env } = buildForum({ settings: { forum_title: 'Example Community' } });
    expect(flarumAdapter.validate(forum, env)).toEqual([]);
  });

  it('returns [] for a clean forum', () => {
    const { forum, env } = buildForum({
      groups: [{ name: 'veterans', members: [] }],
      users: [{ username: 'alice', email: 'alice@example.org', trustLevel: 3 }],
      settings: { forum_title: 'Example Community' },
      engineOptions: { trustLevelGroups: { '0': 'members', '3': 'veterans' } },
    });
    expect(flarumAdapter.validate(forum, env)).toEqual([]);
  });
});

describe('flarumAdapter validate through the loader', () => {
  it('surfaces a built-in group name as a prefixed loader issue', () => {
    expect(() =>
      loadMetadata(
        metadataYaml(`config:
  groups:
    - name: Admin
      members: []`),
        registry,
      ),
    ).toThrow(/forums\[0\]\.config\.groups\[0\]\.name/);
  });

  it('surfaces a non-allowlisted setting as a prefixed loader issue', () => {
    expect(() =>
      loadMetadata(
        metadataYaml(`config:
  settings:
    mail_driver: smtp`),
        registry,
      ),
    ).toThrow(/forums\[0\]\.config\.settings\.mail_driver/);
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

  it('loads a clean Flarum forum through the loader', () => {
    const { forum } = loadForum(`engineOptions:
  trustLevelGroups:
    "0": members`);
    expect(forum.engine).toBe('flarum');
  });
});

describe('flarumAdapter.renderInstallScript', () => {
  function installInput(): InstallScriptInput {
    const { forum, env } = loadForum();
    const adminPassword = forum.secrets['adminPassword'];
    const apiKey = forum.secrets['apiKey'];
    const databasePassword = forum.secrets['databasePassword'];
    if (adminPassword === undefined || apiKey === undefined || databasePassword === undefined) {
      throw new Error('expected adminPassword, apiKey and databasePassword references');
    }
    return {
      environmentName: env.name,
      region: env.region,
      forumId: forum.id,
      hostname: `${forum.subdomain}.${env.rootDomain}`,
      adminEmail: env.adminEmail,
      email: sesSettings(env, forum),
      secrets: { adminPassword, apiKey, databasePassword },
      engineOptions: flarumOptionsSchema.parse(forum.engineOptions),
    };
  }

  it('contains the hostname and pinned image tags', () => {
    const script = flarumAdapter.renderInstallScript(installInput());
    expect(script).toContain('dev.example.org');
    expect(script).toContain(`composer:${COMPOSER_IMAGE_TAG}`);
    expect(script).toContain(`php:${PHP_IMAGE_TAG}-apache-bookworm`);
    expect(script).toContain(`mysql:${MYSQL_IMAGE_TAG}`);
    expect(script).toContain(`caddy:${CADDY_IMAGE_TAG}`);
    expect(script).toContain(`flarum/flarum:${FLARUM_VERSION}`);
  });

  it('renders a Caddyfile with auto_https off and the static tls directive', () => {
    const script = flarumAdapter.renderInstallScript(installInput());
    expect(script).toContain('auto_https off');
    expect(script).toContain('tls /certs/fullchain.pem /certs/privkey.pem');
    expect(script).toContain('reverse_proxy app:80');
  });

  it('issues the certificate before bringing up the proxy container', () => {
    const script = flarumAdapter.renderInstallScript(installInput());
    const issueIdx = script.indexOf('issue_certificate');
    const proxyIdx = script.indexOf('up -d proxy');
    expect(issueIdx).toBeGreaterThanOrEqual(0);
    expect(proxyIdx).toBeGreaterThan(issueIdx);
  });

  it('references the DB, admin and api-key secret references', () => {
    const script = flarumAdapter.renderInstallScript(installInput());
    expect(script).toContain('/community-hub/community-test/dev/database-password');
    expect(script).toContain('/community-hub/community-test/dev/admin-password');
    expect(script).toContain('/community-hub/community-test/dev/api-key');
    expect(script).toContain('write_secret');
  });

  it('contains no secret values, only references and placeholders', () => {
    const script = flarumAdapter.renderInstallScript(installInput());
    expect(script).not.toContain('test-secret-value');
    // Secrets are fetched on the instance, never inlined.
    expect(script).toContain('fetch_secret');
  });

  it('declares a compose project with the services, named volume and pinned mounts', () => {
    const script = flarumAdapter.renderInstallScript(installInput());
    // Extract the docker-compose.yml heredoc body and parse it as YAML.
    const start = script.indexOf('cat >"$CH_FLARUM_ROOT/docker-compose.yml" <<\'COMPOSEFILE\'');
    expect(start).toBeGreaterThanOrEqual(0);
    const afterMarker = script.indexOf('\n', start) + 1;
    const end = script.indexOf('\nCOMPOSEFILE', afterMarker);
    expect(end).toBeGreaterThan(afterMarker);
    const composeText = script.slice(afterMarker, end);
    const compose = parseYaml(composeText) as {
      services: Record<string, { image?: string; volumes?: string[] }>;
      volumes: Record<string, unknown>;
    };
    expect(Object.keys(compose.services).sort()).toEqual(['app', 'db', 'proxy']);
    expect(compose.volumes).toHaveProperty('db-data');
    expect(compose.services['db']?.image).toBe(`mysql:${MYSQL_IMAGE_TAG}`);
    expect(compose.services['proxy']?.volumes).toContain('./Caddyfile:/etc/caddy/Caddyfile:ro');
    expect(compose.services['proxy']?.volumes).toContain(
      `${FLARUM_CERT_PATHS.fullchain.replace('/fullchain.pem', '')}:/certs:ro`,
    );
  });

  it('renders an email-refresh script that short-circuits and honours --no-restart', () => {
    const script = flarumAdapter.renderEmailRefreshScript(installInput());
    expect(script).toContain('--no-restart');
    expect(script).toContain('email settings unchanged');
    expect(script).toContain('php flarum cache:clear');
  });

  it('matches the reload command against the FLARUM_ROOT compose path', () => {
    expect(FLARUM_RELOAD_COMMAND).toContain(FLARUM_ROOT);
  });
});
