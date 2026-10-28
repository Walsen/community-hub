/**
 * Property test for the reconciler's idempotency (Core property 1).
 *
 * Property 13: Idempotency (Core 1). Validates Requirements 9.1, 9.2.
 *
 * For any desired state D and actual state A: applying `plan(D, A)` to A gives
 * A', and `plan(D, A')` contains only no-op actions for declared resources.
 * This is the convergence guarantee that a second seeding run performs zero
 * mutations (Req 9.1), because the reconciler compares by Natural_Key only
 * (Req 9.2).
 *
 * The test drives the pure {@link plan} against an in-memory fake forum
 * (`createFakeForum`): it applies the first plan's create/update actions to the
 * fake (noop/skip apply nothing), reads the resulting state back through the
 * client, re-plans against it, and asserts the second plan issues no mutating
 * actions. Everything is in-memory and deterministic — no network, no AWS, no
 * real timers — and the {@link ApplyContext} returns obvious placeholders, so
 * no secret value is involved. fast-check runs with a fixed seed so any
 * counterexample is reproducible.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ApplyContext } from '../../src/engines/engine-adapter.js';
import { plan } from '../../src/seeder/reconciler.js';
import type {
  CreateAction,
  PlanAction,
  ResourceKey,
  UpdateAction,
} from '../../src/seeder/types.js';
import { createFakeForum, type EntityAttrs } from '../support/fake-forum.js';
import { desiredAndActual } from '../support/seed-arbitraries.js';

const FORUM_ID = 'main';
const ENGINE_ID = 'testengine';

/**
 * A trivial {@link ApplyContext}: resolving a secret yields an obvious
 * placeholder and `randomPassword` is a fixed placeholder. No real secret value
 * ever appears.
 */
const APPLY_CONTEXT: ApplyContext = {
  resolveSecret(): Promise<string> {
    return Promise.resolve('test-secret-value');
  },
  randomPassword(): string {
    return 'test-random-password';
  },
};

/** Whether an action mutates state (create or update). */
function isMutating(action: PlanAction): action is CreateAction | UpdateAction {
  return action.kind === 'create' || action.kind === 'update';
}

describe('Property 13: Idempotency (Core 1)', () => {
  it('a second plan after applying the first contains only no-op/skip actions', async () => {
    await fc.assert(
      fc.asyncProperty(desiredAndActual, async ({ spec, actual }) => {
        const desired = spec.resources;

        // Seed the fake forum with the generated actual state A.
        const initialEntities = new Map<ResourceKey, EntityAttrs>(
          [...actual.entities].map(([key, attrs]) => [key, { ...attrs }]),
        );
        const fake = createFakeForum({
          initialEntities,
          initialMemberships: actual.memberships,
        });

        // First plan against A.
        const plan1 = plan({
          forumId: FORUM_ID,
          engineId: ENGINE_ID,
          supportedTypes: fake.supportedTypes,
          desired,
          actual,
        });

        // Apply plan1 to the fake: only create/update actions issue calls.
        for (const action of plan1.actions) {
          if (isMutating(action)) {
            await fake.client.apply(action, APPLY_CONTEXT);
          }
        }

        // Read A' back through the client and re-plan against it.
        const actualPrime = await fake.client.readActual(desired);
        const plan2 = plan({
          forumId: FORUM_ID,
          engineId: ENGINE_ID,
          supportedTypes: fake.supportedTypes,
          desired,
          actual: actualPrime,
        });

        // Idempotency: the second run performs zero mutations.
        const mutating = plan2.actions.filter(isMutating);
        expect(mutating).toEqual([]);
      }),
      { seed: 0x5eed, numRuns: 500 },
    );
  });
});
