/**
 * fast-check arbitraries for seeder reconciler and executor testing.
 *
 * Where {@link module:test/support/arbitraries} generates whole metadata
 * documents, this module generates the seeder's internal shapes directly: a
 * desired list of {@link SeedResource}s with internally consistent natural keys
 * (every membership references a declared group and a declared user), and an
 * {@link ActualState} to reconcile against. The actual state deliberately
 * includes entities that are not declared and extra members of declared groups
 * (members the desired set does not mention), so the core properties can be
 * exercised:
 *
 *  - **no collateral changes**: undeclared actual entities must survive a plan;
 *  - **membership authority**: extra members of a declared group must be
 *    reconciled away (removed), while members of undeclared groups are untouched;
 *  - **convergence** and **idempotency**: a matching actual state must plan to
 *    no-ops.
 *
 * Values are normalized the same way {@link module:seeder/desired} normalizes
 * declared config (slugs, usernames and emails lowercased, colours uppercased),
 * so generated desired and actual sides compare the way the reconciler compares
 * them. Generators are deterministic and use only obvious placeholder values;
 * no secret value ever appears.
 */

import fc from 'fast-check';

import {
  normalizeColor,
  normalizeEmail,
  normalizeSlug,
  normalizeUsername,
  trimString,
} from '../../src/seeder/normalize.js';
import type { ActualState, ResourceKey, SeedResource } from '../../src/seeder/types.js';
import { resourceKey } from '../../src/seeder/types.js';

/** A lowercase letter, for building identifier-like placeholders. */
const LOWER_ALPHA = 'abcdefghijklmnopqrstuvwxyz';
/** Hex digits for placeholder colours. */
const HEX = '0123456789ABCDEF';

const charFrom = (chars: string): fc.Arbitrary<string> =>
  fc.integer({ min: 0, max: chars.length - 1 }).map((i) => chars[i]!);

const stringFrom = (chars: string, minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(charFrom(chars), { minLength, maxLength }).map((cs) => cs.join(''));

/** An identifier-like placeholder token (`^[a-z][a-z0-9]{0,n}$`-ish). */
const token = (maxExtra = 7): fc.Arbitrary<string> =>
  fc
    .tuple(charFrom(LOWER_ALPHA), stringFrom(`${LOWER_ALPHA}0123456789`, 0, maxExtra))
    .map(([head, tail]) => `${head}${tail}`);

/** A placeholder six-digit hex colour (no leading `#`, already uppercase). */
const colorValue: fc.Arbitrary<string> = stringFrom(HEX, 6, 6);

/** A placeholder email `<local>@example.org`. */
const emailValue: fc.Arbitrary<string> = token().map((local) => `${local}@example.org`);

/** A setting scalar value: string, integer or boolean (what the schema allows). */
const settingValue: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.integer(),
  fc.boolean(),
);

/**
 * A declared desired state: a set of settings, groups, categories, users and
 * the memberships between them. Every natural key is unique within its type and
 * every membership references a group and a user that are declared here.
 */
export interface DesiredSpec {
  /** The ordered desired resources (settings → groups → categories → users → memberships). */
  readonly resources: readonly SeedResource[];
  /** Declared group natural keys (trimmed). */
  readonly groups: readonly string[];
  /** Declared user natural keys (normalized usernames). */
  readonly users: readonly string[];
  /** Declared category natural keys (normalized slugs). */
  readonly categories: readonly string[];
  /** Declared setting natural keys (trimmed). */
  readonly settings: readonly string[];
  /** Declared memberships as `[group, user]` pairs (both normalized). */
  readonly memberships: readonly (readonly [string, string])[];
}

/** De-duplicate a list of tokens, preserving first-seen order. */
function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * Generate a self-consistent {@link DesiredSpec}. Memberships are a subset of
 * the cartesian product of declared groups and users, so references are always
 * satisfied.
 */
export const desiredSpec: fc.Arbitrary<DesiredSpec> = fc
  .record({
    settingKeys: fc.array(token(), { maxLength: 4 }),
    settingVals: fc.array(settingValue, { minLength: 4, maxLength: 4 }),
    groupNames: fc.array(token(), { maxLength: 4 }),
    categorySlugs: fc.array(token(), { maxLength: 4 }),
    categoryColors: fc.array(colorValue, { minLength: 4, maxLength: 4 }),
    userNames: fc.array(token(), { maxLength: 4 }),
    userEmails: fc.array(emailValue, { minLength: 4, maxLength: 4 }),
    userTrustLevels: fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 4, maxLength: 4 }),
    // A bitmap over (group, user) pairs deciding which memberships are declared.
    membershipBits: fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
  })
  .map((r): DesiredSpec => {
    const settings = unique(r.settingKeys.map(trimString));
    const groups = unique(r.groupNames.map(trimString));
    const categories = unique(r.categorySlugs.map(normalizeSlug));
    const users = unique(r.userNames.map(normalizeUsername));

    const resources: SeedResource[] = [];

    settings.forEach((key, i) => {
      resources.push({
        type: 'setting',
        naturalKey: key,
        desired: { value: r.settingVals[i % 4] },
      });
    });
    for (const name of groups) {
      resources.push({ type: 'group', naturalKey: name, desired: { name } });
    }
    categories.forEach((slug, i) => {
      resources.push({
        type: 'category',
        naturalKey: slug,
        desired: { name: `Category ${slug}`, color: normalizeColor(r.categoryColors[i % 4]!) },
      });
    });
    users.forEach((username, i) => {
      resources.push({
        type: 'user',
        naturalKey: username,
        desired: {
          email: normalizeEmail(r.userEmails[i % 4]!),
          trustLevel: r.userTrustLevels[i % 4]!,
        },
      });
    });

    const memberships: (readonly [string, string])[] = [];
    let bit = 0;
    for (const group of groups) {
      for (const user of users) {
        if (r.membershipBits[bit % r.membershipBits.length]) {
          memberships.push([group, user]);
          resources.push({
            type: 'membership',
            naturalKey: `${group}:${user}`,
            desired: { member: true },
          });
        }
        bit += 1;
      }
    }

    return { resources, groups, users, categories, settings, memberships };
  });

