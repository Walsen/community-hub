/**
 * The Flarum seed client.
 *
 * Builds a {@link SeedClient} for a single Flarum forum from a typed
 * {@link SeedHandlers} map and {@link composeSeedClient}. Each handler issues
 * the requests documented in the design's Flarum seed-client table through the
 * injected {@link HttpClient} (HTTPS only, JSON:API). Every request carries the
 * admin header `Authorization: Token <apiKey>` (the key is bound to the admin
 * user id); writes send the JSON:API content type `application/vnd.api+json`.
 *
 * Reads are normalized with the shared normalizers (`src/seeder/normalize.ts`)
 * so the values read back from the forum compare equal to the desired values
 * {@link buildDesired} produces.
 *
 * Flarum has no categories; they map to tags (the bundled `flarum/tags`
 * extension). Flarum has no trust levels either: the adapter's
 * {@link transformDesiredFlarum} rewrites each `trustLevel` resource into a
 * `membership` resource for the mapped group before planning, so this client
 * registers no `trustLevel` handler.
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
import type { ForumModel } from '../../metadata/schema.js';
import type { DesiredUser } from '../../seeder/desired.js';
import {
  normalizeColor,
  normalizeEmail,
  normalizeSlug,
  normalizeUsername,
  trimString,
} from '../../seeder/normalize.js';
import type { FieldDiff, SeedResource } from '../../seeder/types.js';
import { ForumApiError } from '../../shared/errors.js';
import type { HttpClient, HttpMethod, HttpResponse } from '../../shared/http.js';
import { composeSeedClient } from '../seed-client.js';

/** JSON:API media type Flarum expects on write request bodies. */
const JSON_API_CONTENT_TYPE = 'application/vnd.api+json';

/** Media type we accept back from Flarum (it serves JSON:API). */
const JSON_API_ACCEPT = 'application/vnd.api+json';

/**
 * Setting keys the Flarum seed client may read and write, by their Flarum
 * setting key. The allowlist is the single authority for which forum settings
 * seeding manages; the adapter's `validate` (task 11.3) rejects any declared
 * setting key outside it.
 *
 * Crucially this list EXCLUDES every `mail_*` key, so seeding can never
 * override the SES_Settings the Platform configures on the instance.
 */
export const FLARUM_SETTING_ALLOWLIST: ReadonlySet<string> = new Set([
  'forum_title',
  'forum_description',
  'welcome_title',
  'welcome_message',
  'default_locale',
  'display_name_driver',
  'slug_driver_discussions',
  'show_language_selector',
  'theme_primary_color',
  'theme_secondary_color',
  'theme_dark_mode_default',
  'theme_colored_header',
]);

/** The Flarum names (case-insensitive) of the implicit Member group. */
const IMPLICIT_MEMBER_GROUP_NAMES: ReadonlySet<string> = new Set(['member', 'members']);

/** Flarum trust-level group mapping: level string → declared group name. */
const TRUST_LEVEL_KEYS = ['0', '1', '2', '3', '4'] as const;
type TrustLevelKey = (typeof TRUST_LEVEL_KEYS)[number];
type TrustLevelGroups = Partial<Record<TrustLevelKey, string>>;

/** Narrowing schema for a forum's `engineOptions.trustLevelGroups` mapping. */
const TrustLevelGroupsSchema = z
  .object({
    trustLevelGroups: z.partialRecord(z.enum(TRUST_LEVEL_KEYS), z.string()).optional(),
  })
  .passthrough();

/**
 * Resolve the group a trust level maps to, using the Flarum mapping rule: an
 * exact key match wins, otherwise the greatest declared key less than or equal
 * to the level. Returns `undefined` when no key is at or below the level.
 *
 * @param mapping - The `trustLevelGroups` record from the forum's options.
 * @param level - The declared trust level (0..4).
 * @returns The mapped group name, or `undefined` when nothing maps.
 */
