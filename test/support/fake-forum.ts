/**
 * An in-memory fake forum implementing the {@link SeedClient} contract.
 *
 * The reconciler and executor are tested against this fake instead of a real
 * forum HTTP API: it holds entity and membership state in memory, applies
 * create/update/membership actions to that state, and records a call log so
 * tests can assert which mutating operations ran and in what order. It mirrors
 * the read-scoping of `composeSeedClient` (only the keys and declared groups in
 * `desired` are returned by {@link SeedClient.readActual}) and the membership
 * semantics of the data-model steering (a `member: false` desired on an
 * `update` removes the membership; there is no delete action).
 *
 * Two test affordances are built in:
 * - failure injection by natural key, so `apply` throws a {@link ForumApiError}
 *   for a chosen resource and executor continue-on-failure can be exercised;
 * - an `unreachable` mode, so {@link SeedClient.probe} rejects with a
 *   {@link ForumUnreachableError} and unreachable-forum handling can be tested.
 *
 * Everything here is in-memory and deterministic: no network, no clock, no
 * randomness, and no real secret values (callers use obvious placeholders).
 */

import type { ApplyContext, SeedClient } from '../../src/engines/engine-adapter.js';
import { normalizeUsername, trimString } from '../../src/seeder/normalize.js';
import type {
  ActualState,
  CreateAction,
  ResourceKey,
  ResourceType,
  SeedResource,
  UpdateAction,
} from '../../src/seeder/types.js';
import { resourceKey } from '../../src/seeder/types.js';
import { ForumApiError, ForumUnreachableError } from '../../src/shared/errors.js';

/** The mutating operation a {@link FakeForumCall} records. */
export type FakeForumMethod = 'create' | 'update' | 'addMember' | 'removeMember';

/** One recorded mutating call against the fake forum. */
export interface FakeForumCall {
  /** The kind of mutation performed. */
  readonly method: FakeForumMethod;
  /** The resource type the mutation acted on. */
  readonly type: ResourceType;
  /** The resource's natural key (`"<group>:<username>"` for memberships). */
  readonly naturalKey: string;
}

/** Normalized attributes of an entity, as the fake stores and returns them. */
export type EntityAttrs = Readonly<Record<string, unknown>>;

/** Options for {@link createFakeForum}; every field is optional. */
export interface FakeForumOptions {
  /**
   * Resource types this fake supports, surfaced as {@link SeedClient} behaviour
   * only indirectly (the adapter's `SeedSupport.supportedTypes` drives the
   * reconciler). Defaults to every non-`membership` type plus `membership`.
   */
  readonly supportedTypes?: ReadonlySet<ResourceType>;
  /**
   * Initial actual entity state, keyed by {@link ResourceKey}. Attributes are
   * stored as given; callers are expected to pass already-normalized values to
   * match the comparison semantics the reconciler uses.
   */
  readonly initialEntities?: ReadonlyMap<ResourceKey, EntityAttrs>;
  /**
   * Initial actual group memberships, keyed by group natural key. Usernames are
   * normalized on seed so they compare equal to declared memberships.
   */
  readonly initialMemberships?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Natural keys that {@link SeedClient.apply} must fail on. When an action's
   * resource natural key is in this set, `apply` throws a {@link ForumApiError}
   * and the in-memory state is left unchanged for that action.
   */
  readonly failKeys?: ReadonlySet<string>;
  /**
   * When `true`, {@link SeedClient.probe} rejects with a
   * {@link ForumUnreachableError} so unreachable-forum handling can be tested.
   */
  readonly unreachable?: boolean;
  /** Forum id used in injected errors (default `'fakeforum'`). */
  readonly forumId?: string;
}

/**
 * The fake forum: a {@link SeedClient} plus read-only accessors onto its call
 * log and current in-memory state, for assertions.
 */
export interface FakeForum {
  /** The seed client the reconciler and executor drive. */
  readonly client: SeedClient;
  /** The resource types this fake reports as supported. */
  readonly supportedTypes: ReadonlySet<ResourceType>;
  /** Mutating calls recorded so far, in call order. */
  readonly calls: readonly FakeForumCall[];
  /** A snapshot of the current entity state, keyed by {@link ResourceKey}. */
  entities(): ReadonlyMap<ResourceKey, EntityAttrs>;
  /** A snapshot of the current membership state, keyed by group natural key. */
  memberships(): ReadonlyMap<string, ReadonlySet<string>>;
}

/** A decoded membership natural key (`"<group>:<username>"`). */
interface MembershipParts {
  readonly group: string;
  readonly username: string;
}

/**
 * Split a membership natural key into its group and username. Group natural
 * keys never contain a colon, so the first colon is the separator. Mirrors the
 * decoding in `composeSeedClient`.
 */
function parseMembershipKey(naturalKey: string): MembershipParts {
  const sep = naturalKey.indexOf(':');
  if (sep < 0) {
    throw new Error(`malformed membership natural key '${naturalKey}' (expected 'group:username')`);
  }
  return {
    group: naturalKey.slice(0, sep),
    username: naturalKey.slice(sep + 1),
  };
}

/** Whether an update action expresses a membership removal (`member: false`). */
function isMembershipRemoval(action: CreateAction | UpdateAction): boolean {
  const { desired } = action.resource;
  return (
    typeof desired === 'object' &&
    desired !== null &&
    (desired as Record<string, unknown>).member === false
  );
}

/** Extract the declared attributes of an action as a plain record. */
function desiredAttrs(action: CreateAction | UpdateAction): EntityAttrs {
  const { desired } = action.resource;
  if (typeof desired === 'object' && desired !== null) {
    return { ...(desired as Record<string, unknown>) };
  }
  return { value: desired };
}

