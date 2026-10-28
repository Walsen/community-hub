/**
 * The Discourse seed client.
 *
 * Builds a {@link SeedClient} for a single Discourse forum from a typed
 * {@link SeedHandlers} map and {@link composeSeedClient}. Each handler issues
 * the requests documented in the design's Discourse seed-client table through
 * the injected {@link HttpClient} (HTTPS only, JSON). Every request carries the
 * admin API headers `Api-Key: <apiKey>` and `Api-Username: system`.
 *
 * Reads are normalized with the shared normalizers (`src/seeder/normalize.ts`)
 * so the values read back from the forum compare equal to the desired values
 * {@link buildDesired} produces. Setting values are compared as Discourse
 * strings; {@link transformDesiredDiscourse} is the single, pure definition of
 * that encoding and is used by both planning (via the adapter) and this client.
 *
 * Secret hygiene: a user's password is resolved (or generated) at apply time
 * through {@link ApplyContext} and passed straight into the create request body
 * — it is never logged, stored on the resource, or echoed. Request and response
 * bodies are never logged.
 */

import { z } from 'zod';

import type {
  ApplyContext,
  MembershipHandler,
  ResourceHandler,
  SeedClient,
  SeedClientDeps,
  SeedHandlers,
} from '../engine-adapter.js';
import type { DesiredColorScheme, DesiredUser } from '../../seeder/desired.js';
import {
  normalizeColor,
  normalizeEmail,
  normalizeSlug,
  normalizeUsername,
} from '../../seeder/normalize.js';
import type { FieldDiff, SeedResource } from '../../seeder/types.js';
import { ForumApiError } from '../../shared/errors.js';
import type { HttpClient, HttpMethod, HttpResponse } from '../../shared/http.js';
import { composeSeedClient } from '../seed-client.js';

/** Group name Discourse treats specially: its members are moderators. */
const MODERATORS_GROUP = 'moderators';

/** Discourse members-page size; the members endpoint is paged. */
const MEMBERS_PAGE_LIMIT = 100;

/**
 * Encodes a declared setting value into the string form the Discourse admin
 * API expects: booleans as `"true"`/`"false"`, arrays/lists joined with `"|"`,
 * and everything else coerced to its string form. Pure.
 */
function encodeDiscourseSettingValue(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    return value.map((item) => encodeDiscourseSettingValue(item)).join('|');
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return '';
  }
  // Non-scalar, non-list values are not valid Discourse site-setting values;
  // serialize defensively rather than relying on default object stringification.
  return JSON.stringify(value);
}

/**
 * Pure, engine-specific rewrite of desired resources for Discourse: every
 * `setting` resource's value is re-expressed as the Discourse string encoding
 * (booleans `"true"`/`"false"`, lists joined with `"|"`, numbers/strings as
 * strings). All other resource types pass through unchanged.
 *
 * This is used by BOTH the reconciler (through the adapter's
 * `SeedSupport.transformDesired`) and this seed client, so the desired value
 * planned against and the value written to the forum are the identical string.
 * Kept here, next to the client that reads settings back as strings, so the two
 * sides cannot drift.
 *
 * @param resources - The desired resources from `buildDesired`.
 * @returns A new array with `setting` values encoded as Discourse strings.
 */
export function transformDesiredDiscourse(
  resources: readonly SeedResource[],
): readonly SeedResource[] {
  return resources.map((resource) => {
    if (resource.type !== 'setting') {
      return resource;
    }
    const desired = resource.desired as { readonly value: unknown };
    return {
      ...resource,
      desired: { value: encodeDiscourseSettingValue(desired.value) },
    };
  });
}

/** Narrowing schema for the `GET /admin/site_settings.json` payload. */
const SiteSettingsSchema = z.object({
  site_settings: z.array(
    z.object({
      setting: z.string(),
      value: z.unknown(),
    }),
  ),
});

/** A single color-scheme entry from `GET /admin/color_schemes.json`. */
const ColorSchemeEntrySchema = z.object({
  id: z.number(),
  name: z.string(),
  colors: z
    .array(z.object({ name: z.string(), hex: z.string() }))
    .optional()
    .default([]),
});

