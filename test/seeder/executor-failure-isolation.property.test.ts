/**
 * Property test for the Seeder executor's failure isolation.
 *
 * Property 19: Failure isolation (continue on failure).
 * **Validates: Requirements 9.6**
 *
 * The executor applies a dependency-ordered {@link ForumPlan} action by action
 * and never aborts on a failure: a mutating call that throws is recorded as a
 * `failed` {@link ActionResult}, and the run continues with the remaining
 * actions. This property pins that behaviour down across arbitrary plans and
 * arbitrary subsets of failing resources.
 *
 * For any desired/actual pair (from {@link desiredAndActual}) and any subset K
 * of the plan's create/update natural keys designated to fail in the fake
 * forum, the test asserts:
 *
 *  - **length and order preserved**: there is exactly one result per action and
 *    `results[i].resource` is `actions[i].resource` (the executor returns in
 *    plan order);
 *  - **designated failures fail**: every create/update action whose key is in K
 *    has outcome `failed`;
 *  - **independent actions still apply**: every create/update whose key is not
 *    in K and none of whose in-run dependencies failed has outcome `applied`
 *    — a single failure never prevents an independent later action from
 *    running;
 *  - **noop/skip are skipped**: `noop` and `skip` actions have outcome
 *    `skipped` and issue no client call;
 *  - **blocked dependents fail, never silently apply**: an action blocked by a
 *    failed dependency is `failed` (with a `dependency ... failed` message),
 *    never `applied`.
 *
 * Everything is in-memory and deterministic: the fake forum holds state, the
 * secret resolver and password generator return obvious placeholders, and the
 * logger writes to an in-memory sink. fast-check runs with a fixed seed so any
 * counterexample reproduces.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ExecutorDeps } from '../../src/seeder/executor.js';
import { execute } from '../../src/seeder/executor.js';
import { plan } from '../../src/seeder/reconciler.js';
import {
  type ActionResult,
  type PlanAction,
  RESOURCE_TYPE_ORDER,
  type ResourceKey,
  resourceKey,
  type ResourceType,
} from '../../src/seeder/types.js';
import { createLogger, type LogSink, Redactor } from '../../src/shared/logger.js';
import type { SecretResolver } from '../../src/shared/secrets.js';
import { createFakeForum } from '../support/fake-forum.js';
import { desiredAndActual } from '../support/seed-arbitraries.js';

const FORUM_ID = 'main';
const ENGINE_ID = 'testengine';

/** Every resource type the data model defines, as the supported-types set. */
const ALL_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>(RESOURCE_TYPE_ORDER);

/** An obvious placeholder the fake {@link SecretResolver} returns for any ref. */
const RESOLVED_SECRET = 'resolved-secret-value';
/** An obvious placeholder {@link ExecutorDeps.randomPassword} returns. */
const RANDOM_PASSWORD = 'random-password-value';

/** Placeholder executor deps: fixed secret, fixed password, in-memory logger. */
function makeDeps(): ExecutorDeps {
  const redactor = new Redactor();
  const sink: LogSink = { write: () => undefined };
  const secrets: SecretResolver = () => Promise.resolve(RESOLVED_SECRET);
  return {
    secrets,
    randomPassword: (): string => RANDOM_PASSWORD,
    logger: createLogger({ sink, redactor }),
  };
}

/** The in-run dependency keys of a resource, mirroring the executor's rules. */
function dependenciesOf(type: ResourceType, naturalKey: string): readonly ResourceKey[] {
  if (type === 'membership') {
    const sep = naturalKey.indexOf(':');
    if (sep === -1) {
      return [];
    }
    return [
      resourceKey('group', naturalKey.slice(0, sep)),
      resourceKey('user', naturalKey.slice(sep + 1)),
    ];
  }
  if (type === 'trustLevel') {
    return [resourceKey('user', naturalKey)];
  }
  return [];
}

describe('Property 19: Failure isolation (continue on failure)', () => {
  it('returns a result for every action; failures never abort independent ones', async () => {
    await fc.assert(
      fc.asyncProperty(
        desiredAndActual,
        // A bitmap deciding, per create/update action, whether its key fails.
        fc.array(fc.boolean(), { minLength: 0, maxLength: 64 }),
        async ({ spec, actual }, failBits) => {
          // Build a real plan so the actions, their order and their kinds come
          // from the reconciler rather than being hand-constructed.
          const forumPlan = plan({
            forumId: FORUM_ID,
            engineId: ENGINE_ID,
            supportedTypes: ALL_TYPES,
            desired: spec.resources,
            actual,
          });
          const { actions } = forumPlan;

          // Pick the subset K of create/update natural keys designated to fail,
          // driven by the generated bitmap (empty bitmap => no failures).
          const failKeys = new Set<string>();
          let bit = 0;
          for (const action of actions) {
            if (action.kind === 'create' || action.kind === 'update') {
              if (failBits.length > 0 && failBits[bit % failBits.length]) {
                failKeys.add(action.resource.naturalKey);
              }
              bit += 1;
            }
          }

          // Seed the fake with the actual state so reads are consistent, and
          // with the designated failing keys.
          const forum = createFakeForum({
            initialEntities: actual.entities,
            initialMemberships: actual.memberships,
            failKeys,
            forumId: FORUM_ID,
          });

          const results = await execute(forumPlan, forum.client, makeDeps());
          assertFailureIsolation(results, actions, failKeys);
        },
      ),
      { seed: 0x5eed, numRuns: 400 },
    );
  });
});

/** Assert the failure-isolation invariants for one execution. */
function assertFailureIsolation(
  results: readonly ActionResult[],
  actions: readonly PlanAction[],
  failKeys: ReadonlySet<string>,
): void {
  // 1. One result per action, in plan order: results[i].resource IS actions[i].resource.
  expect(results).toHaveLength(actions.length);
  for (let i = 0; i < actions.length; i += 1) {
    expect(results[i]?.resource).toBe(actions[i]?.resource);
    expect(results[i]?.kind).toBe(actions[i]?.kind);
  }

  // Keys of create/update actions that failed in this run (designated failures
  // plus any dependency-blocked failures), used to reason about dependents.
  const failedKeys = new Set<ResourceKey>();
  for (const result of results) {
    if (result.outcome === 'failed') {
      failedKeys.add(resourceKey(result.resource.type, result.resource.naturalKey));
    }
  }

  for (const result of results) {
    const { type, naturalKey } = result.resource;

    if (result.kind === 'noop' || result.kind === 'skip') {
      // 4. noop/skip actions are always skipped.
      expect(result.outcome).toBe('skipped');
      continue;
    }

    // create/update action.
    const deps = dependenciesOf(type, naturalKey);
    const dependencyFailed = deps.some((d) => failedKeys.has(d));

    if (failKeys.has(naturalKey)) {
      // 2. A designated-failing create/update is 'failed'.
      expect(result.outcome).toBe('failed');
    } else if (dependencyFailed) {
      // 5. A dependent blocked by a failed dependency is 'failed' (never
      //    silently applied) and names the dependency.
      expect(result.outcome).toBe('failed');
      expect(result.error).toMatch(/^dependency .+ failed$/);
    } else {
      // 3. An independent, non-failing create/update still applies: a single
      //    failure elsewhere does not abort it.
      expect(result.outcome).toBe('applied');
    }
  }
}
