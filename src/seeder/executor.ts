/**
 * The Seeder executor.
 *
 * {@link execute} turns a dependency-ordered {@link ForumPlan} into
 * {@link ActionResult}s by applying each action against one forum's
 * {@link SeedClient}. It is the "how" half of the "read → pure `plan()` →
 * `execute()`" design: the reconciler decides what should change, the executor
 * performs the mutating calls.
 *
 * Execution is linear and continue-on-failure (Req 9.6): a single action
 * failing never aborts the run. `noop` and `skip` actions are recorded as
 * `skipped` without any client call; `create`/`update` actions call
 * {@link SeedClient.apply}. A `create`/`update` whose in-run dependency failed
 * is recorded as `failed` without a call, so a failed group or user does not
 * silently drop its memberships or trust-level mappings.
 *
 * The only I/O here is the client call and logging; secret resolution and
 * random password generation are injected and reach the client through the
 * {@link module:engines/engine-adapter.ApplyContext}. Secret values, request
 * bodies and response bodies are never logged (Req 9.5): only the forum id,
 * resource type, natural key, and body-free error message.
 */

import type { ApplyContext, SeedClient } from '../engines/engine-adapter.js';
import type { Logger } from '../shared/logger.js';
import type { SecretResolver } from '../shared/secrets.js';
import {
  type ActionResult,
  type CreateAction,
  type ForumPlan,
  type PlanAction,
  type ResourceKey,
  type ResourceType,
  resourceKey,
  type UpdateAction,
} from './types.js';

/** Injected dependencies for {@link execute}. */
export interface ExecutorDeps {
  /** Resolves a Secret_Reference to its value, at the edge, just in time. */
  readonly secrets: SecretResolver;
  /** Generates a fresh random password for a user with no declared one. */
  readonly randomPassword: () => string;
  /** Redacting logger; never receives secret values or request/response bodies. */
  readonly logger: Logger;
}

/** A `create` or `update` action: the only kinds that issue a mutating call. */
type MutatingAction = CreateAction | UpdateAction;

/**
 * Apply a forum's plan in order and return one {@link ActionResult} per action.
 *
 * Actions are processed in the plan's existing order (sorted by
 * `RESOURCE_TYPE_ORDER` then natural key), so every dependency is seen before
 * its dependents. For each action:
 *
 * - `noop` and `skip` become `skipped` with no client call.
 * - `create`/`update` whose in-run dependency failed become `failed` with
 *   `dependency <type>:<key> failed`, with no client call.
 * - other `create`/`update` call {@link SeedClient.apply}; success is
 *   `applied`, a thrown value is `failed` carrying its body-free message.
 *
 * Execution always continues after a failure (Req 9.6).
 *
 * @param plan - The dependency-ordered plan for one forum.
 * @param client - The engine seed client bound to that forum.
 * @param deps - Injected secret resolver, password generator and logger.
 * @returns The results in plan order, one per action.
 */
export async function execute(
  plan: ForumPlan,
  client: SeedClient,
  deps: ExecutorDeps,
): Promise<ActionResult[]> {
  const { forumId } = plan;
  const ctx: ApplyContext = {
    resolveSecret: (ref) => deps.secrets(ref),
    randomPassword: () => deps.randomPassword(),
  };

  const results: ActionResult[] = [];
  const failed = new Set<ResourceKey>();

  for (const action of plan.actions) {
    const result = await executeAction(action, client, ctx, deps, forumId, failed);
    if (result.outcome === 'failed') {
      failed.add(resourceKey(action.resource.type, action.resource.naturalKey));
    }
    results.push(result);
  }

  return results;
}

/** Execute a single action, honouring in-run dependency failures. */
async function executeAction(
  action: PlanAction,
  client: SeedClient,
  ctx: ApplyContext,
  deps: ExecutorDeps,
  forumId: string,
  failed: ReadonlySet<ResourceKey>,
): Promise<ActionResult> {
  const { type, naturalKey } = action.resource;

  if (action.kind === 'noop' || action.kind === 'skip') {
    return { ...action, outcome: 'skipped' };
  }

  const blockedBy = blockingDependency(action, failed);
  if (blockedBy !== undefined) {
    const error = `dependency ${blockedBy} failed`;
    deps.logger.warn('seed action skipped: dependency failed', {
      forumId,
      resourceType: type,
      naturalKey,
      dependency: blockedBy,
    });
    return { ...action, outcome: 'failed', error };
  }

  try {
    await client.apply(action, ctx);
    deps.logger.info('seed action applied', {
      forumId,
      resourceType: type,
      naturalKey,
      kind: action.kind,
    });
    return { ...action, outcome: 'applied' };
  } catch (error) {
    const message = errorMessage(error);
    deps.logger.error('seed action failed', {
      forumId,
      resourceType: type,
      naturalKey,
      kind: action.kind,
      error: message,
    });
    return { ...action, outcome: 'failed', error: message };
  }
}

/**
 * The first in-run failed dependency of a `create`/`update` action, or
 * `undefined` when none. A `membership "<group>:<username>"` depends on
 * `group:<group>` and `user:<username>`; a `trustLevel:<username>` depends on
 * `user:<username>`. Other resource types have no dependencies.
 */
function blockingDependency(
  action: MutatingAction,
  failed: ReadonlySet<ResourceKey>,
): ResourceKey | undefined {
  for (const dependency of dependenciesOf(action.resource.type, action.resource.naturalKey)) {
    if (failed.has(dependency)) {
      return dependency;
    }
  }
  return undefined;
}

/** The resource keys a resource depends on, in check order. */
function dependenciesOf(type: ResourceType, naturalKey: string): readonly ResourceKey[] {
  switch (type) {
    case 'membership': {
      // Natural key is "<group>:<username>"; split on the first colon only so a
      // username containing a colon is preserved.
      const separator = naturalKey.indexOf(':');
      if (separator === -1) {
        return [];
      }
      const group = naturalKey.slice(0, separator);
      const username = naturalKey.slice(separator + 1);
      return [resourceKey('group', group), resourceKey('user', username)];
    }
    case 'trustLevel':
      return [resourceKey('user', naturalKey)];
    case 'setting':
    case 'group':
    case 'category':
    case 'user':
      return [];
    default: {
      const exhaustive: never = type;
      return exhaustive;
    }
  }
}

/** A body-free message for a thrown value, guarding against non-`Error` throws. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : String(error);
}
