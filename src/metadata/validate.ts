/**
 * Cross-field and adapter-driven validation for the Metadata_Loader.
 *
 * {@link validateCrossField} runs after the Zod schema has parsed, refined and
 * expanded the document (so secret fields are already {@link SecretReference}s
 * and the mail/DNS rules have run). It performs the checks that need the whole
 * document or the resolved {@link EngineAdapter}: duplicate ids/subdomains,
 * Secret_Reference path scoping, reserved SES parameter names, group-member and
 * SSH-CIDR integrity, and each forum's engine, options, required secrets,
 * bundle size and adapter-specific rules.
 *
 * It is pure: no I/O, no clock, no randomness. It collects issues rather than
 * throwing (the loader aggregates them into one
 * {@link module:metadata/errors.MetadataValidationError}). Messages carry field
 * paths and reasons only and never echo a secret value.
 *
 * Adapter path convention: {@link EngineAdapter.validate} returns issues whose
 * paths are relative to the forum (for example `engineOptions.trustLevelGroups`
 * or `config.users[0].trustLevel`). {@link validateCrossField} prefixes each
 * with `forums[i].` so the final path is document-absolute. The Discourse and
 * Flarum adapters (tasks 10/11) MUST follow this forum-relative convention.
 */

import { bundleRamMb, isKnownBundleId, LIGHTSAIL_BUNDLES } from './bundles.js';
import { formatPath, type PathSegment, type ValidationIssue } from './errors.js';
import { secretName, type SecretReference } from './secret-ref.js';
import type { EnvironmentModel, ForumModel, ValidatedModel } from './schema.js';
import type { EngineAdapter } from '../engines/engine-adapter.js';
import type { EngineRegistry } from '../engines/registry.js';

/** The reserved Platform-managed secret purposes under each forum's prefix. */
const RESERVED_SECRET_PURPOSES = ['ses-smtp-password', 'ses-smtp-username'] as const;

/**
 * Run every cross-field and adapter-driven metadata check and return the
 * collected issues. Never throws for validation failures and never mutates the
 * model; the result depends only on `(model, registry)`.
 *
 * @param model - The Zod-validated and expanded metadata model.
 * @param registry - The Engine_Registry used to resolve each forum's engine.
 * @returns All validation issues found, unsorted (the loader sorts them).
 */
export function validateCrossField(
  model: ValidatedModel,
  registry: EngineRegistry,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  checkDuplicateForumKeys(model.forums, issues);
  checkSshCidrs(model.environment, issues);

  for (let i = 0; i < model.forums.length; i++) {
    const forum = model.forums[i];
    if (forum === undefined) {
      continue;
    }
    checkForum(model.environment, forum, i, registry, issues);
  }

  return issues;
}

/**
 * Reject duplicate forum ids and duplicate subdomains. The message names the
 * duplicated value (ids and subdomains are not secret). The issue is reported
 * on each repeat occurrence after the first, at `forums[i].id` /
 * `forums[i].subdomain`.
 */
function checkDuplicateForumKeys(
  forums: ValidatedModel['forums'],
  issues: ValidationIssue[],
): void {
  const seenIds = new Set<string>();
  const seenSubdomains = new Set<string>();

  for (let i = 0; i < forums.length; i++) {
    const forum = forums[i];
    if (forum === undefined) {
      continue;
    }
    if (seenIds.has(forum.id)) {
      issues.push({
        path: formatPath(['forums', i, 'id']),
        message: `duplicate forum id '${forum.id}'`,
      });
    } else {
      seenIds.add(forum.id);
    }
    if (seenSubdomains.has(forum.subdomain)) {
      issues.push({
        path: formatPath(['forums', i, 'subdomain']),
        message: `duplicate subdomain '${forum.subdomain}'`,
      });
    } else {
      seenSubdomains.add(forum.subdomain);
    }
  }
}

