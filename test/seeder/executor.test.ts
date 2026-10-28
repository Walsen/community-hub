/**
 * Unit tests for the Seeder executor {@link execute}.
 *
 * These drive {@link execute} against the in-memory {@link createFakeForum}
 * (and, for {@link ApplyContext} wiring, a hand-written {@link SeedClient}) with
 * small {@link ForumPlan}s built directly from the seeder domain types. They
 * cover the design's "Executor" behaviour:
 *
 * - dependency order: actions are applied in plan order (asserted via the
 *   fake's call log);
 * - continue-on-failure: a failing `apply` does not abort the run, later
 *   independent actions still apply, and the failed action's result is
 *   `failed` with the {@link ForumApiError}'s body-free message;
 * - `noop` and `skip` become `skipped` with no client call;
 * - dependency-failure propagation: a `membership`/`trustLevel` whose declared
 *   dependency failed in this run is recorded `failed` with
 *   `dependency <type>:<key> failed` and makes no client call, while a
 *   dependency that merely applied or noop'd does not block the dependent;
 * - {@link ApplyContext} wiring: `resolveSecret` delegates to the injected
 *   secrets resolver and `randomPassword` to the injected generator;
 * - the logger never receives a secret value.
 *
 * Everything is deterministic and in-memory: a fake {@link SecretResolver}
 * returns a placeholder, `randomPassword` returns a placeholder, and the logger
 * writes to an in-memory sink. No real secrets appear in fixtures.
 */

import { describe, expect, it } from 'vitest';

import type { ApplyContext, SeedClient } from '../../src/engines/engine-adapter.js';
import type { SecretReference } from '../../src/metadata/secret-ref.js';
import type { ExecutorDeps } from '../../src/seeder/executor.js';
import { execute } from '../../src/seeder/executor.js';
import {
  type ActualState,
  type CreateAction,
  type ForumPlan,
  type PlanAction,
  type SeedResource,
} from '../../src/seeder/types.js';
import { createLogger, type LogSink, Redactor } from '../../src/shared/logger.js';
import type { SecretResolver } from '../../src/shared/secrets.js';
import { ForumApiError } from '../../src/shared/errors.js';
import { createFakeForum, type FakeForumOptions } from '../support/fake-forum.js';

/** An obvious placeholder a fake {@link SecretResolver} returns for any ref. */
const RESOLVED_SECRET = 'resolved-secret-value';
/** An obvious placeholder {@link ExecutorDeps.randomPassword} returns. */
const RANDOM_PASSWORD = 'random-password-value';

/** A fake secret resolver returning a fixed placeholder for any reference. */
function fakeSecrets(value: string = RESOLVED_SECRET): SecretResolver {
  return (): Promise<string> => Promise.resolve(value);
}

/** An in-memory log sink capturing every serialized JSON line. */
function captureSink(): { readonly lines: string[]; sink: LogSink } {
  const lines: string[] = [];
  return { lines, sink: { write: (line) => lines.push(line) } };
}

/** Build {@link ExecutorDeps}, letting each test override individual fields. */
function makeDeps(overrides: Partial<ExecutorDeps> = {}): {
  deps: ExecutorDeps;
  lines: string[];
  redactor: Redactor;
} {
  const { lines, sink } = captureSink();
  const redactor = new Redactor();
  const deps: ExecutorDeps = {
    secrets: overrides.secrets ?? fakeSecrets(),
    randomPassword: overrides.randomPassword ?? ((): string => RANDOM_PASSWORD),
    logger: overrides.logger ?? createLogger({ sink, redactor }),
  };
  return { deps, lines, redactor };
}

/** A `create` action for a resource of the given type and natural key. */
function create(
  type: SeedResource['type'],
  naturalKey: string,
  desired: unknown = {},
): CreateAction {
  return { kind: 'create', resource: { type, naturalKey, desired } };
}

/** A membership `create` (join) action with the `member: true` shape. */
function membershipCreate(group: string, username: string): CreateAction {
  return create('membership', `${group}:${username}`, { member: true });
}

/** A one-forum plan from a list of actions, in the given order. */
function forumPlan(actions: PlanAction[], forumId = 'main'): ForumPlan {
  return { forumId, actions };
}