/** Default supported types: every type the data model defines. */
const ALL_SUPPORTED_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'setting',
  'group',
  'category',
  'user',
  'membership',
  'trustLevel',
]);

/**
 * Build an in-memory fake forum.
 *
 * @param options - Initial state, supported types, failure injection and
 *   reachability, all optional.
 * @returns A {@link FakeForum} exposing the client plus state and call-log
 *   accessors.
 */
export function createFakeForum(options: FakeForumOptions = {}): FakeForum {
  const supportedTypes = options.supportedTypes ?? ALL_SUPPORTED_TYPES;
  const failKeys = options.failKeys ?? new Set<string>();
  const unreachable = options.unreachable ?? false;
  const forumId = options.forumId ?? 'fakeforum';

  // Mutable in-memory state, seeded from the options.
  const entities = new Map<ResourceKey, EntityAttrs>();
  const initialEntities: ReadonlyMap<ResourceKey, EntityAttrs> =
    options.initialEntities ?? new Map<ResourceKey, EntityAttrs>();
  for (const [key, attrs] of initialEntities) {
    entities.set(key, { ...attrs });
  }

  const memberships = new Map<string, Set<string>>();
  const initialMemberships: ReadonlyMap<string, ReadonlySet<string>> = options.initialMemberships ??
  new Map<string, ReadonlySet<string>>();
  for (const [group, members] of initialMemberships) {
    const normalized = new Set<string>();
    for (const member of members) {
      normalized.add(normalizeUsername(member));
    }
    memberships.set(trimString(group), normalized);
  }

  const calls: FakeForumCall[] = [];

  function record(method: FakeForumMethod, type: ResourceType, naturalKey: string): void {
    calls.push({ method, type, naturalKey });
  }

  /** Throw a body-free {@link ForumApiError} for a failure-injected key. */
  function failFor(method: string, naturalKey: string): never {
    throw new ForumApiError({
      forumId,
      method,
      path: `/fake/${naturalKey}`,
      status: 500,
      apiMessage: 'injected failure',
      attempts: 1,
    });
  }

  function probe(): Promise<void> {
    if (unreachable) {
      return Promise.reject(
        new ForumUnreachableError({
          forumId,
          url: `https://${forumId}.example.org`,
          cause: 'ECONNREFUSED',
        }),
      );
    }
    return Promise.resolve();
  }

  function readActual(desired: readonly SeedResource[]): Promise<ActualState> {
    // Mirror composeSeedClient: return only the entity keys and group
    // memberships that appear in `desired`; everything else stays unmanaged.
    const outEntities = new Map<ResourceKey, EntityAttrs>();
    const groupKeys = new Set<string>();

    for (const resource of desired) {
      if (resource.type === 'membership') {
        groupKeys.add(parseMembershipKey(resource.naturalKey).group);
        continue;
      }
      const key = resourceKey(resource.type, resource.naturalKey);
      const attrs = entities.get(key);
      if (attrs !== undefined) {
        outEntities.set(key, { ...attrs });
      }
    }

    const outMemberships = new Map<string, ReadonlySet<string>>();
    for (const group of groupKeys) {
      const members = memberships.get(group);
      if (members !== undefined) {
        outMemberships.set(group, new Set(members));
      }
    }

    return Promise.resolve({ entities: outEntities, memberships: outMemberships });
  }

  function apply(action: CreateAction | UpdateAction, ctx: ApplyContext): Promise<void> {
    void ctx;
    const { type, naturalKey } = action.resource;

    if (type === 'membership') {
      return applyMembership(action, naturalKey);
    }

    if (failKeys.has(naturalKey)) {
      failFor(action.kind === 'create' ? 'POST' : 'PUT', naturalKey);
    }

    const key = resourceKey(type, naturalKey);
    if (action.kind === 'create') {
      entities.set(key, desiredAttrs(action));
      record('create', type, naturalKey);
    } else {
      const existing = entities.get(key) ?? {};
      entities.set(key, { ...existing, ...desiredAttrs(action) });
      record('update', type, naturalKey);
    }
    return Promise.resolve();
  }

  function applyMembership(action: CreateAction | UpdateAction, naturalKey: string): Promise<void> {
    if (failKeys.has(naturalKey)) {
      failFor('PUT', naturalKey);
    }
    const { group, username } = parseMembershipKey(naturalKey);
    const normalizedUser = normalizeUsername(username);
    const members = memberships.get(group) ?? new Set<string>();

    if (isMembershipRemoval(action)) {
      members.delete(normalizedUser);
      memberships.set(group, members);
      record('removeMember', 'membership', naturalKey);
    } else {
      members.add(normalizedUser);
      memberships.set(group, members);
      record('addMember', 'membership', naturalKey);
    }
    return Promise.resolve();
  }

  const client: SeedClient = { probe, readActual, apply };

  return {
    client,
    supportedTypes,
    get calls() {
      return calls;
    },
    entities(): ReadonlyMap<ResourceKey, EntityAttrs> {
      const snapshot = new Map<ResourceKey, EntityAttrs>();
      for (const [key, attrs] of entities) {
        snapshot.set(key, { ...attrs });
      }
      return snapshot;
    },
    memberships(): ReadonlyMap<string, ReadonlySet<string>> {
      const snapshot = new Map<string, ReadonlySet<string>>();
      for (const [group, members] of memberships) {
        snapshot.set(group, new Set(members));
      }
      return snapshot;
    },
  };
}
