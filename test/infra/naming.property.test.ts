import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { constructIds, names } from '../../src/infra/naming.js';
import { environmentName, forumId } from '../support/arbitraries.js';

/**
 * Property 8: Names are deterministic and injective across Environments.
 *
 * Validates: Requirements 3.5, 3.6, 12.12
 *
 * `names` and `constructIds` in `src/infra/naming.ts` derive every resource
 * name purely from the Environment name and forum id. This test pins the three
 * guarantees the infrastructure layer depends on:
 *
 *  - Determinism (Req 3.5): calling a name function twice with the same inputs
 *    returns an identical string.
 *  - Injectivity across (env, forumId) (Req 3.6): because forum ids are
 *    hyphen-free and each resource uses a fixed suffix, `${env}-${forumId}-<x>`
 *    decodes uniquely, so two DIFFERENT (env, forumId) pairs never collide.
 *  - IAM length bounds (Req 3.5): the node role name stays ≤ 59 chars and the
 *    SES user name ≤ 57 chars even for maximum-length inputs.
 *  - Construct-id stability (Req 12.12): `constructIds.forum` is a pure function
 *    of the forum id alone — it never encodes the Environment or another forum.
 *
 * A fixed fast-check seed keeps any counterexample reproducible.
 */

const SEED = 0x8a3117;

/** Lowercase alphanumerics, the character class forum ids and env names share. */
const LOWER_ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LOWER_ALPHA = 'abcdefghijklmnopqrstuvwxyz';

const charFrom = (chars: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: chars.length - 1 }).map((i) => chars[i]!);

const stringFrom = (chars: string, minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(charFrom(chars), { minLength, maxLength }).map((cs) => cs.join(''));

/**
 * A maximum-length environment name (32 chars), matching
 * `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`: head + 30 internal + tail.
 */
const maxEnvironmentName: fc.Arbitrary<string> = fc
  .tuple(charFrom(LOWER_ALNUM), stringFrom(`${LOWER_ALNUM}-`, 30, 30), charFrom(LOWER_ALNUM))
  .map(([head, mid, tail]) => `${head}${mid}${tail}`);

/**
 * A maximum-length forum id (20 chars), matching `^[a-z][a-z0-9]{0,19}$`:
 * a leading letter followed by 19 alphanumerics.
 */
const maxForumId: fc.Arbitrary<string> = fc
  .tuple(charFrom(LOWER_ALPHA), stringFrom(LOWER_ALNUM, 19, 19))
  .map(([head, tail]) => `${head}${tail}`);

/**
 * Every single-forum resource name keyed by (env, forumId). These are the
 * functions whose injectivity across Environments the property asserts; the
 * fixed extra arguments (snapshot utc, counter, access key) are held constant
 * so only (env, forumId) varies.
 */
const perForumNameFns: Record<string, (env: string, forum: string) => string> = {
  instance: names.instance,
  staticIp: names.staticIp,
  nodeRole: names.nodeRole,
  activationName: names.activationName,
  sesUser: names.sesUser,
  finalSnapshot: (env, forum) => names.finalSnapshot(env, forum, '0600'),
  sesParameterPassword: (env, forum) => names.sesParameter(env, forum, 'password'),
  sesParameterUsername: (env, forum) => names.sesParameter(env, forum, 'username'),
  sesCredentialsPhysicalId: (env, forum) =>
    names.sesCredentialsPhysicalId(env, forum, 0, 'AKIAEXAMPLE'),
};

describe('Property 8: Names are deterministic and injective across Environments', () => {
  it('returns identical strings for identical inputs (determinism, Req 3.5)', () => {
    fc.assert(
      fc.property(environmentName, forumId, (env, forum) => {
        for (const fn of Object.values(perForumNameFns)) {
          expect(fn(env, forum)).toBe(fn(env, forum));
        }
        // Environment-only names are deterministic too.
        expect(names.stack(env)).toBe(names.stack(env));
        expect(names.broker(env)).toBe(names.broker(env));
        expect(names.configurationSet(env)).toBe(names.configurationSet(env));
        expect(names.emailTopic(env)).toBe(names.emailTopic(env));
        expect(names.sesUserPath(env)).toBe(names.sesUserPath(env));
        // Construct ids are deterministic.
        expect(constructIds.forum(forum)).toBe(constructIds.forum(forum));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('maps distinct (env, forumId) pairs to distinct names (injectivity, Req 3.6)', () => {
    const pair = fc.tuple(environmentName, forumId);
    fc.assert(
      fc.property(pair, pair, ([env1, forum1], [env2, forum2]) => {
        // Only exercise the injective direction: distinct inputs.
        fc.pre(env1 !== env2 || forum1 !== forum2);

        for (const fn of Object.values(perForumNameFns)) {
          expect(fn(env1, forum1)).not.toBe(fn(env2, forum2));
        }
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('decodes names.instance uniquely back to its (env, forumId) pair (Req 3.6)', () => {
    const pair = fc.tuple(environmentName, forumId);
    fc.assert(
      fc.property(pair, pair, ([env1, forum1], [env2, forum2]) => {
        // Equal names imply equal inputs: the hyphen-free forum id plus the
        // fixed `-instance` suffix make `${env}-${forumId}-instance` injective.
        if (names.instance(env1, forum1) === names.instance(env2, forum2)) {
          expect(env1).toBe(env2);
          expect(forum1).toBe(forum2);
        }
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('keeps IAM role and user names within their length bounds (Req 3.5)', () => {
    fc.assert(
      fc.property(maxEnvironmentName, maxForumId, (env, forum) => {
        expect(env.length).toBe(32);
        expect(forum.length).toBe(20);
        expect(names.nodeRole(env, forum).length).toBeLessThanOrEqual(59);
        expect(names.sesUser(env, forum).length).toBeLessThanOrEqual(57);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('derives constructIds.forum purely from the forum id (stability, Req 12.12)', () => {
    // Pure function of forumId: the construct id depends on the forum id alone,
    // so it is unchanged whatever Environment it is used in. Comparing the
    // results for two arbitrary Environments pins that the env is never encoded.
    fc.assert(
      fc.property(environmentName, environmentName, forumId, (_env1, _env2, forum) => {
        const id = constructIds.forum(forum);
        expect(constructIds.forum(forum)).toBe(id);
        expect(id).toBe(`Forum-${forum}`);
      }),
      { seed: SEED, numRuns: 300 },
    );

    // Distinct forum ids yield distinct construct ids.
    fc.assert(
      fc.property(forumId, forumId, (a, b) => {
        fc.pre(a !== b);
        expect(constructIds.forum(a)).not.toBe(constructIds.forum(b));
      }),
      { seed: SEED, numRuns: 300 },
    );
  });
});
