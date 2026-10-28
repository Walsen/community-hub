/**
 * Property test for the reconciler's convergence (Core property 3).
 *
 * Property 15: Convergence (Core 3). Validates Requirements 8.1, 8.2, 8.3,
 * 8.4, 8.5, 8.7.
 *
 * Statement (testing steering, Core 3): every declared entity in A′ matches its
 * declaration by Natural_Key. That is, after applying `plan(D, A)` to A, each
 * declared resource's actual state equals its desired, declared (non-write-only)
 * attributes. This is the guarantee that one seeding run converges the forum to
 * the declared state:
 *
 *  - declared settings are set to their value (Req 8.7);
 *  - declared groups exist with their declared attributes (Req 8.4);
 *  - declared categories exist and match by slug (Req 8.2);
 *  - declared users exist and match by username (Req 8.3);
 *  - declared trust levels are assigned (Req 8.5);
 *  - declared group memberships are present (Req 8.4),
 *
 * all applied through one plan (Req 8.1).
 *
 * The test ranges `desiredAndActual` over the knobs so a single run mixes
 * entities that are absent (plan `create`), present-but-different (plan
 * `update`) and already-equal (plan `noop`). It seeds an in-memory fake forum
 * with A, applies every `create`/`update` action (`noop`/`skip` apply nothing)
 * through a trivial {@link ApplyContext} with placeholder secret helpers, then
 * reads the WHOLE resulting state through the fake's `entities()` and
 * `memberships()` snapshots and asserts every declared resource converged.
 * Everything is in-memory and deterministic — no network, no AWS, no real
 * timers — and no secret value is involved. A fixed fast-check seed keeps any
 * counterexample reproducible.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ApplyContext } from '../../src/engines/engine-adapter.js';
import { WRITE_ONLY_FIELDS } from '../../src/seeder/desired.js';
import { plan } from '../../src/seeder/reconciler.js';
import { type PlanAction, type ResourceType, resourceKey } from '../../src/seeder/types.js';
import { createFakeForum, type EntityAttrs, type FakeForum } from '../support/fake-forum.js';
import { desiredAndActual } from '../support/seed-arbitraries.js';

const SEED = 0x0c0f_fee3;

const FORUM_ID = 'fakeforum';
const ENGINE_ID = 'fake';

/** Every resource type the fake supports, so nothing is skipped as unsupported. */
const SUPPORTED_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'setting',
  'group',
  'category',
  'user',
  'membership',
  'trustLevel',
]);

/**
 * A trivial {@link ApplyContext}: resolving a secret yields an obvious
 * placeholder and `randomPassword` is a fixed placeholder. No real secret value
 * ever appears. The fake ignores the context for entity/membership actions, so
 * these are effectively unused, but a convergence run never resolves secrets.
 */
const APPLY_CONTEXT: ApplyContext = {
  resolveSecret(): Promise<string> {
    return Promise.resolve('test-secret-value');
  },
  randomPassword(): string {
    return 'test-random-password';
  },
};

/** Apply every `create`/`update` action of a plan against the fake, in order. */
async function applyMutations(actions: readonly PlanAction[], fake: FakeForum): Promise<void> {
  for (const action of actions) {
    if (action.kind === 'create' || action.kind === 'update') {
      await fake.client.apply(action, APPLY_CONTEXT);
    }
  }
}

describe('Property 15: Convergence (Core 3)', () => {
  it('every declared entity in A′ matches its declaration by Natural_Key (Req 8.1-8.5, 8.7)', async () => {
    await fc.assert(
      fc.asyncProperty(desiredAndActual, async ({ spec, actual }) => {
        // Seed the fake forum with the generated actual state A.
        const fake = createFakeForum({
          supportedTypes: SUPPORTED_TYPES,
          initialEntities: actual.entities,
          initialMemberships: actual.memberships,
        });

        // Compute plan(D, A) and apply all create/update actions to A.
        const forumPlan = plan({
          forumId: FORUM_ID,
          engineId: ENGINE_ID,
          supportedTypes: SUPPORTED_TYPES,
          desired: spec.resources,
          actual,
        });
        await applyMutations(forumPlan.actions, fake);

        // Read the full resulting state A′.
        const entities = fake.entities();
        const memberships = fake.memberships();

        // Assert convergence for every declared resource.
        for (const resource of spec.resources) {
          if (resource.type === 'membership') {
            // Declared memberships are member:true; the user must be present in
            // the group's membership set after the run (Req 8.4).
            const sep = resource.naturalKey.indexOf(':');
            const group = resource.naturalKey.slice(0, sep);
            const username = resource.naturalKey.slice(sep + 1);
            const members = memberships.get(group) ?? new Set<string>();
            expect(members.has(username)).toBe(true);
            continue;
          }

          // setting/group/category/user/trustLevel: the entity must exist and
          // each DECLARED, non-write-only field must equal the desired value.
          const key = resourceKey(resource.type, resource.naturalKey);
          const actualAttrs: EntityAttrs | undefined = entities.get(key);
          expect(actualAttrs).toBeDefined();

          const desired = resource.desired as Record<string, unknown>;
          for (const [field, value] of Object.entries(desired)) {
            if (WRITE_ONLY_FIELDS.has(field)) {
              continue; // write-only fields are never read back, so never checked
            }
            expect(Object.is(actualAttrs![field], value)).toBe(true);
          }
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
