/**
 * `composeSeedClient`: builds a {@link SeedClient} from an engine's typed
 * handler map.
 *
 * An adapter supplies a {@link SeedHandlers} map (one {@link ResourceHandler}
 * per supported non-membership {@link ResourceType}, plus an optional
 * {@link MembershipHandler}). This module turns that map into the
 * reconciler-facing {@link SeedClient}: it orchestrates GET-only reads of the
 * requested keys into an {@link ActualState} and dispatches create/update
 * actions to the right handler. The engine's supported resource types are the
 * present handler keys (exposed on the adapter's `SeedSupport`, not here). The
 * handlers own the HTTP I/O; this module only orchestrates and never issues
 * calls itself.
 */

import type {
  ApplyContext,
  MembershipHandler,
  ResourceHandler,
  SeedClient,
  SeedHandlers,
} from './engine-adapter.js';
import type {
  ActualState,
  CreateAction,
  ResourceKey,
  ResourceType,
  SeedResource,
  UpdateAction,
} from '../seeder/types.js';
import { resourceKey } from '../seeder/types.js';

/** Resource types other than `membership`, which has its own handler. */
type NonMembershipType = Exclude<ResourceType, 'membership'>;

/** A decoded membership natural key (`"<group>:<username>"`). */
interface MembershipParts {
  readonly group: string;
  readonly username: string;
}

/**
 * Split a membership natural key into its group and username. The key is
 * `"<group>:<username>"`; group ids never contain a colon, so the first colon
 * is the separator.
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

/**
 * Whether a membership action represents a removal. A removal arrives as an
 * {@link UpdateAction} whose desired attributes carry `member: false`
 * (the reconciler synthesizes `member: true → false`); anything else is an add.
 */
function isMembershipRemoval(action: CreateAction | UpdateAction): boolean {
  const desired = action.resource.desired;
  return (
    typeof desired === 'object' &&
    desired !== null &&
    (desired as Record<string, unknown>).member === false
  );
}

/**
 * Build a {@link SeedClient} from a forum reachability probe and a typed
 * handler map.
 *
 * @param probe - Verifies the forum is reachable (GET only); throws
 *   `ForumUnreachableError` when it is not.
 * @param handlers - The engine's handler map; its present keys define the
 *   engine's supported resource types.
 */
export function composeSeedClient(probe: () => Promise<void>, handlers: SeedHandlers): SeedClient {
  const nonMembershipHandler = (type: NonMembershipType): ResourceHandler | undefined =>
    handlers[type];

  async function readActual(desired: readonly SeedResource[]): Promise<ActualState> {
    // Group the requested natural keys by resource type.
    const keysByType = new Map<NonMembershipType, string[]>();
    const groupKeys = new Set<string>();
    for (const resource of desired) {
      if (resource.type === 'membership') {
        groupKeys.add(parseMembershipKey(resource.naturalKey).group);
        continue;
      }
      const list = keysByType.get(resource.type);
      if (list === undefined) {
        keysByType.set(resource.type, [resource.naturalKey]);
      } else {
        list.push(resource.naturalKey);
      }
    }

    const entities = new Map<ResourceKey, Readonly<Record<string, unknown>>>();
    for (const [type, keys] of keysByType) {
      const handler = nonMembershipHandler(type);
      if (handler === undefined || keys.length === 0) {
        continue;
      }
      const read = await handler.read(keys);
      for (const [naturalKey, attrs] of read) {
        entities.set(resourceKey(type, naturalKey), attrs);
      }
    }

    const memberships = new Map<string, ReadonlySet<string>>();
    const membership = handlers.membership;
    if (membership !== undefined && groupKeys.size > 0) {
      const read = await membership.readMembers([...groupKeys]);
      for (const [group, members] of read) {
        memberships.set(group, members);
      }
    }

    return { entities, memberships };
  }

  async function apply(action: CreateAction | UpdateAction, ctx: ApplyContext): Promise<void> {
    const { type } = action.resource;
    switch (type) {
      case 'membership': {
        const membership = requireMembershipHandler(handlers.membership, type);
        const { group, username } = parseMembershipKey(action.resource.naturalKey);
        if (isMembershipRemoval(action)) {
          await membership.remove(group, username);
        } else {
          await membership.add(group, username);
        }
        return;
      }
      case 'setting':
      case 'group':
      case 'category':
      case 'user':
      case 'trustLevel': {
        const handler = requireResourceHandler(nonMembershipHandler(type), type);
        if (action.kind === 'create') {
          await handler.create(action.resource, ctx);
        } else {
          await handler.update(action.resource, action.diff, ctx);
        }
        return;
      }
      default: {
        const _exhaustive: never = type;
        throw new Error(`unhandled resource type '${String(_exhaustive)}'`);
      }
    }
  }

  return { probe, readActual, apply };
}

/**
 * Assert a non-membership handler is present for the type. The reconciler skips
 * unsupported types, so a missing handler here means a programming error.
 */
function requireResourceHandler(
  handler: ResourceHandler | undefined,
  type: ResourceType,
): ResourceHandler {
  if (handler === undefined) {
    throw new Error(`no seed handler registered for resource type '${type}'`);
  }
  return handler;
}

/** Assert the membership handler is present. */
function requireMembershipHandler(
  handler: MembershipHandler | undefined,
  type: ResourceType,
): MembershipHandler {
  if (handler === undefined) {
    throw new Error(`no seed handler registered for resource type '${type}'`);
  }
  return handler;
}
