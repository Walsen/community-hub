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

/**
 * Normalized declared attributes of a `colorScheme` resource (the theme
 * palette). Each colour is a normalized six-hex value without `#` (uppercased by
 * `normalizeColor`). Slots are explicit optional fields rather than a nested map
 * so the reconciler diffs only the slots that were declared and ignores derived
 * slots the engine auto-populates (Discourse adds `selected`/`hover`/`love`),
 * keeping re-application idempotent. `mode` rides along so the engine sets the
 * default-scheme behaviour where it manages the palette.
 */
export interface DesiredColorScheme {
  readonly name: string;
  readonly mode?: 'light' | 'dark' | 'auto';
  readonly color_primary?: string;
  readonly color_secondary?: string;
  readonly color_tertiary?: string;
  readonly color_quaternary?: string;
  readonly color_header_background?: string;
  readonly color_header_primary?: string;
  readonly color_highlight?: string;
  readonly color_danger?: string;
  readonly color_success?: string;
  readonly color_love?: string;
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

  // Theme: the palette becomes one `colorScheme` resource; branding strings and
  // the interface mode are lowered into `setting` resources using canonical
  // (Discourse) setting keys. Engines remap keys in their `transformDesired`.
  const theme = config.theme;
  if (theme !== undefined) {
    if (theme.palette !== undefined) {
      const p = theme.palette;
      const name = trimString(p.name ?? 'community-hub');
      const desired: DesiredColorScheme = {
        name,
        ...(theme.mode !== undefined ? { mode: theme.mode } : {}),
        ...(p.primary !== undefined ? { color_primary: normalizeColor(p.primary) } : {}),
        ...(p.secondary !== undefined ? { color_secondary: normalizeColor(p.secondary) } : {}),
        ...(p.tertiary !== undefined ? { color_tertiary: normalizeColor(p.tertiary) } : {}),
        ...(p.quaternary !== undefined ? { color_quaternary: normalizeColor(p.quaternary) } : {}),
        ...(p.headerBackground !== undefined
          ? { color_header_background: normalizeColor(p.headerBackground) }
          : {}),
        ...(p.headerPrimary !== undefined
          ? { color_header_primary: normalizeColor(p.headerPrimary) }
          : {}),
        ...(p.highlight !== undefined ? { color_highlight: normalizeColor(p.highlight) } : {}),
        ...(p.danger !== undefined ? { color_danger: normalizeColor(p.danger) } : {}),
        ...(p.success !== undefined ? { color_success: normalizeColor(p.success) } : {}),
        ...(p.love !== undefined ? { color_love: normalizeColor(p.love) } : {}),
      };
      resources.push({ type: 'colorScheme', naturalKey: name, desired });
    }

    const branding = theme.branding;
    if (branding !== undefined) {
      const brandingSettings: Array<readonly [string, unknown]> = [];
      if (branding.title !== undefined) brandingSettings.push(['title', branding.title]);
      if (branding.logo !== undefined) brandingSettings.push(['logo', branding.logo]);
      if (branding.logoSmall !== undefined)
        brandingSettings.push(['logo_small', branding.logoSmall]);
      if (branding.favicon !== undefined) brandingSettings.push(['favicon', branding.favicon]);
      for (const [key, value] of brandingSettings) {
        const desired: DesiredSetting = { value };
        resources.push({ type: 'setting', naturalKey: key, desired });
      }
    }
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