/** Narrowing schema for the color-schemes list payload. */
const ColorSchemesSchema = z.array(ColorSchemeEntrySchema);

/** Narrowing schema for a single color scheme create/show payload. */
const ColorSchemeShowSchema = z.object({ id: z.number(), name: z.string() });

/** Narrowing schema for the relevant fields of `GET /admin/themes.json`. */
const ThemesListSchema = z.object({
  themes: z.array(
    z.object({
      id: z.number(),
      default: z.boolean().nullish(),
      color_scheme_id: z.number().nullish(),
      dark_color_scheme_id: z.number().nullish(),
    }),
  ),
});

/** The default theme's current color-scheme assignment, for mode read-back. */
interface ThemeSchemeAssignment {
  readonly lightId: number | undefined;
  readonly darkId: number | undefined;
  readonly selectorAuto: boolean;
}

/** Narrowing schema for `GET /groups/{name}.json`. */
const GroupShowSchema = z.object({
  group: z.object({
    id: z.number(),
    name: z.string(),
  }),
});

/** A category entry as it appears in `GET /site.json`. */
const SiteCategorySchema = z.object({
  id: z.number(),
  slug: z.string(),
  name: z.string(),
  color: z.string(),
});

/** Narrowing schema for the relevant part of `GET /site.json`. */
const SiteSchema = z.object({
  categories: z.array(SiteCategorySchema).optional(),
});

/** Narrowing schema for `GET /u/{username}.json`. */
const UserShowSchema = z.object({
  user: z.object({
    id: z.number(),
    username: z.string(),
    trust_level: z.number(),
  }),
});

/** Narrowing schema for `GET /u/{username}/emails.json`. */
const UserEmailsSchema = z.object({
  email: z.string(),
});

/** A single member entry from `GET /groups/{name}/members.json`. */
const MemberSchema = z.object({
  id: z.number(),
  username: z.string(),
});

/** Narrowing schema for the paged group members payload. */
const GroupMembersSchema = z.object({
  members: z.array(MemberSchema),
});

/**
 * Create the Discourse {@link SeedClient} from its dependencies.
 *
 * @param deps - Base URL, resolved admin API key, HTTP client and logger.
 * @returns A {@link SeedClient} whose handlers speak the Discourse admin API.
 */
export function createDiscourseSeedClient(deps: SeedClientDeps): SeedClient {
  const client = new DiscourseApi(deps);

  const handlers: SeedHandlers = {
    setting: client.settingHandler(),
    colorScheme: client.colorSchemeHandler(),
    group: client.groupHandler(),
    category: client.categoryHandler(),
    user: client.userHandler(),
    membership: client.membershipHandler(),
    trustLevel: client.trustLevelHandler(),
  };

  return client.compose(handlers);
}

/**
 * Thin, stateful wrapper over the injected {@link HttpClient} that knows the
 * Discourse admin API: it builds requests with the shared headers, parses
 * response bodies defensively, and caches group and user ids discovered during
 * reads so creates, updates and membership changes can target them by id.
 */
class DiscourseApi {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #http: HttpClient;
  /** Error-context label for HttpRequest.forumId, derived from the base URL. */
  readonly #forumId: string;

  /** Group ids discovered by name during reads, for update/membership. */
  readonly #groupIds = new Map<string, number>();
  /** User ids discovered by username during reads, for moderation/trust level. */
  readonly #userIds = new Map<string, number>();

  constructor(deps: SeedClientDeps) {
    this.#baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.#apiKey = deps.apiKey;
    this.#http = deps.http;
    this.#forumId = forumIdLabel(deps.baseUrl);
  }

  /** Compose the reconciler-facing client over this API's probe and handlers. */
  compose(handlers: SeedHandlers): SeedClient {
    return composeSeedClient(() => this.probe(), handlers);
  }

  /** Reachability probe: a GET that 2xx-s when the forum is up. */
  async probe(): Promise<void> {
    await this.#request('GET', '/site.json');
  }

  // --- setting ------------------------------------------------------------

  settingHandler(): ResourceHandler {
    return {
      read: (keys) => this.#readSettings(keys),
      create: (resource) => this.#putSetting(resource),
      update: (resource) => this.#putSetting(resource),
    };
  }

