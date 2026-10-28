import { describe, expect, it } from 'vitest';

import type {
  ApplyContext,
  MembershipHandler,
  ResourceHandler,
  SeedHandlers,
} from '../../src/engines/engine-adapter.js';
import { composeSeedClient } from '../../src/engines/seed-client.js';
import type {
  CreateAction,
  FieldDiff,
  SeedResource,
  UpdateAction,
} from '../../src/seeder/types.js';

/** A record of one call made against a recording handler. */
interface HandlerCall {
  readonly method: string;
  readonly keys: readonly string[];
}

/**
 * A recording {@link ResourceHandler}. `read` returns the provided canned
 * attributes for keys it knows about and records every call (method + keys).
 */
function recordingResourceHandler(
  calls: HandlerCall[],
  label: string,
  readResult: ReadonlyMap<string, Readonly<Record<string, unknown>>> = new Map(),
): ResourceHandler {
  return {
    read(keys): Promise<ReadonlyMap<string, Readonly<Record<string, unknown>>>> {
      calls.push({ method: `${label}.read`, keys });
      return Promise.resolve(readResult);
    },
    create(resource: SeedResource): Promise<void> {
      calls.push({ method: `${label}.create`, keys: [resource.naturalKey] });
      return Promise.resolve();
    },
    update(resource: SeedResource): Promise<void> {
      calls.push({ method: `${label}.update`, keys: [resource.naturalKey] });
      return Promise.resolve();
    },
  };
}

/** A recording {@link MembershipHandler}. */
function recordingMembershipHandler(
  calls: HandlerCall[],
  readResult: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): MembershipHandler {
  return {
    readMembers(groups): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
      calls.push({ method: 'membership.readMembers', keys: groups });
      return Promise.resolve(readResult);
    },
    add(group, username): Promise<void> {
      calls.push({ method: 'membership.add', keys: [`${group}:${username}`] });
      return Promise.resolve();
    },
    remove(group, username): Promise<void> {
      calls.push({ method: 'membership.remove', keys: [`${group}:${username}`] });
      return Promise.resolve();
    },
  };
}

/** An apply context whose helpers are never expected to be called here. */
const unusedApplyContext: ApplyContext = {
  resolveSecret(): Promise<string> {
    throw new Error('resolveSecret should not be called');
  },
  randomPassword(): string {
    throw new Error('randomPassword should not be called');
  },
};

function resource(type: SeedResource['type'], naturalKey: string, desired: unknown): SeedResource {
  return { type, naturalKey, desired };
}

function createAction(res: SeedResource): CreateAction {
  return { kind: 'create', resource: res };
}

function updateAction(res: SeedResource, diff: FieldDiff[] = []): UpdateAction {
  return { kind: 'update', resource: res, diff };
}