export function resolveTrustLevelGroup(
  mapping: TrustLevelGroups,
  level: number,
): string | undefined {
  const exact = mapping[String(level) as TrustLevelKey];
  if (exact !== undefined) {
    return exact;
  }
  let best: string | undefined;
  let bestKey = -1;
  for (const key of TRUST_LEVEL_KEYS) {
    const value = mapping[key];
    if (value === undefined) {
      continue;
    }
    const numericKey = Number(key);
    if (numericKey <= level && numericKey > bestKey) {
      best = value;
      bestKey = numericKey;
    }
  }
  return best;
}

/** Whether a mapped group name denotes the implicit Member group. */
function isImplicitMemberGroup(group: string): boolean {
  return IMPLICIT_MEMBER_GROUP_NAMES.has(group.trim().toLowerCase());
}

/**
 * Pure, engine-specific rewrite of desired resources for Flarum. Flarum has no
 * trust levels, so each `trustLevel` resource is rewritten into a `membership`
 * resource for the group the forum's `engineOptions.trustLevelGroups` maps the
 * level to:
 *
 * - the mapping is resolved with {@link resolveTrustLevelGroup} (exact key, else
 *   the greatest key ≤ the level);
 * - when the mapped group is the implicit Member group (`member`/`members`,
 *   case-insensitive) NO resource is emitted, since membership in Member is
 *   implicit for every user;
 * - otherwise a `membership` resource with natural key `"<group>:<username>"`
 *   and desired `{ member: true }` is emitted and the original `trustLevel`
 *   resource is dropped.
 *
 * All non-`trustLevel` resources (including settings, whose allowlist is
 * enforced upstream by the adapter's `validate`) pass through unchanged. The
 * mapped groups are declared groups, so the reconciler's authoritative
 * membership for declared groups makes the union of declared members and
 * trust-level-mapped users the authoritative set — no further special-casing
 * is needed here.
 *
 * Pure: reads `engineOptions` off the forum, no I/O.
 *
 * @param resources - The desired resources from `buildDesired`.
 * @param forum - The validated forum, for its `engineOptions.trustLevelGroups`.
 * @returns A new array with trust levels rewritten to memberships.
 */
export function transformDesiredFlarum(
  resources: readonly SeedResource[],
  forum: ForumModel,
): readonly SeedResource[] {
  const parsed = TrustLevelGroupsSchema.safeParse(forum.engineOptions);
  const mapping: TrustLevelGroups = parsed.success ? (parsed.data.trustLevelGroups ?? {}) : {};

  const out: SeedResource[] = [];
  for (const resource of resources) {
    if (resource.type !== 'trustLevel') {
      out.push(resource);
      continue;
    }
    const desired = resource.desired as { readonly trustLevel: number };
    const group = resolveTrustLevelGroup(mapping, desired.trustLevel);
    if (group === undefined || isImplicitMemberGroup(group)) {
      // No extra group for the implicit Member group (or an unmapped level);
      // drop the trust-level resource entirely.
      continue;
    }
    const username = resource.naturalKey;
    out.push({
      type: 'membership',
      naturalKey: `${trimString(group)}:${username}`,
      desired: { member: true },
    });
  }
  return out;
}

// --- JSON:API narrowing schemas -------------------------------------------

/** A JSON:API resource object with string id and an attributes bag. */
const JsonApiResourceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

