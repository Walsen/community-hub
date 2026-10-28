/**
 * The Flarum {@link EngineAdapter}.
 *
 * Wires together the pinned versions, install and email-refresh renderers
 * (`install-script.ts`, `email-refresh.ts`), the seed client (`seed-client.ts`),
 * the TLS capability constants (`paths.ts`) and the strict options schema
 * (`options.ts`) behind the engine plugin contract. Core modules reach Flarum
 * only through this object (registered in the EngineRegistry in task 12.1);
 * nothing here is imported by `infra/`, `seeder/` or `metadata/` directly.
 *
 * {@link EngineAdapter.validate | validate} is pure and returns issues with
 * paths RELATIVE to the forum (for example `config.groups[0].name`). The
 * loader's `validateCrossField` prefixes them with `forums[i].`, so this
 * adapter must not add that prefix itself.
 */

import { renderEmailRefreshScript } from './email-refresh.js';
import { renderInstallScript } from './install-script.js';
import { flarumOptionsSchema } from './options.js';
import { FLARUM_CERT_PATHS, FLARUM_HTTP01_WEBROOT, FLARUM_RELOAD_COMMAND } from './paths.js';
import {
  createFlarumSeedClient,
  FLARUM_SETTING_ALLOWLIST,
  resolveTrustLevelGroup,
  transformDesiredFlarum,
} from './seed-client.js';
import type {
  EngineAdapter,
  ForumSecretName,
  InstallScriptInput,
  SeedClient,
  SeedClientDeps,
  SeedSupport,
  TlsSupport,
} from '../engine-adapter.js';
import type { ValidationIssue } from '../../metadata/errors.js';
import type { EnvironmentModel, ForumModel } from '../../metadata/schema.js';
import type { ResourceType, SeedResource } from '../../seeder/types.js';

/** The secret references Flarum requires on every forum. */
const FLARUM_REQUIRED_SECRETS: readonly ForumSecretName[] = [
  'adminPassword',
  'apiKey',
  'databasePassword',
];

/**
 * Resource types the Flarum seed client reconciles. `trustLevel` is absent on
 * purpose: {@link transformDesiredFlarum} rewrites each trust level into a
 * `membership` resource before planning, so the client never handles one.
 */
const FLARUM_SUPPORTED_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'setting',
  'group',
  'category',
  'user',
  'membership',
]);

/** The trust-level keys `engineOptions.trustLevelGroups` may assign. */
const TRUST_LEVEL_KEYS = ['0', '1', '2', '3', '4'] as const;
type TrustLevelKey = (typeof TRUST_LEVEL_KEYS)[number];

/**
 * Built-in Flarum group names (compared case-insensitively) that may not be
 * declared as config groups: Admin, Guest and Mod are automatic, and Member is
 * the implicit group every user belongs to.
 */
const BUILTIN_GROUP_NAMES: ReadonlySet<string> = new Set<string>([
  'admin',
  'guest',
  'mod',
  'member',
]);

/**
 * Flarum names (case-insensitive) of the implicit Member group. A trust level
 * mapped here means "no extra group", so the group need not be declared.
 */
const IMPLICIT_MEMBER_GROUP_NAMES: ReadonlySet<string> = new Set<string>(['member', 'members']);

/**
 * TLS capability: Flarum serves the host-issued certificate through Caddy's
 * static `tls` directive, so it supports the ACME DNS-01 challenge. The paths,
 * reload command and HTTP-01 webroot are the single definitions exported by
 * `paths.ts`, so the adapter and the rendered user data cannot drift. The cert
 * paths are hostname-independent (one forum per instance).
 */
const FLARUM_TLS: TlsSupport = {
  dns01: true,
  certPaths: FLARUM_CERT_PATHS,
  reloadCommand: FLARUM_RELOAD_COMMAND,
  http01Webroot: FLARUM_HTTP01_WEBROOT,
};

/** Normalize a group name for comparison: trimmed and lowercased. */
function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase();
}

/** Whether a mapped group name denotes the implicit Member group. */
function isImplicitMemberGroup(group: string): boolean {
  return IMPLICIT_MEMBER_GROUP_NAMES.has(normalizeGroupName(group));
}