  async #readSettings(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const wanted = new Set(keys);
    const response = await this.#request('GET', '/admin/site_settings.json');
    const parsed = this.#parse(SiteSettingsSchema, response, 'GET', '/admin/site_settings.json');
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const entry of parsed.site_settings) {
      if (wanted.has(entry.setting)) {
        out.set(entry.setting, { value: encodeDiscourseSettingValue(entry.value) });
      }
    }
    return out;
  }

  async #putSetting(resource: SeedResource): Promise<void> {
    const desired = resource.desired as { readonly value: unknown };
    const key = resource.naturalKey;
    await this.#request('PUT', `/admin/site_settings/${encodeURIComponent(key)}.json`, {
      [key]: encodeDiscourseSettingValue(desired.value),
    });
  }

  // --- colorScheme --------------------------------------------------------

  /** Color-scheme ids discovered by normalized name during reads. */
  readonly #colorSchemeIds = new Map<string, number>();

  colorSchemeHandler(): ResourceHandler {
    return {
      read: (keys) => this.#readColorSchemes(keys),
      create: (resource) => this.#createColorScheme(resource),
      update: (resource) => this.#updateColorScheme(resource),
    };
  }

  async #readColorSchemes(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const wanted = new Map(keys.map((k) => [k.trim().toLowerCase(), k] as const));
    const response = await this.#request('GET', '/admin/color_schemes.json');
    const parsed = this.#parse(ColorSchemesSchema, response, 'GET', '/admin/color_schemes.json');
    // Read the default theme's scheme assignment so `mode` can be read back and
    // compared; without this the mode would diff on every run (it is not a
    // property of the color scheme itself).
    const assignment = await this.#defaultThemeSchemeAssignment();
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const scheme of parsed) {
      const norm = scheme.name.trim().toLowerCase();
      this.#colorSchemeIds.set(norm, scheme.id);
      const requestedKey = wanted.get(norm);
      if (requestedKey !== undefined) {
        const record: Record<string, unknown> = { name: scheme.name.trim() };
        for (const c of scheme.colors) {
          record[`color_${c.name}`] = normalizeColor(c.hex);
        }
        const mode = deriveMode(scheme.id, assignment);
        if (mode !== undefined) {
          record.mode = mode;
        }
        out.set(requestedKey, record);
      }
    }
    return out;
  }

  /** Read the default theme's light/dark scheme ids and selector state. */
  async #defaultThemeSchemeAssignment(): Promise<ThemeSchemeAssignment> {
    const response = await this.#request('GET', '/admin/themes.json');
    const parsed = this.#parse(ThemesListSchema, response, 'GET', '/admin/themes.json');
    const def = parsed.themes.find((t) => t.default === true);
    let selectorAuto = false;
    try {
      const settings = await this.#request('GET', '/admin/site_settings.json');
      const sp = this.#parse(SiteSettingsSchema, settings, 'GET', '/admin/site_settings.json');
      const sel = sp.site_settings.find((x) => x.setting === 'interface_color_selector');
      selectorAuto = sel !== undefined && sel.value !== 'disabled' && sel.value !== '';
    } catch {
      selectorAuto = false;
    }
    return {
      lightId: def?.color_scheme_id ?? undefined,
      darkId: def?.dark_color_scheme_id ?? undefined,
      selectorAuto,
    };
  }

  async #createColorScheme(resource: SeedResource): Promise<void> {
    const desired = resource.desired as DesiredColorScheme;
    const response = await this.#request('POST', '/admin/color_schemes.json', {
      color_scheme: {
        name: desired.name,
        colors: colorsToDiscourse(desired),
      },
    });
    const created = this.#parse(
      ColorSchemeShowSchema,
      response,
      'POST',
      '/admin/color_schemes.json',
    );
    this.#colorSchemeIds.set(desired.name.trim().toLowerCase(), created.id);
    await this.#applyColorSchemeMode(desired, created.id);
  }

  async #updateColorScheme(resource: SeedResource): Promise<void> {
    const desired = resource.desired as DesiredColorScheme;
    const id = await this.#requireColorSchemeId(desired.name);
    await this.#request('PUT', `/admin/color_schemes/${id}.json`, {
      color_scheme: {
        name: desired.name,
        colors: colorsToDiscourse(desired),
      },
    });
    await this.#applyColorSchemeMode(desired, id);
  }

  /**
   * Apply the theme `mode` by assigning this scheme to the DEFAULT THEME. Modern
   * Discourse carries the default light/dark color scheme on the default theme
   * object (`color_scheme_id` / `dark_color_scheme_id`), not on a site setting
   * (the old `default_dark_color_scheme_id` setting does not exist on this
   * version — assuming it did cost a failed apply).
   *
   * - `light`: the scheme is the light scheme AND the dark slot is cleared so
   *   the site always renders in it (a dark-mode visitor still sees the brand).
   * - `dark`: the scheme is the dark slot.
   * - `auto`: the scheme is assigned to BOTH slots so the brand palette shows in
   *   either OS mode, and the interface color selector is enabled so visitors can
   *   still switch. (Assigning only the light slot left dark-mode visitors on the
   *   stock Dark scheme — the brand colours did not appear.)
   *
   * Unknown modes are a no-op.
   */
  async #applyColorSchemeMode(desired: DesiredColorScheme, id: number): Promise<void> {
    const mode = desired.mode;
    if (mode === undefined) {
      return;
    }
    const themeId = await this.#defaultThemeId();
    if (mode === 'light') {
      await this.#request('PUT', `/admin/themes/${themeId}.json`, {
        theme: { color_scheme_id: id, dark_color_scheme_id: null },
      });
    }
    if (mode === 'dark') {
      await this.#request('PUT', `/admin/themes/${themeId}.json`, {
        theme: { dark_color_scheme_id: id },
      });
    }
    if (mode === 'auto') {
      await this.#request('PUT', `/admin/themes/${themeId}.json`, {
        theme: { color_scheme_id: id, dark_color_scheme_id: id },
      });
      // Let each visitor pick / follow their OS light-dark preference.
      await this.#request(
        'PUT',
        '/admin/site_settings/interface_color_selector.json',
        { interface_color_selector: 'sidebar_footer' },
        [422],
      );
    }
  }

  /** The id of the site's default theme (the one flagged `default: true`). */
  async #defaultThemeId(): Promise<number> {
    const response = await this.#request('GET', '/admin/themes.json');
    const parsed = this.#parse(ThemesListSchema, response, 'GET', '/admin/themes.json');
    const def = parsed.themes.find((t) => t.default === true);
    if (def === undefined) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method: 'GET',
        path: '/admin/themes.json',
        status: 0,
        apiMessage: 'no default theme found to attach the color scheme to',
        attempts: 1,
      });
    }
    return def.id;
  }

  async #requireColorSchemeId(name: string): Promise<number> {
    const norm = name.trim().toLowerCase();
    const cached = this.#colorSchemeIds.get(norm);
    if (cached !== undefined) {
      return cached;
    }
    const response = await this.#request('GET', '/admin/color_schemes.json');
    const parsed = this.#parse(ColorSchemesSchema, response, 'GET', '/admin/color_schemes.json');
    for (const scheme of parsed) {
      this.#colorSchemeIds.set(scheme.name.trim().toLowerCase(), scheme.id);
    }
    const id = this.#colorSchemeIds.get(norm);
    if (id === undefined) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method: 'PUT',
        path: '/admin/color_schemes/{id}.json',
        status: 0,
        apiMessage: `color scheme id for name '${name}' was not found`,
        attempts: 0,
      });
    }
    return id;
  }

  // --- group --------------------------------------------------------------

  groupHandler(): ResourceHandler {
    return {
      read: (keys) => this.#readGroups(keys),
      create: (resource) => this.#createGroup(resource),
      update: (resource) => this.#updateGroup(resource),
    };
  }

  async #readGroups(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const key of keys) {
      const response = await this.#request(
        'GET',
        `/groups/${encodeURIComponent(key)}.json`,
        undefined,
        [404],
      );
      if (response.status === 404) {
        continue;
      }
      const parsed = this.#parse(GroupShowSchema, response, 'GET', `/groups/${key}.json`);
      const name = normalizeGroupName(parsed.group.name);
      this.#groupIds.set(name, parsed.group.id);
      out.set(key, { name: parsed.group.name });
    }
    return out;
  }

  async #createGroup(resource: SeedResource): Promise<void> {
    const desired = resource.desired as { readonly name: string };
    await this.#request('POST', '/admin/groups.json', { group: { name: desired.name } });
  }

  async #updateGroup(resource: SeedResource): Promise<void> {
    const id = await this.#requireGroupId(resource.naturalKey);
    const desired = resource.desired as { readonly name: string };
    await this.#request('PUT', `/groups/${id}.json`, { group: { name: desired.name } });
  }

  // --- category -----------------------------------------------------------

  /** Category ids discovered by slug from the last `/site.json` read. */
  readonly #categoryIds = new Map<string, number>();

  categoryHandler(): ResourceHandler {
    return {
      read: (keys) => this.#readCategories(keys),
      create: (resource) => this.#createCategory(resource),
      update: (resource) => this.#updateCategory(resource),
    };
  }

  async #readCategories(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const wanted = new Set(keys);
    const response = await this.#request('GET', '/site.json');
    const parsed = this.#parse(SiteSchema, response, 'GET', '/site.json');
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const category of parsed.categories ?? []) {
      const slug = normalizeSlug(category.slug);
      this.#categoryIds.set(slug, category.id);
      if (wanted.has(slug)) {
        out.set(slug, {
          name: category.name.trim(),
          color: normalizeColor(category.color),
        });
      }
    }
    return out;
  }

  async #createCategory(resource: SeedResource): Promise<void> {
    const desired = resource.desired as { readonly name: string; readonly color: string };
    await this.#request('POST', '/categories.json', {
      name: desired.name,
      color: desired.color,
    });
  }

  async #updateCategory(resource: SeedResource): Promise<void> {
    const id = this.#categoryIds.get(resource.naturalKey);
    if (id === undefined) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method: 'PUT',
        path: '/categories/{id}.json',
        status: 0,
        apiMessage: `category id for slug '${resource.naturalKey}' was not read`,
        attempts: 0,
      });
    }
    const desired = resource.desired as { readonly name: string; readonly color: string };
    await this.#request('PUT', `/categories/${id}.json`, {
      name: desired.name,
      color: desired.color,
    });
  }

  // --- user ---------------------------------------------------------------

  userHandler(): ResourceHandler {
    return {
      read: (keys) => this.#readUsers(keys),
      create: (resource, ctx) => this.#createUser(resource, ctx),
      update: (resource, diff) => this.#updateUser(resource, diff),
    };
  }

  async #readUsers(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const key of keys) {
      const userResponse = await this.#request(
        'GET',
        `/u/${encodeURIComponent(key)}.json`,
        undefined,
        [404],
      );
      if (userResponse.status === 404) {
        continue;
      }
      const user = this.#parse(UserShowSchema, userResponse, 'GET', `/u/${key}.json`);
      this.#userIds.set(normalizeUsername(user.user.username), user.user.id);

      const emailsResponse = await this.#request(
        'GET',
        `/u/${encodeURIComponent(key)}/emails.json`,
      );
      const emails = this.#parse(UserEmailsSchema, emailsResponse, 'GET', `/u/${key}/emails.json`);
      out.set(key, {
        email: normalizeEmail(emails.email),
        trustLevel: user.user.trust_level,
      });
    }
    return out;
  }

  async #createUser(resource: SeedResource, ctx: ApplyContext): Promise<void> {
    const desired = resource.desired as DesiredUser;
    const reference = desired.initialPassword;
    const hasReference = reference !== undefined;
    const password = hasReference ? await ctx.resolveSecret(reference) : ctx.randomPassword();

    await this.#request('POST', '/users.json', {
      name: resource.naturalKey,
      username: resource.naturalKey,
      email: desired.email,
      password,
      active: true,
      approved: true,
    });

    // With no declared password, send the user a reset email so they can set
    // their own; the generated password is never surfaced.
    if (!hasReference) {
      await this.#request('POST', '/session/forgot_password', { login: resource.naturalKey });
    }
  }

  async #updateUser(resource: SeedResource, diff: readonly FieldDiff[]): Promise<void> {
    const emailChange = diff.find((d) => d.field === 'email');
    if (emailChange === undefined || typeof emailChange.to !== 'string') {
      return;
    }
    await this.#request('PUT', `/u/${encodeURIComponent(resource.naturalKey)}/preferences/email`, {
      email: emailChange.to,
    });
  }

  // --- membership ---------------------------------------------------------

  membershipHandler(): MembershipHandler {
    return {
      readMembers: (groups) => this.#readMembers(groups),
      add: (group, username) => this.#addMember(group, username),
      remove: (group, username) => this.#removeMember(group, username),
    };
  }

  async #readMembers(groups: readonly string[]): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
    const out = new Map<string, ReadonlySet<string>>();
    for (const group of groups) {
      const members = new Set<string>();
      let offset = 0;
      for (;;) {
        const response = await this.#request(
          'GET',
          `/groups/${encodeURIComponent(group)}/members.json?limit=${MEMBERS_PAGE_LIMIT}&offset=${offset}`,
          undefined,
          [404],
        );
        if (response.status === 404) {
          break;
        }
        const parsed = this.#parse(
          GroupMembersSchema,
          response,
          'GET',
          `/groups/${group}/members.json`,
        );
        for (const member of parsed.members) {
          // System users (id <= 0) are not managed; exclude them.
          if (member.id <= 0) {
            continue;
          }
          const username = normalizeUsername(member.username);
          members.add(username);
          this.#userIds.set(username, member.id);
        }
        if (parsed.members.length < MEMBERS_PAGE_LIMIT) {
          break;
        }
        offset += parsed.members.length;
      }
      out.set(normalizeGroupName(group), members);
    }
    return out;
  }

  async #addMember(group: string, username: string): Promise<void> {
    if (isModeratorsGroup(group)) {
      const userId = await this.#requireUserId(username);
      await this.#request('PUT', `/admin/users/${userId}/grant_moderation`);
      return;
    }
    const groupId = await this.#requireGroupId(group);
    await this.#request('PUT', `/groups/${groupId}/members.json`, { usernames: username });
  }

  async #removeMember(group: string, username: string): Promise<void> {
    if (isModeratorsGroup(group)) {
      const userId = await this.#requireUserId(username);
      await this.#request('PUT', `/admin/users/${userId}/revoke_moderation`);
      return;
    }
    const groupId = await this.#requireGroupId(group);
    await this.#request('DELETE', `/groups/${groupId}/members.json`, { usernames: username });
  }

  // --- trustLevel ---------------------------------------------------------

  trustLevelHandler(): ResourceHandler {
    return {
      read: (keys) => this.#readTrustLevels(keys),
      create: (resource) => this.#setTrustLevel(resource),
      update: (resource) => this.#setTrustLevel(resource),
    };
  }

  async #readTrustLevels(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const key of keys) {
      const response = await this.#request(
        'GET',
        `/u/${encodeURIComponent(key)}.json`,
        undefined,
        [404],
      );
      if (response.status === 404) {
        continue;
      }
      const parsed = this.#parse(UserShowSchema, response, 'GET', `/u/${key}.json`);
      this.#userIds.set(normalizeUsername(parsed.user.username), parsed.user.id);
      out.set(key, { trustLevel: parsed.user.trust_level });
    }
    return out;
  }

  async #setTrustLevel(resource: SeedResource): Promise<void> {
    const desired = resource.desired as { readonly trustLevel: number };
    const userId = await this.#requireUserId(resource.naturalKey);
    await this.#request('PUT', `/admin/users/${userId}/trust_level`, {
      level: desired.trustLevel,
    });
  }

  // --- id resolution helpers ---------------------------------------------

  /** Return a cached group id, or read the group to discover it. */
  async #requireGroupId(name: string): Promise<number> {
    const normalized = normalizeGroupName(name);
    const cached = this.#groupIds.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
    const response = await this.#request('GET', `/groups/${encodeURIComponent(name)}.json`);
    const parsed = this.#parse(GroupShowSchema, response, 'GET', `/groups/${name}.json`);
    this.#groupIds.set(normalizeGroupName(parsed.group.name), parsed.group.id);
    return parsed.group.id;
  }

  /** Return a cached user id, or read the user to discover it. */
  async #requireUserId(username: string): Promise<number> {
    const normalized = normalizeUsername(username);
    const cached = this.#userIds.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
    const response = await this.#request('GET', `/u/${encodeURIComponent(username)}.json`);
    const parsed = this.#parse(UserShowSchema, response, 'GET', `/u/${username}.json`);
    this.#userIds.set(normalizeUsername(parsed.user.username), parsed.user.id);
    return parsed.user.id;
  }

  // --- request plumbing ---------------------------------------------------

  /**
   * Issue one admin API request with the shared headers. `allowStatuses` lets a
   * read tolerate specific non-2xx statuses (for example a 404 meaning the
   * entity is absent) without the HTTP client throwing; when such a status is
   * returned the caller inspects `response.status`. All other non-2xx responses
   * become {@link ForumApiError} inside the HTTP client.
   */
  async #request(
    method: HttpMethod,
    path: string,
    body?: unknown,
    allowStatuses: readonly number[] = [],
  ): Promise<HttpResponse> {
    try {
      return await this.#http.request({
        forumId: this.#forumId,
        method,
        url: `${this.#baseUrl}${path}`,
        headers: {
          'Api-Key': this.#apiKey,
          'Api-Username': 'system',
          Accept: 'application/json',
        },
        ...(body !== undefined ? { body } : {}),
      });
    } catch (error) {
      if (error instanceof ForumApiError && allowStatuses.includes(error.status)) {
        return { status: error.status, headers: new Headers(), body: undefined };
      }
      throw error;
    }
  }

  /**
   * Parse a response body with a narrowing schema, raising a body-free
   * {@link ForumApiError} when the shape is not what the admin API should
   * return. Never surfaces the body itself.
   */
  #parse<T>(schema: z.ZodType<T>, response: HttpResponse, method: HttpMethod, path: string): T {
    const result = schema.safeParse(response.body);
    if (!result.success) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method,
        path,
        status: response.status,
        apiMessage: 'unexpected response shape',
        attempts: 1,
      });
    }
    return result.data;
  }
}

