/**
 * Builds the desired-state resource list for a forum (pure).
 *
 * {@link buildDesired} converts a validated forum's `config` section into the
 * ordered list of {@link SeedResource}s the reconciler plans over. It is the
 * desired half of the "Comparison semantics" in the data-model steering: every
 * value is normalized here (via {@link module:seeder/normalize}) the same way
 * the engine seed clients normalize the actual state they read back, so the two
 * sides compare equal.
 *
 * This module is pure: no I/O, no clock, no randomness. Secret_References stay
 * references — no secret value is ever resolved here.
 */

import type { ForumModel } from '../metadata/schema.js';
import type { SecretReference } from '../metadata/secret-ref.js';

import {
  normalizeColor,
  normalizeEmail,
  normalizeSlug,
  normalizeUsername,
  trimString,
} from './normalize.js';
import { type SeedResource } from './types.js';

/**
 * Field names, by nothing more than their name, that must never be compared or
 * diffed by the reconciler. They are carried in a resource's `desired` so the
 * executor can use them when creating the entity, but they are write-only: the
 * forum never reads them back, so diffing them would always report a spurious
 * change. The reconciler (task 7.2) reads this set to exclude these fields.
 *
 * Currently a user's `initialPassword` reference is the only such field.
 */
export const WRITE_ONLY_FIELDS: ReadonlySet<string> = new Set(['initialPassword']);

/** Normalized declared attributes of a `setting` resource. */
export interface DesiredSetting {
  readonly value: unknown;
}

/** Normalized declared attributes of a `group` resource (members excluded). */
export interface DesiredGroup {
  readonly name: string;
}

/** Normalized declared attributes of a `category` resource. */
export interface DesiredCategory {
  readonly name: string;
  readonly color: string;
}

/** Normalized declared attributes of a `user` resource. */
export interface DesiredUser {
  readonly email: string;
  readonly trustLevel: number;
  /**
   * Write-only reference to the user's initial password, present only when a
   * password is declared. Never diffed (see {@link WRITE_ONLY_FIELDS}); used by
   * the executor on create only.
   */
  readonly initialPassword?: SecretReference;
}

/** Normalized declared attributes of a `membership` resource. */
export interface DesiredMembership {
  readonly member: true;
}

/** Normalized declared attributes of a `trustLevel` resource. */
export interface DesiredTrustLevel {
  readonly trustLevel: number;
}

/**
 * Converts a validated forum's `config` into the ordered list of
 * {@link SeedResource}s to reconcile.
 *
 * Resources are emitted in declaration order within each subsection and in the
 * subsection order settings → groups → categories → users → memberships →
 * trustLevels. (The reconciler re-sorts by `RESOURCE_TYPE_ORDER` then natural
 * key, so the order here only needs to be deterministic.)
 *
 * - **settings**: one `setting` per key; `naturalKey` is the trimmed key,
 *   `desired` is `{ value }`.
 * - **groups**: one `group` per group; `naturalKey` is the normalized name,
 *   `desired` is the group's attributes excluding `members` (members become
 *   `membership` resources).
 * - **categories**: one `category` per category; `naturalKey` is the normalized
 *   slug, `desired` is `{ name, color }` with the colour normalized.
 * - **users**: one `user` per user; `naturalKey` is the normalized username,
 *   `desired` is `{ email, trustLevel }` plus a write-only `initialPassword`
 *   reference when a password is declared.
 * - **memberships**: one `membership` per (group, member) pair; `naturalKey` is
 *   `"<normalizedGroup>:<normalizedUsername>"`, `desired` is `{ member: true }`.
 * - **trustLevels**: one `trustLevel` per user; `naturalKey` is the normalized
 *   username, `desired` is `{ trustLevel }`. (The Flarum adapter rewrites these
 *   into memberships in `transformDesired`; that is engine logic, not here.)
 *
 * @param forum - A validated, expanded forum.
 * @returns The ordered desired-state resources (declared fields only).
 */
export function buildDesired(forum: ForumModel): SeedResource[] {
  const { config } = forum;
  const resources: SeedResource[] = [];

  for (const [key, value] of Object.entries(config.settings)) {
    const desired: DesiredSetting = { value };
    resources.push({ type: 'setting', naturalKey: trimString(key), desired });
  }

  for (const group of config.groups) {
    const name = trimString(group.name);
    const desired: DesiredGroup = { name };
    resources.push({ type: 'group', naturalKey: name, desired });
  }

  for (const category of config.categories) {
    const desired: DesiredCategory = {
      name: trimString(category.name),
      color: normalizeColor(category.color),
    };
    resources.push({ type: 'category', naturalKey: normalizeSlug(category.slug), desired });
  }

  for (const user of config.users) {
    const desired: DesiredUser = {
      email: normalizeEmail(user.email),
      trustLevel: user.trustLevel,
      ...(user.password !== undefined ? { initialPassword: user.password } : {}),
    };
    resources.push({ type: 'user', naturalKey: normalizeUsername(user.username), desired });
  }

  for (const group of config.groups) {
    const groupKey = trimString(group.name);
    for (const member of group.members) {
      const username = normalizeUsername(member);
      const desired: DesiredMembership = { member: true };
      resources.push({
        type: 'membership',
        naturalKey: `${groupKey}:${username}`,
        desired,
      });
    }
  }

  for (const user of config.users) {
    const desired: DesiredTrustLevel = { trustLevel: user.trustLevel };
    resources.push({ type: 'trustLevel', naturalKey: normalizeUsername(user.username), desired });
  }

  return resources;
}
