/**
 * The pure Seeder reconciler.
 *
 * {@link plan} compares a forum's desired-state resources (from
 * {@link module:seeder/desired.buildDesired}, already run through the adapter's
 * `transformDesired`) against the {@link ActualState} a seed client read back,
 * and produces an ordered {@link ForumPlan}. It is the heart of the "Reconcile:
 * read → pure `plan()` → `execute()`" design: deciding *what* should change,
 * while the executor decides *how*.
 *
 * This module is pure: no I/O, no clock, no randomness, no AWS or forum calls.
 * It only reads its inputs and returns plain data, so it is fully deterministic
 * and property-testable.
 *
 * Invariants it upholds (data-model steering "Comparison semantics"):
 * - Match by Natural_Key only; compare only declared, non-write-only fields.
 * - Never emit a delete: there is no delete action. Removing a member from a
 *   declared group is an `update` (`member: true → false`).
 * - No collateral changes: attributes present in the actual state but not
 *   declared are never diffed and never cause an update.
 * - Membership of declared groups is authoritative; undeclared groups are never
 *   read or touched.
 */

import { WRITE_ONLY_FIELDS } from './desired.js';
import {
  type ActualState,
  type FieldDiff,
  type ForumPlan,
  type PlanAction,
  RESOURCE_TYPE_ORDER,
  type ResourceType,
  resourceKey,
  type SeedResource,
} from './types.js';

/** Input to {@link plan}. */
export interface PlanInput {
  /** The forum this plan is for; copied onto the returned {@link ForumPlan}. */
  readonly forumId: string;
  /** The engine id, used only in skip reasons for unsupported resource types. */
  readonly engineId: string;
  /** The resource types this engine's seed client can apply. */
  readonly supportedTypes: ReadonlySet<ResourceType>;
  /** The desired resources, already normalized and engine-transformed. */
  readonly desired: readonly SeedResource[];
  /** The actual forum state read back for the requested keys and groups. */
  readonly actual: ActualState;
}

/**
 * Computes an ordered {@link ForumPlan} for a single forum (pure).
 *
 * The returned actions are sorted by {@link RESOURCE_TYPE_ORDER} then by
 * Natural_Key, so execution is deterministic and references (groups, users)
 * are applied before the memberships and trust levels that depend on them.
 *
 * @param input - The forum id, engine id, supported types, desired resources
 *   and actual state. See {@link PlanInput}.
 * @returns The ordered plan: one action per desired resource, plus synthesized
 *   `update` actions that remove undeclared members from declared groups.
 */
export function plan(input: PlanInput): ForumPlan {
  const { forumId, engineId, supportedTypes, desired, actual } = input;

  const declaredGroups = collectDeclaredGroups(desired);
  const actions: PlanAction[] = [];

  for (const resource of desired) {
    if (!supportedTypes.has(resource.type)) {
      actions.push({
        kind: 'skip',
        resource,
        reason: `resource type '${resource.type}' is not supported by engine '${engineId}'`,
      });
      continue;
    }

    if (resource.type === 'membership') {
      actions.push(planDeclaredMembership(resource, actual));
    } else {
      actions.push(planEntity(resource, actual));
    }
  }

  if (supportedTypes.has('membership')) {
    actions.push(...planMembershipRemovals(desired, declaredGroups, actual));
  }

  actions.sort(compareActions);
  return { forumId, actions };
}

/**
 * Collects the set of declared group names. A group is "declared" — and thus
 * authoritative, so its undeclared members must be removed — if it appears as a
 * `group` resource or as the group part of any desired `membership`. This means
 * a group declared with zero members is still authoritative.
 */
function collectDeclaredGroups(desired: readonly SeedResource[]): Set<string> {
  const groups = new Set<string>();
  for (const resource of desired) {
    if (resource.type === 'group') {
      groups.add(resource.naturalKey);
    } else if (resource.type === 'membership') {
      groups.add(parseMembershipKey(resource.naturalKey).group);
    }
  }
  return groups;
}

