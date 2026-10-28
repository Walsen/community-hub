/**
 * Unit tests for the pure reconciler {@link plan}, complementing the Seeder
 * property tests with concrete worked examples.
 *
 * These cover:
 * - unsupported resource types become `skip` with a reason that names the type
 *   and engine id;
 * - `create` when an entity is absent, `noop` when declared fields match, and
 *   `update` carrying a {@link FieldDiff} when a declared field differs;
 * - write-only fields (`initialPassword`) are never diffed, so a differing or
 *   absent actual password never produces an update;
 * - undeclared attributes present in the actual state never cause an update
 *   (no collateral changes);
 * - membership semantics: declared-and-present → `noop`, declared-and-absent →
 *   `create`, an extra actual member of a declared group → `update` with the
 *   `member: true → false` removal shape, and undeclared groups are untouched;
 * - actions are sorted by {@link RESOURCE_TYPE_ORDER} then by natural key.
 *
 * {@link ActualState} is built inline with Maps. The supported-type set is taken
 * from the `testengine` adapter (which omits `trustLevel`) or constructed
 * directly. No secret values appear; write-only references use placeholders.
 */

import { describe, expect, it } from 'vitest';

import { WRITE_ONLY_FIELDS } from '../../src/seeder/desired.js';
import { plan, type PlanInput } from '../../src/seeder/reconciler.js';
import {
  type ActualState,
  type PlanAction,
  RESOURCE_TYPE_ORDER,
  type ResourceKey,
  type ResourceType,
  resourceKey,
  type SeedResource,
} from '../../src/seeder/types.js';
import { createTestEngine } from '../support/testengine.js';

/** The `testengine` adapter's supported types (deliberately omits `trustLevel`). */
const SUPPORTED = createTestEngine().seed.supportedTypes;

/** All resource types, for tests that do not care about the unsupported path. */
const ALL_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>(RESOURCE_TYPE_ORDER);

/** An empty actual state. */
function emptyActual(): ActualState {
  return { entities: new Map(), memberships: new Map() };
}

/** Build an {@link ActualState} from entity and membership literals. */
function actualState(
  entities: Record<string, Readonly<Record<string, unknown>>>,
  memberships: Record<string, readonly string[]> = {},
): ActualState {
  const entityMap = new Map<ResourceKey, Readonly<Record<string, unknown>>>();
  for (const [key, attrs] of Object.entries(entities)) {
    entityMap.set(key as ResourceKey, attrs);
  }
  const membershipMap = new Map<string, ReadonlySet<string>>();
  for (const [group, members] of Object.entries(memberships)) {
    membershipMap.set(group, new Set(members));
  }
  return { entities: entityMap, memberships: membershipMap };
}

/** Minimal {@link PlanInput} with sensible defaults. */
function planInput(overrides: Partial<PlanInput>): PlanInput {
  return {
    forumId: 'main',
    engineId: 'testengine',
    supportedTypes: ALL_TYPES,
    desired: [],
    actual: emptyActual(),
    ...overrides,
  };
}

/** Find the single action for a resource by `"<type>:<naturalKey>"`. */
function actionFor(actions: readonly PlanAction[], key: string): PlanAction {
  const found = actions.find(
    (action) => `${action.resource.type}:${action.resource.naturalKey}` === key,
  );
  if (found === undefined) {
    throw new Error(`no action for ${key}`);
  }
  return found;
}

describe('plan: unsupported resource types', () => {
  it('skips an unsupported type with a reason naming the type and engine', () => {
    const trustLevel: SeedResource = {
      type: 'trustLevel',
      naturalKey: 'alice',
      desired: { trustLevel: 3 },
    };
    const result = plan(planInput({ supportedTypes: SUPPORTED, desired: [trustLevel] }));
    expect(result.actions).toHaveLength(1);
    const action = result.actions[0];
    expect(action?.kind).toBe('skip');
    if (action?.kind === 'skip') {
      expect(action.reason).toBe(
        "resource type 'trustLevel' is not supported by engine 'testengine'",
      );
    }
  });
});

describe('plan: create / noop / update by natural key', () => {
  const setting: SeedResource = {
    type: 'setting',
    naturalKey: 'title',
    desired: { value: 'Example Community' },
  };

  it('creates when the entity is absent', () => {
    const result = plan(planInput({ desired: [setting] }));
    expect(result.actions[0]?.kind).toBe('create');
  });

  it('noops when the declared fields equal the actual state', () => {
    const actual = actualState({
      [resourceKey('setting', 'title')]: { value: 'Example Community' },
    });
    const result = plan(planInput({ desired: [setting], actual }));
    expect(result.actions[0]?.kind).toBe('noop');
  });

  it('updates with a FieldDiff when a declared field differs', () => {
    const actual = actualState({
      [resourceKey('setting', 'title')]: { value: 'Old Title' },
    });
    const result = plan(planInput({ desired: [setting], actual }));
    const action = result.actions[0];
    expect(action?.kind).toBe('update');
    if (action?.kind === 'update') {
      expect(action.diff).toEqual([{ field: 'value', from: 'Old Title', to: 'Example Community' }]);
    }
  });
});