/** Reject any SSH CIDR with a `/0` prefix: no `0.0.0.0/0` for SSH (Req). */
function checkSshCidrs(environment: EnvironmentModel, issues: ValidationIssue[]): void {
  const cidrs = environment.sshAllowedCidrs;
  for (let i = 0; i < cidrs.length; i++) {
    const cidr = cidrs[i];
    if (cidr === undefined) {
      continue;
    }
    if (/\/0$/.test(cidr)) {
      issues.push({
        path: formatPath(['environment', 'sshAllowedCidrs', i]),
        message: 'SSH CIDR must not use a /0 prefix (open to the world is not allowed)',
      });
    }
  }
}

/**
 * Run every per-forum check: secret references, engine resolution, options,
 * required secrets, bundle sizing, group members and adapter validation.
 */
function checkForum(
  environment: EnvironmentModel,
  forum: ForumModel,
  index: number,
  registry: EngineRegistry,
  issues: ValidationIssue[],
): void {
  checkSecretReferences(environment, forum, index, issues);
  checkGroupNames(forum, index, issues);
  checkGroupMembers(forum, index, issues);

  // Unknown engine: emit the issue and skip adapter-driven checks for this
  // forum. The loader's schema does not resolve the engine, so this is the
  // single place that reports an unregistered engine id.
  if (!registry.has(forum.engine)) {
    issues.push({
      path: formatPath(['forums', index, 'engine']),
      message: `unknown engine '${forum.engine}'; known engines: ${registry.ids().join(', ')}`,
    });
    return;
  }

  const adapter = registry.resolve(forum.engine);
  checkEngineOptions(adapter, forum, index, issues);
  checkRequiredSecrets(adapter, forum, index, issues);
  checkBundle(adapter, forum, index, issues);

  // Adapter-specific rules. The adapter returns forum-relative paths; prefix
  // them with `forums[i].` to make them document-absolute.
  for (const issue of adapter.validate(forum, environment)) {
    issues.push({
      path: prefixForumPath(index, issue.path),
      message: issue.message,
    });
  }
}

/**
 * Every forum Secret_Reference (in `secrets.*` and user `password` fields) must
 * live under `/community-hub/<env>/<forumId>/` for both stores, and must not
 * use a reserved `ses-smtp-*` name. Messages never echo the reference value.
 */
function checkSecretReferences(
  environment: EnvironmentModel,
  forum: ForumModel,
  index: number,
  issues: ValidationIssue[],
): void {
  const prefix = `/community-hub/${environment.name}/${forum.id}/`;

  for (const [key, ref] of Object.entries(forum.secrets)) {
    checkSecretReference(ref, prefix, ['forums', index, 'secrets', key], issues);
  }

  const users = forum.config.users;
  for (let j = 0; j < users.length; j++) {
    const user = users[j];
    if (user?.password === undefined) {
      continue;
    }
    checkSecretReference(
      user.password,
      prefix,
      ['forums', index, 'config', 'users', j, 'password'],
      issues,
    );
  }
}

/**
 * Check one Secret_Reference: its name must start with the forum prefix and
 * must not be a reserved Platform name. For Secrets Manager ARNs the name
 * segment (via {@link secretName}) is checked. Never echoes the value.
 */
function checkSecretReference(
  ref: SecretReference,
  prefix: string,
  path: readonly PathSegment[],
  issues: ValidationIssue[],
): void {
  const name = secretName(ref);
  if (!name.startsWith(prefix)) {
    issues.push({
      path: formatPath(path),
      message: `secret reference must be under '${prefix}'`,
    });
    return;
  }
  const purpose = name.slice(prefix.length);
  if ((RESERVED_SECRET_PURPOSES as readonly string[]).includes(purpose)) {
    issues.push({
      path: formatPath(path),
      message: `secret name '${purpose}' is reserved for the Platform`,
    });
  }
}

/**
 * Group names must not contain `:`. Membership resources are keyed
 * `"<group>:<username>"` and both the reconciler and the executor split that key
 * on the FIRST colon, so a group name containing one would be mis-parsed into a
 * different group and username. Rejected at `forums[i].config.groups[g].name`.
 */