/** Read `engineOptions.trustLevelGroups` as a plain record, defensively. */
function readTrustLevelGroups(engineOptions: unknown): Partial<Record<TrustLevelKey, string>> {
  if (typeof engineOptions !== 'object' || engineOptions === null) {
    return {};
  }
  const raw = (engineOptions as { readonly trustLevelGroups?: unknown }).trustLevelGroups;
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const out: Partial<Record<TrustLevelKey, string>> = {};
  for (const key of TRUST_LEVEL_KEYS) {
    const value = record[key];
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Flarum-specific cross-field validation. Pure: collects and returns issues
 * with forum-relative paths rather than throwing.
 *
 * Rules (design "Flarum adapter"):
 *  - A config group may not reuse a built-in Flarum group name (`Admin`,
 *    `Guest`, `Mod`, `Member`), compared case-insensitively.
 *  - If a user declares a `trustLevel`, `engineOptions.trustLevelGroups` must
 *    map it — an exact key, else the greatest declared key ≤ the level
 *    (resolved by {@link resolveTrustLevelGroup}). The mapped group must be a
 *    declared config group, except the implicit Member group
 *    (`member`/`members`, case-insensitive), which means "no extra group". An
 *    unmapped level is reported at `config.users[u].trustLevel`; a mapped but
 *    undeclared, non-Member group at `engineOptions.trustLevelGroups`.
 *  - A seeded setting key must be in {@link FLARUM_SETTING_ALLOWLIST}; the
 *    allowlist excludes every `mail_*` key, so seeding cannot override the SES
 *    settings. Any other declared key is reported at `config.settings.<key>`.
 *
 * @param forum - The forum to validate.
 * @param environment - The environment the forum belongs to (unused here).
 * @returns Validation issues with paths relative to the forum.
 */
function validateFlarum(
  forum: ForumModel,
  environment: EnvironmentModel,
): readonly ValidationIssue[] {
  void environment;
  const issues: ValidationIssue[] = [];
  const config = forum.config;

  // Built-in group names may not be declared.
  config.groups.forEach((group, index) => {
    if (BUILTIN_GROUP_NAMES.has(normalizeGroupName(group.name))) {
      issues.push({
        path: `config.groups[${String(index)}].name`,
        message: `'${group.name}' is a built-in Flarum group and cannot be declared; remove it`,
      });
    }
  });

  // Trust-level mapping: every declared trust level must resolve to a declared
  // group (or the implicit Member group).
  const declaredGroups = new Set(config.groups.map((group) => normalizeGroupName(group.name)));
  const mapping = readTrustLevelGroups(forum.engineOptions);
  config.users.forEach((user, index) => {
    const level = user.trustLevel;
    const group = resolveTrustLevelGroup(mapping, level);
    if (group === undefined) {
      issues.push({
        path: `config.users[${String(index)}].trustLevel`,
        message: `trust level ${String(level)} is not mapped by engineOptions.trustLevelGroups`,
      });
      return;
    }
    if (isImplicitMemberGroup(group)) {
      return;
    }
    if (!declaredGroups.has(normalizeGroupName(group))) {
      issues.push({
        path: `engineOptions.trustLevelGroups`,
        message: `group '${group}' mapped for trust level ${String(level)} is not a declared group`,
      });
    }
  });

  // Seeded setting keys must be allowlisted (which excludes every mail_* key).
  for (const key of Object.keys(config.settings)) {
    if (!FLARUM_SETTING_ALLOWLIST.has(key)) {
      issues.push({
        path: `config.settings.${key}`,
        message: `setting '${key}' is not in the Flarum settings allowlist and cannot be seeded`,
      });
    }
  }

  return issues;
}

/** Flarum seed capability: supported types, value rewrite and client factory. */
const flarumSeed: SeedSupport = {
  supportedTypes: FLARUM_SUPPORTED_TYPES,
  transformDesired(resources: readonly SeedResource[], forum: ForumModel): readonly SeedResource[] {
    return transformDesiredFlarum(resources, forum);
  },
  createClient(deps: SeedClientDeps): SeedClient {
    return createFlarumSeedClient(deps);
  },
};

/**
 * The Flarum engine adapter. A const object implementing the full
 * {@link EngineAdapter} contract; register it with the EngineRegistry rather
 * than importing it from core modules.
 */
export const flarumAdapter: EngineAdapter = {
  id: 'flarum',
  minRamMb: 1024,
  blueprintId: 'ubuntu_22_04',
  requiredSecrets: FLARUM_REQUIRED_SECRETS,
  engineOptionsSchema: flarumOptionsSchema,
  validate: validateFlarum,
  tls: FLARUM_TLS,
  renderInstallScript(input: InstallScriptInput): string {
    return renderInstallScript(input);
  },
  renderEmailRefreshScript(input: InstallScriptInput): string {
    return renderEmailRefreshScript(input);
  },
  seed: flarumSeed,
};