describe('plan: write-only fields are never diffed', () => {
  const user: SeedResource = {
    type: 'user',
    naturalKey: 'alice',
    desired: {
      email: 'alice@example.org',
      trustLevel: 3,
      initialPassword: { store: 'ssm', id: '/community-hub/community-test/main/users/alice' },
    },
  };

  it('does not update when only the write-only password reference is present', () => {
    // initialPassword is listed as write-only and must never be compared.
    expect(WRITE_ONLY_FIELDS.has('initialPassword')).toBe(true);
    const actual = actualState({
      [resourceKey('user', 'alice')]: { email: 'alice@example.org', trustLevel: 3 },
    });
    const result = plan(planInput({ desired: [user], actual }));
    expect(result.actions[0]?.kind).toBe('noop');
  });

  it('ignores a differing actual password field (not declared, not diffed)', () => {
    const actual = actualState({
      [resourceKey('user', 'alice')]: {
        email: 'alice@example.org',
        trustLevel: 3,
        initialPassword: { store: 'ssm', id: 'something-else' },
      },
    });
    const result = plan(planInput({ desired: [user], actual }));
    expect(result.actions[0]?.kind).toBe('noop');
  });
});

describe('plan: no collateral changes', () => {
  it('ignores undeclared attributes present only in the actual state', () => {
    const setting: SeedResource = {
      type: 'setting',
      naturalKey: 'title',
      desired: { value: 'Example Community' },
    };
    const actual = actualState({
      [resourceKey('setting', 'title')]: {
        value: 'Example Community',
        extraUnmanaged: 'left alone',
        another: 42,
      },
    });
    const result = plan(planInput({ desired: [setting], actual }));
    expect(result.actions[0]?.kind).toBe('noop');
  });
});

describe('plan: membership semantics', () => {
  const groupResource: SeedResource = {
    type: 'group',
    naturalKey: 'moderators',
    desired: { name: 'moderators' },
  };
  const membership = (member: string): SeedResource => ({
    type: 'membership',
    naturalKey: `moderators:${member}`,
    desired: { member: true },
  });

  it('noops a declared membership that already exists', () => {
    const result = plan(
      planInput({
        desired: [groupResource, membership('alice')],
        actual: actualState({}, { moderators: ['alice'] }),
      }),
    );
    expect(actionFor(result.actions, 'membership:moderators:alice').kind).toBe('noop');
  });

  it('creates a declared membership that is absent', () => {
    const result = plan(
      planInput({
        desired: [groupResource, membership('alice')],
        actual: actualState({}, { moderators: [] }),
      }),
    );
    expect(actionFor(result.actions, 'membership:moderators:alice').kind).toBe('create');
  });

  it('removes an extra actual member of a declared group via member true->false update', () => {
    const result = plan(
      planInput({
        desired: [groupResource, membership('alice')],
        actual: actualState({}, { moderators: ['alice', 'bob'] }),
      }),
    );
    const removal = actionFor(result.actions, 'membership:moderators:bob');
    expect(removal.kind).toBe('update');
    if (removal.kind === 'update') {
      expect(removal.resource.desired).toEqual({ member: false });
      expect(removal.diff).toEqual([{ field: 'member', from: true, to: false }]);
    }
  });

  it('leaves members of undeclared groups untouched', () => {
    const result = plan(
      planInput({
        desired: [groupResource, membership('alice')],
        actual: actualState({}, { moderators: ['alice'], veterans: ['carol'] }),
      }),
    );
    // No action references the undeclared `veterans` group at all.
    const touchesVeterans = result.actions.some((action) =>
      action.resource.naturalKey.startsWith('veterans:'),
    );
    expect(touchesVeterans).toBe(false);
  });
});

describe('plan: ordering', () => {
  it('sorts actions by RESOURCE_TYPE_ORDER then natural key', () => {
    const desired: SeedResource[] = [
      { type: 'trustLevel', naturalKey: 'bob', desired: { trustLevel: 1 } },
      { type: 'membership', naturalKey: 'moderators:bob', desired: { member: true } },
      { type: 'membership', naturalKey: 'moderators:alice', desired: { member: true } },
      { type: 'user', naturalKey: 'bob', desired: { email: 'bob@example.org', trustLevel: 1 } },
      { type: 'user', naturalKey: 'alice', desired: { email: 'alice@example.org', trustLevel: 3 } },
      { type: 'group', naturalKey: 'moderators', desired: { name: 'moderators' } },
      { type: 'category', naturalKey: 'announcements', desired: { name: 'A', color: '0088CC' } },
      { type: 'setting', naturalKey: 'title', desired: { value: 'T' } },
    ];
    const result = plan(planInput({ desired }));
    const order = result.actions.map(
      (action) => `${action.resource.type}:${action.resource.naturalKey}`,
    );
    expect(order).toEqual([
      'setting:title',
      'group:moderators',
      'category:announcements',
      'user:alice',
      'user:bob',
      'membership:moderators:alice',
      'membership:moderators:bob',
      'trustLevel:bob',
    ]);
  });
});
