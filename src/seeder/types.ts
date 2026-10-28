/**
 * Seeder domain types.
 *
 * These are the plain-data types the Seeder reconciler, executor and reporter
 * share, plus the shapes an {@link module:engines/engine-adapter.SeedClient}
 * exchanges with them. They are pure data: no I/O, no AWS or forum calls. The
 * reconciler (`reconciler.ts`) is a pure function over {@link SeedResource}s and
 * an {@link ActualState}; the executor turns a {@link ForumPlan} into
 * {@link ActionResult}s; the reporter folds those into a {@link RunSummary}.
 *
 * See the data-model steering ("Seeder domain types") for the authoritative
 * definitions this module mirrors.
 */

/**
 * The kinds of forum entity the Seeder reconciles. The order of this union is
 * not significant; dependency order is given by {@link RESOURCE_TYPE_ORDER}.
 */
export type ResourceType = 'setting' | 'group' | 'category' | 'user' | 'membership' | 'trustLevel';

/**
 * Dependency order for applying resources: settings first, then groups and
 * categories, then users, then memberships and trust levels (which reference
 * users and groups). Plans are sorted by this order, then by natural key, so
 * execution is deterministic and references exist before they are used.
 */
export const RESOURCE_TYPE_ORDER = [
  'setting',
  'group',
  'category',
  'user',
  'membership',
  'trustLevel',
] as const satisfies readonly ResourceType[];

/**
 * A single declared entity to reconcile, identified within its
 * {@link ResourceType} by a {@link SeedResource.naturalKey | naturalKey}.
 *
 * @typeParam T - The shape of the declared attributes for this resource type.
 */
export interface SeedResource<T = unknown> {
  /** The entity's resource type. */
  readonly type: ResourceType;
  /**
   * The resource's Natural_Key within its type: a setting key, group name,
   * category slug, username, or `"<group>:<username>"` for a membership.
   */
  readonly naturalKey: string;
  /** The normalized declared attributes (declared fields only). */
  readonly desired: T;
}

/**
 * A stringified key identifying a resource for lookup, combining its
 * {@link ResourceType} and Natural_Key as `"<type>:<naturalKey>"`.
 */
export type ResourceKey = `${ResourceType}:${string}`;

/** Builds the {@link ResourceKey} for a resource type and natural key. */
export function resourceKey(type: ResourceType, naturalKey: string): ResourceKey {
  return `${type}:${naturalKey}`;
}

/**
 * A single changed field in an {@link UpdateAction}, produced by the reconciler
 * when a declared attribute differs from the actual value.
 */
export interface FieldDiff {
  /** The name of the changed declared attribute. */
  readonly field: string;
  /** The current (actual) value. */
  readonly from: unknown;
  /** The desired (declared) value. */
  readonly to: unknown;
}

/** Create a resource that does not yet exist. */
export interface CreateAction {
  readonly kind: 'create';
  readonly resource: SeedResource;
}

/** Update an existing resource to match its declaration. */
export interface UpdateAction {
  readonly kind: 'update';
  readonly resource: SeedResource;
  /** The declared attributes that differ from the actual state. */
  readonly diff: FieldDiff[];
}

/** The resource already matches its declaration; nothing to do. */
export interface NoopAction {
  readonly kind: 'noop';
  readonly resource: SeedResource;
}

/** The resource is not applied, e.g. its type is unsupported by the engine. */
export interface SkipAction {
  readonly kind: 'skip';
  readonly resource: SeedResource;
  /** Human-readable reason the resource was skipped. */
  readonly reason: string;
}

/**
 * A planned action for one resource. Discriminated by {@link PlanAction.kind}.
 * There is no delete kind: the Seeder never removes entities. Removing a member
 * from a declared group is an {@link UpdateAction} (`member: true → false`).
 */
export type PlanAction = CreateAction | UpdateAction | NoopAction | SkipAction;

/**
 * The ordered plan for one forum: every declared resource's action, sorted by
 * {@link RESOURCE_TYPE_ORDER} then by {@link SeedResource.naturalKey}.
 */
export interface ForumPlan {
  readonly forumId: string;
  readonly actions: PlanAction[];
}

/**
 * The outcome of executing a single {@link PlanAction}. `applied` means a
 * mutating call succeeded; `failed` carries the error message; `skipped`
 * covers both `noop`/`skip` actions and actions not run.
 */
export type ActionResult = PlanAction & {
  readonly outcome: 'applied' | 'failed' | 'skipped';
  /** Present only when `outcome` is `failed`; a body-free error message. */
  readonly error?: string;
};

/**
 * Per-forum tally of a seeding run. `unreachable` is true when the forum could
 * not be probed, in which case the counts are zero and no actions were applied.
 */
export interface RunSummary {
  readonly forumId: string;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unreachable: boolean;
}

/**
 * The actual forum state the reconciler compares the desired resources against.
 * A {@link module:engines/engine-adapter.SeedClient} populates this by reading
 * only the keys and declared groups it was asked about; entities and groups not
 * requested are absent and therefore never managed.
 */
export interface ActualState {
  /**
   * Normalized attributes of existing entities, keyed by {@link ResourceKey},
   * for the keys requested by `readActual` only.
   */
  readonly entities: ReadonlyMap<ResourceKey, Readonly<Record<string, unknown>>>;
  /** Current members of each declared group only, keyed by group name. */
  readonly memberships: ReadonlyMap<string, ReadonlySet<string>>;
}