describe('execute', () => {
  it('applies actions in plan order and reports each as applied', async () => {
    const forum = createFakeForum();
    const { deps } = makeDeps();
    const plan = forumPlan([
      create('setting', 'title', { value: 'Example' }),
      create('group', 'moderators'),
      create('user', 'alice'),
    ]);

    const results = await execute(plan, forum.client, deps);

    expect(results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
    // The fake's call log preserves application order, confirming plan order.
    expect(forum.calls.map((c) => ({ method: c.method, type: c.type, key: c.naturalKey }))).toEqual(
      [
        { method: 'create', type: 'setting', key: 'title' },
        { method: 'create', type: 'group', key: 'moderators' },
        { method: 'create', type: 'user', key: 'alice' },
      ],
    );
  });

  it('continues after a failing action and applies later independent actions', async () => {
    const options: FakeForumOptions = { failKeys: new Set(['moderators']) };
    const forum = createFakeForum(options);
    const { deps } = makeDeps();
    const plan = forumPlan([
      create('group', 'moderators'), // fails
      create('group', 'veterans'), // independent, still applies
      create('setting', 'title', { value: 'Example' }),
    ]);

    const results = await execute(plan, forum.client, deps);

    expect(results.map((r) => r.outcome)).toEqual(['failed', 'applied', 'applied']);
    const failed = results[0];
    expect(failed?.outcome).toBe('failed');
    // The failed result carries the ForumApiError's body-free message.
    const expectedMessage = new ForumApiError({
      forumId: 'fakeforum',
      method: 'POST',
      path: '/fake/moderators',
      status: 500,
      apiMessage: 'injected failure',
      attempts: 1,
    }).message;
    expect(failed?.error).toBe(expectedMessage);
    // The failing group made no state change; the later ones did run.
    expect(forum.calls.map((c) => c.naturalKey)).toEqual(['veterans', 'title']);
  });

  it('records noop as skipped and makes no client call', async () => {
    const forum = createFakeForum();
    const { deps } = makeDeps();
    const plan = forumPlan([
      { kind: 'noop', resource: { type: 'setting', naturalKey: 'title', desired: {} } },
    ]);

    const results = await execute(plan, forum.client, deps);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.kind).toBe('noop');
    expect(forum.calls).toHaveLength(0);
  });

  it('records skip as skipped and makes no client call', async () => {
    const forum = createFakeForum();
    const { deps } = makeDeps();
    const plan = forumPlan([
      {
        kind: 'skip',
        resource: { type: 'trustLevel', naturalKey: 'alice', desired: {} },
        reason: 'unsupported by engine',
      },
    ]);

    const results = await execute(plan, forum.client, deps);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe('skipped');
    expect(results[0]?.kind).toBe('skip');
    expect(forum.calls).toHaveLength(0);
  });

  describe('dependency failure propagation', () => {
    it('fails a membership whose group dependency failed, with no client call', async () => {
      const forum = createFakeForum({ failKeys: new Set(['moderators']) });
      const { deps } = makeDeps();
      const plan = forumPlan([
        create('group', 'moderators'), // fails
        create('user', 'alice'),
        membershipCreate('moderators', 'alice'), // depends on failed group
      ]);

      const results = await execute(plan, forum.client, deps);

      expect(results.map((r) => r.outcome)).toEqual(['failed', 'applied', 'failed']);
      expect(results[2]?.error).toBe('dependency group:moderators failed');
      // No membership call was made.
      expect(forum.calls.some((c) => c.type === 'membership')).toBe(false);
    });

    it('fails a membership whose user dependency failed, with no client call', async () => {
      const forum = createFakeForum({ failKeys: new Set(['alice']) });
      const { deps } = makeDeps();
      const plan = forumPlan([
        create('group', 'moderators'),
        create('user', 'alice'), // fails
        membershipCreate('moderators', 'alice'), // depends on failed user
      ]);

      const results = await execute(plan, forum.client, deps);

      expect(results.map((r) => r.outcome)).toEqual(['applied', 'failed', 'failed']);
      expect(results[2]?.error).toBe('dependency user:alice failed');
      expect(forum.calls.some((c) => c.type === 'membership')).toBe(false);
    });

    it('fails a trustLevel whose user dependency failed, with no client call', async () => {
      const forum = createFakeForum({ failKeys: new Set(['alice']) });
      const { deps } = makeDeps();
      const plan = forumPlan([
        create('user', 'alice'), // fails
        create('trustLevel', 'alice', { trustLevel: 3 }), // depends on failed user
      ]);

      const results = await execute(plan, forum.client, deps);

      expect(results.map((r) => r.outcome)).toEqual(['failed', 'failed']);
      expect(results[1]?.error).toBe('dependency user:alice failed');
      expect(forum.calls.some((c) => c.type === 'trustLevel')).toBe(false);
    });

    it('does not block a dependent when its dependency merely applied', async () => {
      const forum = createFakeForum();
      const { deps } = makeDeps();
      const plan = forumPlan([
        create('group', 'moderators'),
        create('user', 'alice'),
        membershipCreate('moderators', 'alice'),
      ]);

      const results = await execute(plan, forum.client, deps);

      expect(results.map((r) => r.outcome)).toEqual(['applied', 'applied', 'applied']);
      expect(forum.calls.some((c) => c.type === 'membership')).toBe(true);
    });

    it('does not block a dependent when its dependency noop\u2019d', async () => {
      const forum = createFakeForum();
      const { deps } = makeDeps();
      const plan = forumPlan([
        { kind: 'noop', resource: { type: 'group', naturalKey: 'moderators', desired: {} } },
        { kind: 'noop', resource: { type: 'user', naturalKey: 'alice', desired: {} } },
        membershipCreate('moderators', 'alice'),
      ]);

      const results = await execute(plan, forum.client, deps);

      expect(results.map((r) => r.outcome)).toEqual(['skipped', 'skipped', 'applied']);
      expect(forum.calls).toEqual([
        { method: 'addMember', type: 'membership', naturalKey: 'moderators:alice' },
      ]);
    });
  });

  describe('ApplyContext wiring', () => {
    /**
     * A minimal {@link SeedClient} whose `apply` exercises the injected
     * {@link ApplyContext}, so we can assert the executor wires `resolveSecret`
     * and `randomPassword` straight through to the injected deps.
     */
    function recordingClient(): {
      client: SeedClient;
      readonly resolved: string[];
      readonly generated: string[];
    } {
      const resolved: string[] = [];
      const generated: string[] = [];
      const client: SeedClient = {
        probe: () => Promise.resolve(),
        readActual: (): Promise<ActualState> =>
          Promise.resolve({ entities: new Map(), memberships: new Map() }),
        apply: async (_action, ctx: ApplyContext): Promise<void> => {
          resolved.push(await ctx.resolveSecret({ store: 'ssm', id: '/placeholder' }));
          generated.push(ctx.randomPassword());
        },
      };
      return { client, resolved, generated };
    }

    it('delegates resolveSecret to deps.secrets and randomPassword to deps.randomPassword', async () => {
      const { client, resolved, generated } = recordingClient();
      const secretCalls: SecretReference[] = [];
      const secrets: SecretResolver = (ref) => {
        secretCalls.push(ref);
        return Promise.resolve(RESOLVED_SECRET);
      };
      let passwordCalls = 0;
      const randomPassword = (): string => {
        passwordCalls += 1;
        return RANDOM_PASSWORD;
      };
      const { deps } = makeDeps({ secrets, randomPassword });
      const plan = forumPlan([create('user', 'alice')]);

      const results = await execute(plan, client, deps);

      expect(results[0]?.outcome).toBe('applied');
      expect(resolved).toEqual([RESOLVED_SECRET]);
      expect(generated).toEqual([RANDOM_PASSWORD]);
      expect(secretCalls).toEqual([{ store: 'ssm', id: '/placeholder' }]);
      expect(passwordCalls).toBe(1);
    });
  });

  describe('logging hygiene', () => {
    it('never writes a resolved secret or generated password to the logger', async () => {
      // A client that resolves a secret and generates a password during apply,
      // so both values pass through the executor's ApplyContext.
      const client: SeedClient = {
        probe: () => Promise.resolve(),
        readActual: (): Promise<ActualState> =>
          Promise.resolve({ entities: new Map(), memberships: new Map() }),
        apply: async (_action, ctx: ApplyContext): Promise<void> => {
          await ctx.resolveSecret({ store: 'ssm', id: '/placeholder' });
          ctx.randomPassword();
        },
      };
      const { lines, sink } = captureSink();
      const redactor = new Redactor();
      const deps: ExecutorDeps = {
        secrets: fakeSecrets(RESOLVED_SECRET),
        randomPassword: (): string => RANDOM_PASSWORD,
        logger: createLogger({ sink, redactor }),
      };
      const plan = forumPlan([
        create('user', 'alice'),
        { kind: 'noop', resource: { type: 'setting', naturalKey: 'title', desired: {} } },
      ]);

      await execute(plan, client, deps);

      expect(lines.length).toBeGreaterThan(0);
      const output = lines.join('\n');
      expect(output).not.toContain(RESOLVED_SECRET);
      expect(output).not.toContain(RANDOM_PASSWORD);
    });

    it('logs a body-free error message on failure without a secret value', async () => {
      const forum = createFakeForum({ failKeys: new Set(['alice']) });
      const { deps, lines } = makeDeps();
      const plan = forumPlan([create('user', 'alice')]);

      const results = await execute(plan, forum.client, deps);

      expect(results[0]?.outcome).toBe('failed');
      const output = lines.join('\n');
      expect(output).toContain('seed action failed');
      expect(output).not.toContain(RESOLVED_SECRET);
      expect(output).not.toContain(RANDOM_PASSWORD);
    });
  });

  it('returns one result per action, preserving input order', async () => {
    const forum = createFakeForum({ failKeys: new Set(['veterans']) });
    const { deps } = makeDeps();
    const plan = forumPlan([
      create('setting', 'title', { value: 'Example' }),
      create('group', 'veterans'), // fails
      {
        kind: 'skip',
        resource: { type: 'trustLevel', naturalKey: 'bob', desired: {} },
        reason: 'x',
      },
      create('user', 'alice'),
    ]);

    const results = await execute(plan, forum.client, deps);

    expect(results.map((r) => r.outcome)).toEqual(['applied', 'failed', 'skipped', 'applied']);
    expect(results.map((r) => r.resource.naturalKey)).toEqual([
      'title',
      'veterans',
      'bob',
      'alice',
    ]);
  });
});
