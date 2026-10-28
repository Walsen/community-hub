/**
 * Property test for the reconciler's handling of unsupported resource types.
 *
 * Property 10: Unsupported resource types are skipped and reported. Validates
 * Requirements 7.4.
 *
 * Requirement 7.4: when an Engine_Adapter does not support a Seed_Resource type
 * declared for a forum, the Seeder reports the unsupported type and the engine
 * and skips that type. The pure {@link plan} is where this decision is made: a
 * desired resource whose type is not in the engine's `supportedTypes` becomes a
 * `skip` action whose reason names both the type and the engine id, and no
 * create/update/noop is emitted for it.
 *
 * For any (D, A) and any `supportedTypes` subset of {@link RESOURCE_TYPE_ORDER}
 * the test asserts:
 *  - every non-`skip` action is for a supported resource type;
 *  - every desired resource of an unsupported type has exactly one `skip`
 *    action carrying the canonical reason string;
 *  - resources of supported types are never skipped for the unsupported-type
 *    reason.
 *
 * The reconciler also synthesizes membership-removal `update` actions
 * (`member: true → false`) for undeclared members of declared groups. Those are
 * only produced when `membership` is supported (an unsupported `membership`
 * type is skipped before any removal would be synthesized, and such synthesized
 * resources are not part of the declared desired set), so they never violate
 * the property. The test checks the supported-type invariant against the full
 * action list, which includes these synthesized updates.
 *
 * Everything is pure and in-memory: no network, no AWS, no clock, no secret
 * values. fast-check runs with a fixed seed so any counterexample reproduces.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { plan } from '../../src/seeder/reconciler.js';
import { RESOURCE_TYPE_ORDER, type ResourceType } from '../../src/seeder/types.js';
import { desiredAndActual } from '../support/seed-arbitraries.js';

const FORUM_ID = 'main';
const ENGINE_ID = 'testengine';

/** The canonical skip reason the reconciler emits for an unsupported type. */
function unsupportedReason(type: ResourceType): string {
  return `resource type '${type}' is not supported by engine '${ENGINE_ID}'`;
}

/**
 * An arbitrary subset of the six resource types, as a `ReadonlySet`. Ranges
 * over the empty set (nothing supported) through the full set (everything
 * supported), so a single run exercises every supported/unsupported split.
 */
const supportedTypesArb: fc.Arbitrary<ReadonlySet<ResourceType>> = fc
  .subarray([...RESOURCE_TYPE_ORDER])
  .map((types) => new Set<ResourceType>(types));

describe('Property 10: Unsupported resource types are skipped and reported', () => {
  it('skips exactly the unsupported-type resources, naming the type and engine', () => {
    fc.assert(
      fc.property(desiredAndActual, supportedTypesArb, ({ spec, actual }, supportedTypes) => {
        const desired = spec.resources;

        const { actions } = plan({
          forumId: FORUM_ID,
          engineId: ENGINE_ID,
          supportedTypes,
          desired,
          actual,
        });

        // 1. Every non-skip action is for a supported resource type. This also
        //    covers the synthesized membership-removal updates, which only
        //    appear when `membership` is supported.
        for (const action of actions) {
          if (action.kind !== 'skip') {
            expect(supportedTypes.has(action.resource.type)).toBe(true);
          }
        }

        // 2. Every declared resource of an unsupported type has exactly one
        //    skip action carrying the canonical reason; no other action kind is
        //    emitted for it.
        for (const resource of desired) {
          const forResource = actions.filter(
            (a) =>
              a.resource.type === resource.type && a.resource.naturalKey === resource.naturalKey,
          );
          if (!supportedTypes.has(resource.type)) {
            expect(forResource).toHaveLength(1);
            const [only] = forResource;
            expect(only?.kind).toBe('skip');
            if (only?.kind === 'skip') {
              expect(only.reason).toBe(unsupportedReason(resource.type));
            }
          } else {
            // 3. Supported-type resources are never skipped for the
            //    unsupported-type reason.
            for (const action of forResource) {
              if (action.kind === 'skip') {
                expect(action.reason).not.toBe(unsupportedReason(resource.type));
              }
            }
          }
        }

        // No skip action ever targets a supported type with the
        // unsupported-type reason.
        for (const action of actions) {
          if (action.kind === 'skip') {
            expect(supportedTypes.has(action.resource.type)).toBe(false);
          }
        }
      }),
      { seed: 0x5eed, numRuns: 500 },
    );
  });
});