/**
 * Convert a canonical slot->hex map into Discourse's color-scheme `colors`
 * array form `[{ name, hex }]`. Hex values are emitted without a leading `#`,
 * which is what the admin API stores and returns.
 */
/**
 * Derive the theme `mode` for a color scheme from the default theme's current
 * assignment, matching what `#applyColorSchemeMode` writes: the scheme assigned
 * as the light scheme with the OS selector on reads back as `auto`; as the light
 * scheme alone reads back as `light`; as the dark scheme reads back as `dark`.
 * Returns undefined when the scheme is not the default theme's light or dark
 * scheme (so an undeclared mode never diffs).
 */
function deriveMode(
  schemeId: number,
  a: ThemeSchemeAssignment,
): 'light' | 'dark' | 'auto' | undefined {
  const isLight = a.lightId === schemeId;
  const isDark = a.darkId === schemeId;
  // `auto` writes the scheme to BOTH slots and turns the selector on.
  if (isLight && isDark && a.selectorAuto) {
    return 'auto';
  }
  // `light` writes the light slot and clears the dark slot.
  if (isLight && a.darkId === undefined) {
    return 'light';
  }
  // `dark` writes only the dark slot.
  if (isDark && !isLight) {
    return 'dark';
  }
  // Any other assignment (e.g. light set but dark points elsewhere) is not one
  // this adapter produces, so report no managed mode rather than diff forever.
  if (isLight) {
    return 'light';
  }
  if (isDark) {
    return 'dark';
  }
  return undefined;
}

function colorsToDiscourse(desired: DesiredColorScheme): { name: string; hex: string }[] {
  const out: { name: string; hex: string }[] = [];
  for (const [field, value] of Object.entries(desired)) {
    if (field.startsWith('color_') && typeof value === 'string') {
      out.push({ name: field.slice('color_'.length), hex: value });
    }
  }
  return out;
}

/** Whether a group name denotes Discourse's special moderators group. */
function isModeratorsGroup(name: string): boolean {
  return normalizeGroupName(name) === MODERATORS_GROUP;
}

/** Normalize a group name for comparison: trimmed and lowercased. */
function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Derive a stable forum-id label from a base URL for {@link HttpRequest}'s
 * `forumId` error-context field. Uses the host; falls back to the raw string.
 */
function forumIdLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