function checkGroupNames(forum: ForumModel, index: number, issues: ValidationIssue[]): void {
  const groups = forum.config.groups;
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group !== undefined && group.name.includes(':')) {
      issues.push({
        path: formatPath(['forums', index, 'config', 'groups', g, 'name']),
        message:
          "group name must not contain ':' (it delimits group and username in membership keys)",
      });
    }
  }
}

/**
 * Every username in a group's `members` list must reference a declared user.
 * Undeclared members are rejected at `forums[i].config.groups[g].members[m]`.
 */
function checkGroupMembers(forum: ForumModel, index: number, issues: ValidationIssue[]): void {
  const declaredUsers = new Set(forum.config.users.map((user) => user.username));
  const groups = forum.config.groups;

  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    if (group === undefined) {
      continue;
    }
    for (let m = 0; m < group.members.length; m++) {
      const member = group.members[m];
      if (member === undefined) {
        continue;
      }
      if (!declaredUsers.has(member)) {
        issues.push({
          path: formatPath(['forums', index, 'config', 'groups', g, 'members', m]),
          message: `group member '${member}' is not a declared user`,
        });
      }
    }
  }
}

/** Validate `engineOptions` with the adapter's schema, prefixing Zod paths. */
function checkEngineOptions(
  adapter: EngineAdapter,
  forum: ForumModel,
  index: number,
  issues: ValidationIssue[],
): void {
  const result = adapter.engineOptionsSchema.safeParse(forum.engineOptions);
  if (result.success) {
    return;
  }
  for (const issue of result.error.issues) {
    const relative: PathSegment[] = issue.path.map((segment) =>
      typeof segment === 'number' ? segment : String(segment),
    );
    issues.push({
      path: formatPath(['forums', index, 'engineOptions', ...relative]),
      message: issue.message,
    });
  }
}

/** Every secret the adapter requires must be present in `forums[i].secrets`. */
function checkRequiredSecrets(
  adapter: EngineAdapter,
  forum: ForumModel,
  index: number,
  issues: ValidationIssue[],
): void {
  for (const required of adapter.requiredSecrets) {
    if (!Object.prototype.hasOwnProperty.call(forum.secrets, required)) {
      issues.push({
        path: formatPath(['forums', index, 'secrets']),
        message: `required secret '${required}' is missing`,
      });
    }
  }
}

/**
 * The forum's bundle must be a known id with at least the adapter's minimum
 * RAM. An unknown id lists the known ids; an undersized id states the minimum.
 */
function checkBundle(
  adapter: EngineAdapter,
  forum: ForumModel,
  index: number,
  issues: ValidationIssue[],
): void {
  const path = formatPath(['forums', index, 'bundleId']);
  if (!isKnownBundleId(forum.bundleId)) {
    const known = Object.keys(LIGHTSAIL_BUNDLES).join(', ');
    issues.push({
      path,
      message: `unknown bundle id '${forum.bundleId}'; known bundles: ${known}`,
    });
    return;
  }
  const ramMb = bundleRamMb(forum.bundleId);
  if (ramMb !== undefined && ramMb < adapter.minRamMb) {
    issues.push({
      path,
      message: `bundle '${forum.bundleId}' has ${String(ramMb)} MB RAM; engine '${adapter.id}' requires at least ${String(adapter.minRamMb)} MB`,
    });
  }
}

/**
 * Prefix a forum-relative adapter path with `forums[i].`. A relative path that
 * starts with a bracketed index (for example `[0].name`) is appended without a
 * separating dot; any other path is joined with a dot.
 */
function prefixForumPath(index: number, relative: string): string {
  const base = formatPath(['forums', index]);
  if (relative === '' || relative === '<root>') {
    return base;
  }
  return relative.startsWith('[') ? `${base}${relative}` : `${base}.${relative}`;
}