/** Forum attributes live on the single resource of `GET /api`. */
const ForumDocumentSchema = z.object({
  data: z.object({
    attributes: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** A list document: `data` is an array of resource objects. */
const ListDocumentSchema = z.object({
  data: z.array(JsonApiResourceSchema),
});

/** A user resource, including its `groups` relationship linkage. */
const UserResourceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  attributes: z
    .object({
      username: z.string().optional(),
      email: z.string().optional(),
    })
    .passthrough()
    .optional(),
  relationships: z
    .object({
      groups: z
        .object({
          data: z
            .array(z.object({ id: z.union([z.string(), z.number()]).transform((v) => String(v)) }))
            .optional(),
        })
        .optional(),
    })
    .optional(),
});

/** A users list document with group linkage per user. */
const UsersDocumentSchema = z.object({
  data: z.array(UserResourceSchema),
});

/**
 * Create the Flarum {@link SeedClient} from its dependencies.
 *
 * @param deps - Base URL, resolved admin API key, HTTP client and logger.
 * @returns A {@link SeedClient} whose handlers speak the Flarum JSON:API.
 */
export function createFlarumSeedClient(deps: SeedClientDeps): SeedClient {
  const client = new FlarumApi(deps);

  const handlers: SeedHandlers = {
    setting: client.settingHandler(),
    group: client.groupHandler(),
    category: client.categoryHandler(),
    user: client.userHandler(),
    membership: client.membershipHandler(),
  };

  return client.compose(handlers);
}

/**
 * Thin, stateful wrapper over the injected {@link HttpClient} that knows the
 * Flarum JSON:API: it builds requests with the admin token header, parses
 * response bodies defensively, and caches group, tag and user ids discovered
 * during reads so creates, updates and membership changes can target them.
 */
class FlarumApi {
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #http: HttpClient;
  /** Error-context label for HttpRequest.forumId, derived from the base URL. */
  readonly #forumId: string;

  /** Group ids discovered by normalized name during reads. */
  readonly #groupIds = new Map<string, string>();
  /** Group names discovered by id during reads (for membership read-back). */
  readonly #groupNamesById = new Map<string, string>();
  /** Tag ids discovered by normalized slug during reads. */
  readonly #tagIds = new Map<string, string>();
  /** User ids discovered by normalized username during reads. */
  readonly #userIds = new Map<string, string>();

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
    await this.#request('GET', '/api');
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
    const response = await this.#request('GET', '/api');
    const parsed = this.#parse(ForumDocumentSchema, response, 'GET', '/api');
    const attributes = parsed.data.attributes ?? {};
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const key of wanted) {
      if (!FLARUM_SETTING_ALLOWLIST.has(key)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(attributes, key)) {
        out.set(key, { value: normalizeSettingValue(attributes[key]) });
      }
    }
    return out;
  }

  async #putSetting(resource: SeedResource): Promise<void> {
    const desired = resource.desired as { readonly value: unknown };
    const key = resource.naturalKey;
    if (!FLARUM_SETTING_ALLOWLIST.has(key)) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method: 'POST',
        path: '/api/settings',
        status: 0,
        apiMessage: `setting '${key}' is not in the Flarum settings allowlist`,
        attempts: 0,
      });
    }
    // Flarum upserts settings as a flat key/value object on POST /api/settings.
    await this.#request('POST', '/api/settings', { [key]: desired.value });
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
    const wanted = new Set(keys);
    const response = await this.#request('GET', '/api/groups');
    const parsed = this.#parse(ListDocumentSchema, response, 'GET', '/api/groups');
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const resource of parsed.data) {
      const attrs = resource.attributes ?? {};
      const name = readGroupName(attrs);
      if (name === undefined) {
        continue;
      }
      const normalized = normalizeGroupName(name);
      this.#groupIds.set(normalized, resource.id);
      this.#groupNamesById.set(resource.id, normalized);
      if (wanted.has(normalized)) {
        out.set(normalized, { name: trimString(name) });
      }
    }
    return out;
  }

  async #createGroup(resource: SeedResource): Promise<void> {
    const desired = resource.desired as { readonly name: string };
    await this.#request('POST', '/api/groups', {
      data: {
        type: 'groups',
        attributes: { nameSingular: desired.name, namePlural: desired.name },
      },
    });
  }

  async #updateGroup(resource: SeedResource): Promise<void> {
    const id = await this.#requireGroupId(resource.naturalKey);
    const desired = resource.desired as { readonly name: string };
    await this.#request('PATCH', `/api/groups/${encodeURIComponent(id)}`, {
      data: {
        type: 'groups',
        id,
        attributes: { nameSingular: desired.name, namePlural: desired.name },
      },
    });
  }

  // --- category (Flarum tags) --------------------------------------------

  categoryHandler(): ResourceHandler {
    return {
      read: (keys) => this.#readTags(keys),
      create: (resource) => this.#createTag(resource),
      update: (resource) => this.#updateTag(resource),
    };
  }

  async #readTags(
    keys: readonly string[],
  ): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
    const wanted = new Set(keys);
    const response = await this.#request('GET', '/api/tags');
    const parsed = this.#parse(ListDocumentSchema, response, 'GET', '/api/tags');
    const out = new Map<string, Readonly<Record<string, unknown>>>();
    for (const resource of parsed.data) {
      const attrs = resource.attributes ?? {};
      const slugValue = attrs['slug'];
      if (typeof slugValue !== 'string') {
        continue;
      }
      const slug = normalizeSlug(slugValue);
      this.#tagIds.set(slug, resource.id);
      if (wanted.has(slug)) {
        const name = attrs['name'];
        const color = attrs['color'];
        out.set(slug, {
          name: typeof name === 'string' ? trimString(name) : '',
          color: typeof color === 'string' ? normalizeColor(color) : '',
        });
      }
    }
    return out;
  }

  async #createTag(resource: SeedResource): Promise<void> {
    const desired = resource.desired as { readonly name: string; readonly color: string };
    await this.#request('POST', '/api/tags', {
      data: {
        type: 'tags',
        attributes: {
          name: desired.name,
          slug: resource.naturalKey,
          color: toHashColor(desired.color),
        },
      },
    });
  }

  async #updateTag(resource: SeedResource): Promise<void> {
    const id = await this.#requireTagId(resource.naturalKey);
    const desired = resource.desired as { readonly name: string; readonly color: string };
    await this.#request('PATCH', `/api/tags/${encodeURIComponent(id)}`, {
      data: {
        type: 'tags',
        id,
        attributes: {
          name: desired.name,
          color: toHashColor(desired.color),
        },
      },
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
      const user = await this.#findUser(key);
      if (user === undefined) {
        continue;
      }
      const email = user.attributes?.email;
      out.set(key, {
        email: typeof email === 'string' ? normalizeEmail(email) : '',
      });
    }
    return out;
  }

  async #createUser(resource: SeedResource, ctx: ApplyContext): Promise<void> {
    const desired = resource.desired as DesiredUser;
    const reference = desired.initialPassword;
    const hasReference = reference !== undefined;
    const password = hasReference ? await ctx.resolveSecret(reference) : ctx.randomPassword();

    await this.#request('POST', '/api/users', {
      data: {
        type: 'users',
        attributes: {
          username: resource.naturalKey,
          email: desired.email,
          password,
          isEmailConfirmed: true,
        },
      },
    });

    // With no declared password, send the user a reset email so they can set
    // their own; the generated password is never surfaced.
    if (!hasReference) {
      await this.#request('POST', '/api/forgot', { data: { email: desired.email } });
    }
  }

  async #updateUser(resource: SeedResource, diff: readonly FieldDiff[]): Promise<void> {
    const emailChange = diff.find((d) => d.field === 'email');
    if (emailChange === undefined || typeof emailChange.to !== 'string') {
      return;
    }
    const id = await this.#requireUserId(resource.naturalKey);
    await this.#request('PATCH', `/api/users/${encodeURIComponent(id)}`, {
      data: {
        type: 'users',
        id,
        attributes: { email: emailChange.to },
      },
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
    const declared = new Set(groups.map(normalizeGroupName));
    const out = new Map<string, Set<string>>();
    for (const group of declared) {
      out.set(group, new Set<string>());
    }

    // Ensure group id↔name is known so we can map a user's group linkage back
    // to declared group names.
    await this.#ensureGroupsLoaded();

    // Flarum has no "members of a group" endpoint; read users and group them by
    // their `relationships.groups` linkage, keeping only declared groups.
    let offset = 0;
    for (;;) {
      const path = `/api/users?page[limit]=50&page[offset]=${offset}`;
      const response = await this.#request('GET', path);
      const parsed = this.#parse(UsersDocumentSchema, response, 'GET', '/api/users');
      if (parsed.data.length === 0) {
        break;
      }
      for (const user of parsed.data) {
        const username = user.attributes?.username;
        if (typeof username !== 'string') {
          continue;
        }
        const normalizedUser = normalizeUsername(username);
        this.#userIds.set(normalizedUser, user.id);
        for (const linkage of user.relationships?.groups?.data ?? []) {
          const groupName = this.#groupNamesById.get(linkage.id);
          if (groupName !== undefined && declared.has(groupName)) {
            out.get(groupName)?.add(normalizedUser);
          }
        }
      }
      offset += parsed.data.length;
    }

    return out;
  }

  async #addMember(group: string, username: string): Promise<void> {
    const groupId = await this.#requireGroupId(group);
    const current = await this.#currentGroupIds(username);
    const next = new Set(current);
    next.add(groupId);
    await this.#setUserGroups(username, [...next]);
  }

  async #removeMember(group: string, username: string): Promise<void> {
    const groupId = await this.#requireGroupId(group);
    const current = await this.#currentGroupIds(username);
    const next = new Set(current);
    next.delete(groupId);
    await this.#setUserGroups(username, [...next]);
  }

  /** Read a user's current group ids from the forum. */
  async #currentGroupIds(username: string): Promise<string[]> {
    const user = await this.#findUser(normalizeUsername(username));
    if (user === undefined) {
      return [];
    }
    return (user.relationships?.groups?.data ?? []).map((linkage) => linkage.id);
  }

  /** Replace a user's group relationship with the given group ids. */
  async #setUserGroups(username: string, groupIds: readonly string[]): Promise<void> {
    const id = await this.#requireUserId(username);
    await this.#request('PATCH', `/api/users/${encodeURIComponent(id)}`, {
      data: {
        type: 'users',
        id,
        relationships: {
          groups: {
            data: groupIds.map((groupId) => ({ type: 'groups', id: groupId })),
          },
        },
      },
    });
  }

  // --- id resolution helpers ---------------------------------------------

  /** Find a user by username via the JSON:API filter query. */
  async #findUser(username: string): Promise<z.infer<typeof UserResourceSchema> | undefined> {
    const query = `username:${username}`;
    const path = `/api/users?filter[q]=${encodeURIComponent(query)}`;
    const response = await this.#request('GET', path);
    const parsed = this.#parse(UsersDocumentSchema, response, 'GET', '/api/users');
    const normalized = normalizeUsername(username);
    const match = parsed.data.find(
      (user) =>
        typeof user.attributes?.username === 'string' &&
        normalizeUsername(user.attributes.username) === normalized,
    );
    if (match !== undefined) {
      this.#userIds.set(normalized, match.id);
    }
    return match;
  }

  /** Load the group list once so id↔name linkage is available. */
  async #ensureGroupsLoaded(): Promise<void> {
    if (this.#groupNamesById.size > 0) {
      return;
    }
    const response = await this.#request('GET', '/api/groups');
    const parsed = this.#parse(ListDocumentSchema, response, 'GET', '/api/groups');
    for (const resource of parsed.data) {
      const name = readGroupName(resource.attributes ?? {});
      if (name === undefined) {
        continue;
      }
      const normalized = normalizeGroupName(name);
      this.#groupIds.set(normalized, resource.id);
      this.#groupNamesById.set(resource.id, normalized);
    }
  }

  /** Return a cached group id, or read the group list to discover it. */
  async #requireGroupId(name: string): Promise<string> {
    const normalized = normalizeGroupName(name);
    const cached = this.#groupIds.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
    await this.#ensureGroupsLoaded();
    const id = this.#groupIds.get(normalized);
    if (id === undefined) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method: 'GET',
        path: '/api/groups',
        status: 0,
        apiMessage: `group '${normalized}' was not found`,
        attempts: 0,
      });
    }
    return id;
  }

  /** Return a cached tag id for a slug, or fail if it was not read. */
  async #requireTagId(slug: string): Promise<string> {
    const normalized = normalizeSlug(slug);
    const cached = this.#tagIds.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
    const response = await this.#request('GET', '/api/tags');
    const parsed = this.#parse(ListDocumentSchema, response, 'GET', '/api/tags');
    for (const resource of parsed.data) {
      const slugValue = resource.attributes?.['slug'];
      if (typeof slugValue === 'string') {
        this.#tagIds.set(normalizeSlug(slugValue), resource.id);
      }
    }
    const id = this.#tagIds.get(normalized);
    if (id === undefined) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method: 'GET',
        path: '/api/tags',
        status: 0,
        apiMessage: `tag for slug '${normalized}' was not found`,
        attempts: 0,
      });
    }
    return id;
  }

  /** Return a cached user id, or find the user to discover it. */
  async #requireUserId(username: string): Promise<string> {
    const normalized = normalizeUsername(username);
    const cached = this.#userIds.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
    const user = await this.#findUser(normalized);
    if (user === undefined) {
      throw new ForumApiError({
        forumId: this.#forumId,
        method: 'GET',
        path: '/api/users',
        status: 0,
        apiMessage: `user '${normalized}' was not found`,
        attempts: 0,
      });
    }
    return user.id;
  }

  // --- request plumbing ---------------------------------------------------

  /**
   * Issue one JSON:API request with the admin token header. `allowStatuses`
   * lets a read tolerate specific non-2xx statuses (for example a 404 meaning
   * the entity is absent) without the HTTP client throwing; when such a status
   * is returned the caller inspects `response.status`. All other non-2xx
   * responses become {@link ForumApiError} inside the HTTP client.
   */
  async #request(
    method: HttpMethod,
    path: string,
    body?: unknown,
    allowStatuses: readonly number[] = [],
  ): Promise<HttpResponse> {
    const headers: Record<string, string> = {
      Authorization: `Token ${this.#apiKey}`,
      Accept: JSON_API_ACCEPT,
    };
    if (body !== undefined) {
      headers['Content-Type'] = JSON_API_CONTENT_TYPE;
    }
    try {
      return await this.#http.request({
        forumId: this.#forumId,
        method,
        url: `${this.#baseUrl}${path}`,
        headers,
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
   * {@link ForumApiError} when the shape is not what the API should return.
   * Never surfaces the body itself.
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
 * Normalize a setting value read back from Flarum. Flarum returns settings as
 * strings in forum attributes; strings are trimmed so trivial whitespace does
 * not cause spurious diffs. Non-string values pass through unchanged.
 */
function normalizeSettingValue(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Read a Flarum group's display name from its attributes, preferring
 * `nameSingular` and falling back to `namePlural`.
 */
function readGroupName(attrs: Readonly<Record<string, unknown>>): string | undefined {
  const singular = attrs['nameSingular'];
  if (typeof singular === 'string') {
    return singular;
  }
  const plural = attrs['namePlural'];
  if (typeof plural === 'string') {
    return plural;
  }
  return undefined;
}

/** Normalize a group name for comparison: trimmed and lowercased. */
function normalizeGroupName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Convert a bare normalized hex colour (`"0088CC"`) to the `#`-prefixed form
 * Flarum tags expect. An empty value stays empty.
 */
function toHashColor(color: string): string {
  if (color.length === 0) {
    return '';
  }
  return color.startsWith('#') ? color : `#${color}`;
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