describe('composeSeedClient', () => {
  it('exposes the injected probe', async () => {
    const calls: string[] = [];
    const client = composeSeedClient(() => {
      calls.push('probe');
      return Promise.resolve();
    }, {});

    await client.probe();
    expect(calls).toEqual(['probe']);
  });

  describe('readActual', () => {
    it('calls each type handler read with its own natural keys', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        setting: recordingResourceHandler(calls, 'setting'),
        group: recordingResourceHandler(calls, 'group'),
        membership: recordingMembershipHandler(calls),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.readActual([
        resource('setting', 'title', { value: 'Hub' }),
        resource('setting', 'tagline', { value: 'Hello' }),
        resource('group', 'moderators', {}),
        resource('membership', 'moderators:alice', { member: true }),
      ]);

      expect(calls).toContainEqual({ method: 'setting.read', keys: ['title', 'tagline'] });
      expect(calls).toContainEqual({ method: 'group.read', keys: ['moderators'] });
      expect(calls).toContainEqual({ method: 'membership.readMembers', keys: ['moderators'] });
    });

    it('keys entities by `<type>:<naturalKey>` and memberships by group', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        setting: recordingResourceHandler(
          calls,
          'setting',
          new Map([['title', { value: 'Example Community' }]]),
        ),
        user: recordingResourceHandler(
          calls,
          'user',
          new Map([['alice', { email: 'alice@example.org' }]]),
        ),
        membership: recordingMembershipHandler(
          calls,
          new Map<string, ReadonlySet<string>>([['moderators', new Set(['alice', 'bob'])]]),
        ),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      const actual = await client.readActual([
        resource('setting', 'title', { value: 'Example Community' }),
        resource('user', 'alice', { email: 'alice@example.org' }),
        resource('membership', 'moderators:alice', { member: true }),
      ]);

      expect(actual.entities.get('setting:title')).toEqual({ value: 'Example Community' });
      expect(actual.entities.get('user:alice')).toEqual({ email: 'alice@example.org' });
      expect([...(actual.memberships.get('moderators') ?? [])].sort()).toEqual(['alice', 'bob']);
    });

    it('deduplicates group keys across memberships and reads membership once', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        membership: recordingMembershipHandler(calls),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.readActual([
        resource('membership', 'moderators:alice', { member: true }),
        resource('membership', 'moderators:bob', { member: true }),
        resource('membership', 'veterans:carol', { member: true }),
      ]);

      const membershipReads = calls.filter((c) => c.method === 'membership.readMembers');
      expect(membershipReads).toHaveLength(1);
      expect([...membershipReads[0]!.keys].sort()).toEqual(['moderators', 'veterans']);
    });

    it('skips reads for types with no handler and parses `group:user` on the first colon', async () => {
      const calls: HandlerCall[] = [];
      // No `setting` handler registered, so its keys must not trigger a read.
      const handlers: SeedHandlers = {
        membership: recordingMembershipHandler(calls),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.readActual([resource('setting', 'title', { value: 'x' })]);

      expect(calls).toHaveLength(0);
    });
  });

  describe('apply', () => {
    it('dispatches create to the matching type handler', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        category: recordingResourceHandler(calls, 'category'),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.apply(
        createAction(resource('category', 'announcements', { name: 'Announcements' })),
        unusedApplyContext,
      );

      expect(calls).toEqual([{ method: 'category.create', keys: ['announcements'] }]);
    });

    it('dispatches update to the matching type handler', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        user: recordingResourceHandler(calls, 'user'),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.apply(
        updateAction(resource('user', 'alice', { trustLevel: 3 }), [
          { field: 'trustLevel', from: 1, to: 3 },
        ]),
        unusedApplyContext,
      );

      expect(calls).toEqual([{ method: 'user.update', keys: ['alice'] }]);
    });

    it('routes a membership with `member: false` to remove', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        membership: recordingMembershipHandler(calls),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.apply(
        updateAction(resource('membership', 'moderators:alice', { member: false }), [
          { field: 'member', from: true, to: false },
        ]),
        unusedApplyContext,
      );

      expect(calls).toEqual([{ method: 'membership.remove', keys: ['moderators:alice'] }]);
    });

    it('routes a membership create to add', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        membership: recordingMembershipHandler(calls),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.apply(
        createAction(resource('membership', 'moderators:alice', { member: true })),
        unusedApplyContext,
      );

      expect(calls).toEqual([{ method: 'membership.add', keys: ['moderators:alice'] }]);
    });

    it('routes a membership update with `member: true` to add', async () => {
      const calls: HandlerCall[] = [];
      const handlers: SeedHandlers = {
        membership: recordingMembershipHandler(calls),
      };
      const client = composeSeedClient(() => Promise.resolve(), handlers);

      await client.apply(
        updateAction(resource('membership', 'moderators:alice', { member: true })),
        unusedApplyContext,
      );

      expect(calls).toEqual([{ method: 'membership.add', keys: ['moderators:alice'] }]);
    });

    it('throws when dispatching to a type with no registered handler', async () => {
      const client = composeSeedClient(() => Promise.resolve(), {});

      await expect(
        client.apply(createAction(resource('setting', 'title', {})), unusedApplyContext),
      ).rejects.toThrow(/no seed handler registered for resource type 'setting'/);
    });

    it('throws on a malformed membership natural key', async () => {
      const calls: HandlerCall[] = [];
      const client = composeSeedClient(() => Promise.resolve(), {
        membership: recordingMembershipHandler(calls),
      });

      await expect(
        client.apply(createAction(resource('membership', 'noseparator', {})), unusedApplyContext),
      ).rejects.toThrow(/malformed membership natural key/);
    });
  });
});
