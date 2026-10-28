import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  resolveTrustLevelGroup,
  transformDesiredFlarum,
} from '../../../src/engines/flarum/seed-client.js';
import type { ForumModel } from '../../../src/metadata/schema.js';
import type { ResourceType, SeedResource } from '../../../src/seeder/types.js';

/**
 * Property 12: Flarum trust levels map to declared groups.
 *
 * Validates: Requirements 8.6 (Flarum trust-level mapping), 7.1.
 *
 * Exercises the two pure functions the Flarum adapter uses to rewrite declared
 * trust levels into group memberships:
 *
 * - {@link resolveTrustLevelGroup} implements the mapping rule — an exact key
 *   wins, otherwise the greatest declared key less than or equal to the level,
 *   otherwise `undefined`. Property A re-implements that expectation
 *   independently and compares.
 * - {@link transformDesiredFlarum} rewrites each `trustLevel` resource into a
 *   `membership` resource for the mapped group, dropping the resource entirely
 *   when the mapped group is the implicit Member group or the level is
 *   unmapped, and passes every non-`trustLevel` resource through unchanged.
 *   Property B asserts those four outcomes.
 *
 * The forum is a minimal {@link ForumModel} cast carrying only
 * `engineOptions.trustLevelGroups`, which is all {@link transformDesiredFlarum}
 * reads. A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x712c3a;

/** The implicit Member group names (case-insensitive) the transform drops. */
const MEMBER_GROUP_NAMES = ['member', 'members', 'Member', 'Members'] as const;

/** Trust-level keys the Flarum mapping accepts. */
const LEVEL_KEYS = ['0', '1', '2', '3', '4'] as const;
type LevelKey = (typeof LEVEL_KEYS)[number];

/** A non-Member declared group name (safe: never an implicit Member name). */
const groupNameArb: fc.Arbitrary<string> = fc
  .constantFrom('veterans', 'moderators', 'regulars', 'trusted', 'elders')
  .chain((base) => fc.integer({ min: 0, max: 3 }).map((n) => (n === 0 ? base : `${base}${n}`)));

/**
 * An arbitrary `trustLevelGroups` mapping: a subset of the keys 0..4, each
 * mapped either to the implicit Member group or to a non-Member group name.
 */
const mappingArb: fc.Arbitrary<Partial<Record<LevelKey, string>>> = fc
  .subarray([...LEVEL_KEYS], { minLength: 0, maxLength: LEVEL_KEYS.length })
  .chain((keys) =>
    fc
      .tuple(
        ...keys.map((key) =>
          fc
            .oneof(fc.constantFrom(...MEMBER_GROUP_NAMES), groupNameArb)
            .map((group) => [key, group] as const),
        ),
      )
      .map((pairs) => {
        const mapping: Partial<Record<LevelKey, string>> = {};
        for (const [key, group] of pairs) {
          mapping[key] = group;
        }
        return mapping;
      }),
  );

/** A declared user with a username and trust level 0..4. */
interface DesiredUserEntry {
  readonly username: string;
  readonly level: number;
}

/** Distinct usernames so a user's resource key is unambiguous. */
const usersArb: fc.Arbitrary<readonly DesiredUserEntry[]> = fc
  .uniqueArray(
    fc.record({
      username: fc
        .string({ minLength: 1, maxLength: 6 })
        .map((s) => s.replace(/[^a-z0-9]/gi, 'x').toLowerCase())
        .filter((s) => s.length >= 1),
      level: fc.integer({ min: 0, max: 4 }),
    }),
    { selector: (u) => u.username, minLength: 0, maxLength: 6 },
  )
  .map((users) => users);

/** Non-trustLevel passthrough resource types the transform must not touch. */
const PASSTHROUGH_TYPES = ['setting', 'group', 'category', 'user', 'membership'] as const;

/** An arbitrary non-`trustLevel` resource, carried through the transform. */
const passthroughResourceArb: fc.Arbitrary<SeedResource> = fc
  .record({
    type: fc.constantFrom<ResourceType>(...PASSTHROUGH_TYPES),
    naturalKey: fc.string({ minLength: 1, maxLength: 8 }),
    desired: fc.object({ maxDepth: 1 }),
  })
  .map((r) => r as SeedResource);

/** Build a `ForumModel` cast carrying just the trust-level mapping. */
function forumWith(mapping: Partial<Record<LevelKey, string>>): ForumModel {
  return { engineOptions: { trustLevelGroups: mapping } } as unknown as ForumModel;
}

/**
 * Independent re-implementation of the resolution rule: exact key, else the
 * greatest declared numeric key less than or equal to the level, else
 * undefined. Deliberately different structure from the production code.
 */
function expectedGroup(
  mapping: Partial<Record<LevelKey, string>>,
  level: number,
): string | undefined {
  const exact = mapping[String(level) as LevelKey];
  if (exact !== undefined) {
    return exact;
  }
  const candidates = LEVEL_KEYS.map((k) => Number(k))
    .filter((n) => n <= level && mapping[String(n) as LevelKey] !== undefined)
    .sort((a, b) => b - a);
  const top = candidates[0];
  return top === undefined ? undefined : mapping[String(top) as LevelKey];
}

/** True when a mapped group denotes the implicit Member group. */
function isMember(group: string): boolean {
  const g = group.trim().toLowerCase();
  return g === 'member' || g === 'members';
}

describe('Property 12: Flarum trust levels map to declared groups', () => {
  it('A: resolveTrustLevelGroup matches an independent implementation (Req 8.6)', () => {
    fc.assert(
      fc.property(mappingArb, fc.integer({ min: 0, max: 4 }), (mapping, level) => {
        expect(resolveTrustLevelGroup(mapping, level)).toBe(expectedGroup(mapping, level));
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('B: transformDesiredFlarum rewrites trust levels and passes the rest through (Req 8.6, 7.1)', () => {
    fc.assert(
      fc.property(
        mappingArb,
        usersArb,
        fc.array(passthroughResourceArb, { maxLength: 5 }),
        (mapping, users, passthrough) => {
          const trustLevelResources: SeedResource[] = users.map((u) => ({
            type: 'trustLevel',
            naturalKey: u.username,
            desired: { trustLevel: u.level },
          }));
          const input: SeedResource[] = [...passthrough, ...trustLevelResources];

          const output = transformDesiredFlarum(input, forumWith(mapping));

          // No trustLevel resources remain in the output.
          expect(output.some((r) => r.type === 'trustLevel')).toBe(false);

          // Every passthrough resource survives unchanged (by reference).
          for (const resource of passthrough) {
            expect(output).toContain(resource);
          }

          // The membership resources emitted purely by the trust-level rewrite.
          // (Passthrough membership resources are excluded by identity.)
          const passthroughSet = new Set(passthrough);
          const emittedMemberships = output.filter(
            (r) => r.type === 'membership' && !passthroughSet.has(r),
          );

          for (const u of users) {
            const group = expectedGroup(mapping, u.level);
            const expectedKey = group === undefined ? undefined : `${group.trim()}:${u.username}`;

            if (group === undefined || isMember(group)) {
              // Unmapped or implicit Member: no membership emitted for this user.
              const forUser = emittedMemberships.filter((r) =>
                r.naturalKey.endsWith(`:${u.username}`),
              );
              expect(forUser).toHaveLength(0);
            } else {
              const match = emittedMemberships.find((r) => r.naturalKey === expectedKey);
              expect(match).toBeDefined();
              expect(match?.desired).toEqual({ member: true });
            }
          }
        },
      ),
      { seed: SEED, numRuns: 500 },
    );
  });
});
