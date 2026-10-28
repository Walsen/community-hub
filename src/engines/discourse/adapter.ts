/**
 * The Discourse {@link EngineAdapter}.
 *
 * Wires together the pinned versions, install and email-refresh renderers
 * (`install-script.ts`, `email-refresh.ts`), the seed client (`seed-client.ts`)
 * and the strict options schema (`options.ts`) behind the engine plugin
 * contract. Core modules reach Discourse only through this object (registered
 * in the EngineRegistry in task 12.1); nothing here is imported by `infra/`,
 * `seeder/` or `metadata/` directly.
 *
 * {@link EngineAdapter.validate | validate} is pure and returns issues with
 * paths RELATIVE to the forum (for example `config.groups[0].name`). The
 * loader's `validateCrossField` prefixes them with `forums[i].`, so this
 * adapter must not add that prefix itself.
 */

import { renderEmailRefreshScript } from './email-refresh.js';
import {
  DISCOURSE_CERT_PATHS,
  DISCOURSE_HTTP01_WEBROOT,
  DISCOURSE_RELOAD_COMMAND,
  renderInstallScript,
} from './install-script.js';
import { discourseOptionsSchema } from './options.js';
import { createDiscourseSeedClient, transformDesiredDiscourse } from './seed-client.js';
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

/** The secret references Discourse requires on every forum. */
const DISCOURSE_REQUIRED_SECRETS: readonly ForumSecretName[] = ['adminPassword', 'apiKey'];

/** Resource types the Discourse seed client reconciles. */
const DISCOURSE_SUPPORTED_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'setting',
  'group',
  'category',
  'user',
  'membership',
  'trustLevel',
]);

/**
 * Discourse automatic/reserved group names that may not be declared as config
 * groups (compared case-insensitively). `moderators` is deliberately absent: it
 * is allowed and handled specially by the seed client. The `trust_level_0`..
 * `trust_level_4` names are added below.
 */
const RESERVED_GROUP_NAMES: ReadonlySet<string> = new Set<string>([
  'admins',
  'staff',
  'everyone',
  'trust_level_0',
  'trust_level_1',
  'trust_level_2',
  'trust_level_3',
  'trust_level_4',
]);

/** The site setting whose value is fixed by SES and may not be seeded. */
const FORBIDDEN_SETTING = 'notification_email';

/**
 * TLS capability: Discourse serves the host-issued certificate from its
 * `web.ssl` template, so it supports the ACME DNS-01 challenge. The paths,
 * reload command and HTTP-01 webroot are the single definitions exported by the
 * install script, so the adapter and the rendered user data cannot drift.
 */
const DISCOURSE_TLS: TlsSupport = {
  dns01: true,
  certPaths: DISCOURSE_CERT_PATHS,
  reloadCommand: DISCOURSE_RELOAD_COMMAND,
  http01Webroot: DISCOURSE_HTTP01_WEBROOT,
};

/**
 * Discourse-specific cross-field validation. Pure: collects and returns issues
 * with forum-relative paths rather than throwing.
 *
 * Rules (design "Discourse adapter"):
 *  - A config group may not reuse an automatic/reserved Discourse group name
 *    (`admins`, `staff`, `everyone`, `trust_level_0..4`), compared
 *    case-insensitively. `moderators` is allowed.
 *  - A user's `trustLevel` must be an integer in 0..4. The schema already
 *    constrains this; the belt-and-suspenders check guards against any value
 *    reaching here out of range.
 *  - The `notification_email` site setting may not be seeded: a different From
 *    address would be refused by the SES `ses:FromAddress` condition.
 *
 * @param forum - The forum to validate.
 * @param environment - The environment the forum belongs to (unused here).
 * @returns Validation issues with paths relative to the forum.
 */
function validateDiscourse(
  forum: ForumModel,
  environment: EnvironmentModel,
): readonly ValidationIssue[] {
  void environment;
  const issues: ValidationIssue[] = [];
  const config = forum.config;

  config.groups.forEach((group, index) => {
    if (RESERVED_GROUP_NAMES.has(group.name.trim().toLowerCase())) {
      issues.push({
        path: `config.groups[${String(index)}].name`,
        message: `'${group.name}' is an automatic Discourse group and cannot be declared; remove it`,
      });
    }
  });

  config.users.forEach((user, index) => {
    const level = user.trustLevel;
    if (!Number.isInteger(level) || level < 0 || level > 4) {
      issues.push({
        path: `config.users[${String(index)}].trustLevel`,
        message: `trust level must be an integer from 0 to 4`,
      });
    }
  });

  if (Object.prototype.hasOwnProperty.call(config.settings, FORBIDDEN_SETTING)) {
    issues.push({
      path: `config.settings.${FORBIDDEN_SETTING}`,
      message: `the '${FORBIDDEN_SETTING}' site setting is managed by SES and cannot be seeded`,
    });
  }

  return issues;
}

/** Discourse seed capability: supported types, value encoding and client factory. */
const discourseSeed: SeedSupport = {
  supportedTypes: DISCOURSE_SUPPORTED_TYPES,
  transformDesired(resources: readonly SeedResource[], forum: ForumModel): readonly SeedResource[] {
    void forum;
    return transformDesiredDiscourse(resources);
  },
  createClient(deps: SeedClientDeps): SeedClient {
    return createDiscourseSeedClient(deps);
  },
};

/**
 * The Discourse engine adapter. A const object implementing the full
 * {@link EngineAdapter} contract; register it with the EngineRegistry rather
 * than importing it from core modules.
 */
export const discourseAdapter: EngineAdapter = {
  id: 'discourse',
  minRamMb: 2048,
  blueprintId: 'ubuntu_22_04',
  requiredSecrets: DISCOURSE_REQUIRED_SECRETS,
  engineOptionsSchema: discourseOptionsSchema,
  validate: validateDiscourse,
  tls: DISCOURSE_TLS,
  renderInstallScript(input: InstallScriptInput): string {
    return renderInstallScript(input);
  },
  renderEmailRefreshScript(input: InstallScriptInput): string {
    return renderEmailRefreshScript(input);
  },
  seed: discourseSeed,
};