/**
 * Build an {@link ActualState} for a {@link DesiredSpec} according to a set of
 * knobs. The returned state is designed to exercise the core properties:
 *
 *  - some declared entities present (so some plan to `noop`/`update`), some
 *    absent (so some plan to `create`);
 *  - undeclared entities present (which a plan must leave untouched);
 *  - extra members in declared groups (which membership authority must remove);
 *  - members in undeclared groups (which must never be read or touched).
 */
export interface ActualKnobs {
  /** Include declared entities in the actual state (so they are not all creates). */
  readonly includeDeclared: boolean;
  /** Add undeclared entities (settings/categories/users and a group). */
  readonly includeUndeclared: boolean;
  /** Add extra members to declared groups beyond those declared. */
  readonly includeExtraMembers: boolean;
  /** Add an undeclared group with members (which must stay untouched). */
  readonly includeForeignGroup: boolean;
}

/**
 * Deterministically build an {@link ActualState} from a {@link DesiredSpec} and
 * a set of {@link ActualKnobs}. "Foreign" tokens are derived by prefixing, so
 * they never collide with declared natural keys.
 */
export function buildActualState(spec: DesiredSpec, knobs: ActualKnobs): ActualState {
  const entities = new Map<ResourceKey, Readonly<Record<string, unknown>>>();
  const memberships = new Map<string, ReadonlySet<string>>();

  if (knobs.includeDeclared) {
    for (const resource of spec.resources) {
      if (resource.type === 'membership') {
        continue;
      }
      const attrs = resource.desired;
      if (typeof attrs === 'object' && attrs !== null) {
        entities.set(resourceKey(resource.type, resource.naturalKey), {
          ...(attrs as Record<string, unknown>),
        });
      }
    }
  }

  if (knobs.includeUndeclared) {
    entities.set(resourceKey('setting', 'zzz-foreign-setting'), { value: 'foreign' });
    entities.set(resourceKey('category', 'zzz-foreign-category'), {
      name: 'Foreign',
      color: 'FFFFFF',
    });
    entities.set(resourceKey('user', 'zzz-foreign-user'), {
      email: 'foreign@example.org',
      trustLevel: 0,
    });
    entities.set(resourceKey('group', 'zzz-foreign-group'), { name: 'zzz-foreign-group' });
  }

  // Declared-group memberships: declared members plus optional extras.
  const declaredByGroup = new Map<string, Set<string>>();
  for (const [group, user] of spec.memberships) {
    const set = declaredByGroup.get(group) ?? new Set<string>();
    set.add(user);
    declaredByGroup.set(group, set);
  }
  for (const group of spec.groups) {
    const members = new Set<string>(declaredByGroup.get(group) ?? new Set<string>());
    if (knobs.includeExtraMembers) {
      members.add('zzz-extra-member');
    }
    memberships.set(group, members);
  }

  if (knobs.includeForeignGroup) {
    memberships.set('zzz-foreign-group', new Set(['zzz-foreign-member']));
  }

  return { entities, memberships };
}

/** The knobs arbitrary: all combinations of the four flags. */
export const actualKnobs: fc.Arbitrary<ActualKnobs> = fc.record({
  includeDeclared: fc.boolean(),
  includeUndeclared: fc.boolean(),
  includeExtraMembers: fc.boolean(),
  includeForeignGroup: fc.boolean(),
});

/** A declared spec paired with a derived actual state and the knobs used. */
export interface DesiredAndActual {
  readonly spec: DesiredSpec;
  readonly actual: ActualState;
  readonly knobs: ActualKnobs;
}

/**
 * Generate a {@link DesiredSpec} together with a derived {@link ActualState}.
 * The actual state ranges over the full combination of knobs, so a single
 * property run exercises create/update/noop, collateral-change avoidance and
 * membership authority.
 */
export const desiredAndActual: fc.Arbitrary<DesiredAndActual> = fc
  .tuple(desiredSpec, actualKnobs)
  .map(([spec, knobs]) => ({ spec, knobs, actual: buildActualState(spec, knobs) }));

/**
 * A convenience arbitrary of a matching actual state: every declared entity
 * present and equal, declared memberships exactly, nothing foreign. Useful for
 * idempotency/convergence checks where the plan should be all no-ops.
 */
export const desiredWithMatchingActual: fc.Arbitrary<DesiredAndActual> = desiredSpec.map((spec) => {
  const knobs: ActualKnobs = {
    includeDeclared: true,
    includeUndeclared: false,
    includeExtraMembers: false,
    includeForeignGroup: false,
  };
  return { spec, knobs, actual: buildActualState(spec, knobs) };
});
