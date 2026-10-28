import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ApplyContext } from '../../src/engines/engine-adapter.js';
import { plan } from '../../src/seeder/reconciler.js';
import {
  type PlanAction,
  type ResourceKey,
  type ResourceType,
  resourceKey,
} from '../../src/seeder/types.js';
import { createFakeForum, type EntityAttrs, type FakeForum } from '../support/fake-forum.js';
import { desiredAndActual } from '../support/seed-arbitraries.js';

/**
 * Property 14: No collateral changes (Core 2).
 *
 * Validates: Requirements 8.10
 *
 * For any desired state D and actual state A, applying `plan(D, A)` to A yields
 * A′ in which every entity of A outside D's managed scope is identical, and no
 * entity is deleted. "Outside D's managed scope" covers:
 *
 *  - settings, groups, categories and users whose natural key is not declared
 *    in D (the `zzz-foreign-*` entities the actual arbitrary injects when
 *    `includeUndeclared` is set);
 *  - members of groups that D does not declare (the `zzz-foreign-group` the
 *    arbitrary injects when `includeForeignGroup` is set);
 *  - attributes present on a declared entity in A that D does not declare —
 *    the plan may update declared fields but must never drop or overwrite an
 *    undeclared attribute.
 *
 * The test drives the in-memory fake forum, which exposes `entities()` and
 * `memberships()` snapshots of the WHOLE state (not just the scoped
 * `readActual`), so collateral changes anywhere are observable. A fixed
 * fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x14c0_11a7;

/**
 * An {@link ApplyContext} for the fake forum. The fake ignores the context when
 * applying entity and membership actions, so these are never invoked; they
 * throw if the production path were ever to reach them.
 */
const applyCtx: ApplyContext = {
  resolveSecret(): Promise<string> {
    throw new Error('resolveSecret must not be called by this property');
  },
  randomPassword(): string {
    throw new Error('randomPassword must not be called by this property');
  },
};

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
 * The natural keys the actual arbitrary injects as undeclared entities when
 * `includeUndeclared` is set, paired with their resource type. These never
 * collide with declared natural keys (declared tokens match `^[a-z][a-z0-9]*$`,
 * so a `zzz-` prefix with hyphens cannot be produced by the generator).
 */
const UNDECLARED_ENTITIES: ReadonlyArray<readonly [ResourceType, string]> = [
  ['setting', 'zzz-foreign-setting'],
  ['category', 'zzz-foreign-category'],
  ['user', 'zzz-foreign-user'],
  ['group', 'zzz-foreign-group'],
];

/** The undeclared group the actual arbitrary injects with a member. */
const FOREIGN_GROUP = 'zzz-foreign-group';

/** Apply every `create`/`update` action of a plan against the fake, in order. */
async function applyMutations(actions: readonly PlanAction[], fake: FakeForum): Promise<void> {
  for (const action of actions) {
    if (action.kind === 'create' || action.kind === 'update') {
      await fake.client.apply(action, applyCtx);
    }
  }
}

/** Shallow structural equality for a pair of entity attribute records. */
function attrsEqual(a: EntityAttrs | undefined, b: EntityAttrs | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (!Object.is(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

describe('Property 14: No collateral changes (Core 2)', () => {
  it('leaves undeclared entities, foreign-group members and undeclared attributes untouched (Req 8.10)', async () => {
    await fc.assert(
      fc.asyncProperty(desiredAndActual, async ({ spec, actual, knobs }) => {
        // Snapshot A before planning.
        const before = createFakeForum({
          supportedTypes: SUPPORTED_TYPES,
          initialEntities: actual.entities,
          initialMemberships: actual.memberships,
        });
        const entitiesBefore = before.entities();
        const membershipsBefore = before.memberships();

        // Compute plan(D, A) and apply it to a fresh fake seeded with the same A.
        const forumPlan = plan({
          forumId: 'fakeforum',
          engineId: 'fake',
          supportedTypes: SUPPORTED_TYPES,
          desired: spec.resources,
          actual,
        });
        const after = createFakeForum({
          supportedTypes: SUPPORTED_TYPES,
          initialEntities: actual.entities,
          initialMemberships: actual.memberships,
        });
        await applyMutations(forumPlan.actions, after);
        const entitiesAfter = after.entities();
        const membershipsAfter = after.memberships();

        // The plan must only touch declared resources. Every create/update
        // targets either a declared resource key or a synthesized membership
        // removal from a DECLARED group — never a foreign/undeclared entity.
        const declaredKeys = new Set<ResourceKey>();
        for (const resource of spec.resources) {
          if (resource.type !== 'membership') {
            declaredKeys.add(resourceKey(resource.type, resource.naturalKey));
          }
        }
        const declaredGroups = new Set<string>(spec.groups);
        for (const action of forumPlan.actions) {
          if (action.kind !== 'create' && action.kind !== 'update') {
            continue;
          }
          const { type, naturalKey } = action.resource;
          if (type === 'membership') {
            const group = naturalKey.slice(0, naturalKey.indexOf(':'));
            expect(declaredGroups.has(group)).toBe(true);
          } else {
            expect(declaredKeys.has(resourceKey(type, naturalKey))).toBe(true);
          }
        }

        // 1. No entity is deleted: every key present in A is present in A′.
        for (const key of entitiesBefore.keys()) {
          expect(entitiesAfter.has(key)).toBe(true);
        }

        // 2. Undeclared entities are byte-for-byte identical in A′.
        if (knobs.includeUndeclared) {
          for (const [type, naturalKey] of UNDECLARED_ENTITIES) {
            const key = resourceKey(type, naturalKey);
            expect(attrsEqual(entitiesAfter.get(key), entitiesBefore.get(key))).toBe(true);
          }
        }

        // 3. The undeclared group's membership set is unchanged.
        if (knobs.includeForeignGroup) {
          const foreignBefore = membershipsBefore.get(FOREIGN_GROUP) ?? new Set<string>();
          const foreignAfter = membershipsAfter.get(FOREIGN_GROUP) ?? new Set<string>();
          expect([...foreignAfter].sort()).toEqual([...foreignBefore].sort());
        }

        // 4. Declared entities present in A keep any attribute D does not
        // declare. The reconciler only diffs declared fields and the fake's
        // update merges, so pre-existing attributes must survive.
        if (knobs.includeDeclared) {
          const declaredDesired = new Map<ResourceKey, Record<string, unknown>>();
          for (const resource of spec.resources) {
            if (resource.type === 'membership') {
              continue;
            }
            if (typeof resource.desired === 'object' && resource.desired !== null) {
              declaredDesired.set(
                resourceKey(resource.type, resource.naturalKey),
                resource.desired as Record<string, unknown>,
              );
            }
          }
          for (const [key, desiredAttrs] of declaredDesired) {
            const beforeAttrs = entitiesBefore.get(key);
            const afterAttrs = entitiesAfter.get(key);
            if (beforeAttrs === undefined || afterAttrs === undefined) {
              continue;
            }
            for (const field of Object.keys(beforeAttrs)) {
              if (field in desiredAttrs) {
                continue; // a declared field may legitimately be updated
              }
              expect(Object.is(afterAttrs[field], beforeAttrs[field])).toBe(true);
            }
          }
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