/** Plans a non-membership resource: create, noop or update by Natural_Key. */
function planEntity(resource: SeedResource, actual: ActualState): PlanAction {
  const existing = actual.entities.get(resourceKey(resource.type, resource.naturalKey));
  if (existing === undefined) {
    return { kind: 'create', resource };
  }

  const diff = diffDeclaredFields(resource.desired, existing);
  if (diff.length === 0) {
    return { kind: 'noop', resource };
  }
  return { kind: 'update', resource, diff };
}

/**
 * Plans a declared membership. The user is in the group already → `noop`;
 * otherwise → `create`. Group membership lookup uses the same (trimmed) group
 * key {@link module:seeder/desired.buildDesired} emits.
 */
function planDeclaredMembership(resource: SeedResource, actual: ActualState): PlanAction {
  const { group, username } = parseMembershipKey(resource.naturalKey);
  const members = actual.memberships.get(group);
  if (members !== undefined && members.has(username)) {
    return { kind: 'noop', resource };
  }
  return { kind: 'create', resource };
}

/**
 * Synthesizes `update` actions (`member: true → false`) for every actual member
 * of a declared group that is not declared as a member. Membership of declared
 * groups is authoritative; undeclared groups are never inspected. There is no
 * delete action — removal is modelled as this update.
 */
function planMembershipRemovals(
  desired: readonly SeedResource[],
  declaredGroups: ReadonlySet<string>,
  actual: ActualState,
): PlanAction[] {
  const declaredMembers = new Set<string>();
  for (const resource of desired) {
    if (resource.type === 'membership') {
      declaredMembers.add(resource.naturalKey);
    }
  }

  const removals: PlanAction[] = [];
  for (const group of declaredGroups) {
    const members = actual.memberships.get(group);
    if (members === undefined) {
      continue;
    }
    for (const username of members) {
      const naturalKey = `${group}:${username}`;
      if (declaredMembers.has(naturalKey)) {
        continue;
      }
      const resource: SeedResource = {
        type: 'membership',
        naturalKey,
        desired: { member: false },
      };
      const diff: FieldDiff[] = [{ field: 'member', from: true, to: false }];
      removals.push({ kind: 'update', resource, diff });
    }
  }
  return removals;
}

/**
 * Diffs only the declared, non-write-only fields of `desired` against the
 * actual attributes, using deep equality. Attributes present in `actual` but
 * not declared are ignored (no collateral changes). Returns one
 * {@link FieldDiff} per field whose declared value differs from the actual one.
 */
function diffDeclaredFields(
  desired: unknown,
  actual: Readonly<Record<string, unknown>>,
): FieldDiff[] {
  const diff: FieldDiff[] = [];
  if (!isRecord(desired)) {
    return diff;
  }

  for (const [field, to] of Object.entries(desired)) {
    if (WRITE_ONLY_FIELDS.has(field)) {
      continue;
    }
    const from = actual[field];
    if (!deepEqual(from, to)) {
      diff.push({ field, from, to });
    }
  }
  return diff;
}

/** Parses a `"<group>:<username>"` membership Natural_Key into its parts. */
function parseMembershipKey(naturalKey: string): { group: string; username: string } {
  const separator = naturalKey.indexOf(':');
  if (separator === -1) {
    return { group: naturalKey, username: '' };
  }
  return {
    group: naturalKey.slice(0, separator),
    username: naturalKey.slice(separator + 1),
  };
}

/** Orders actions by {@link RESOURCE_TYPE_ORDER} then by Natural_Key. */
function compareActions(a: PlanAction, b: PlanAction): number {
  const typeDelta =
    RESOURCE_TYPE_ORDER.indexOf(a.resource.type) - RESOURCE_TYPE_ORDER.indexOf(b.resource.type);
  if (typeDelta !== 0) {
    return typeDelta;
  }
  if (a.resource.naturalKey < b.resource.naturalKey) {
    return -1;
  }
  if (a.resource.naturalKey > b.resource.naturalKey) {
    return 1;
  }
  return 0;
}

/** True when `value` is a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural deep equality for plain JSON-shaped values (primitives, arrays and
 * plain objects). Arrays compare element-wise in order; objects compare by the
 * union of their keys. Used to decide whether a declared field matches actual.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b) {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((element, index) => deepEqual(element, b[index]));
  }

  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      if (!deepEqual(a[key], b[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}
