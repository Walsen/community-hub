import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { plan } from '../../src/seeder/reconciler.js';
import { RESOURCE_TYPE_ORDER, type ResourceType } from '../../src/seeder/types.js';
import { desiredAndActual } from '../support/seed-arbitraries.js';

/**
 * Property 11: Plans are in dependency order.
 *
 * Validates: Requirements 8.8
 *
 * For any desired spec D and derived actual state A, the actions in
 * {@link plan} are sorted by {@link RESOURCE_TYPE_ORDER} (settings, groups,
 * categories, users, membership, trustLevel) and then by `naturalKey` within a
 * type. The ordering must hold across every action kind (`create`, `update`,
 * `noop`, `skip`) because they all carry a resource.
 *
 * The property walks the plan's actions pairwise and asserts, for each adjacent
 * pair (a, b): the resource-type index is non-decreasing, and when the types
 * are equal the `naturalKey` is non-decreasing. `supportedTypes` covers every
 * type so unsupported-type skips never drop coverage; the ordering invariant
 * holds identically whether an action is a skip or not.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x0d9e20;

/** Index of a resource type within the dependency order. */
const typeIndex = (type: ResourceType): number => RESOURCE_TYPE_ORDER.indexOf(type);

/** Every resource type, so no desired resource is skipped for being unsupported. */
const ALL_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>(RESOURCE_TYPE_ORDER);

describe('Property 11: Plans are in dependency order', () => {
  it('orders actions by resource type then natural key (Req 8.8)', () => {
    fc.assert(
      fc.property(desiredAndActual, ({ spec, actual }) => {
        const result = plan({
          forumId: 'main',
          engineId: 'testengine',
          supportedTypes: ALL_TYPES,
          desired: spec.resources,
          actual,
        });

        const { actions } = result;
        for (let i = 1; i < actions.length; i += 1) {
          const prev = actions[i - 1]!.resource;
          const curr = actions[i]!.resource;

          const prevTypeIndex = typeIndex(prev.type);
          const currTypeIndex = typeIndex(curr.type);

          // Resource type index is non-decreasing across adjacent actions.
          expect(prevTypeIndex).toBeLessThanOrEqual(currTypeIndex);

          // Within the same type, natural keys are non-decreasing.
          if (prevTypeIndex === currTypeIndex) {
            expect(prev.naturalKey <= curr.naturalKey).toBe(true);
          }
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
