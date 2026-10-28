import { describe, expect, it } from 'vitest';

import {
  createDiscourseSeedClient,
  transformDesiredDiscourse,
} from '../../../src/engines/discourse/seed-client.js';
import type { ApplyContext, SeedClientDeps } from '../../../src/engines/engine-adapter.js';
import type { CreateAction, SeedResource, UpdateAction } from '../../../src/seeder/types.js';
import { ForumApiError } from '../../../src/shared/errors.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../../../src/shared/http.js';
import type { Logger } from '../../../src/shared/logger.js';

/**
 * Unit tests for the Discourse seed client (task 10.4).
 *
 * The client is driven through its composed `readActual`/`apply` surface with a
 * fake {@link HttpClient} that records every request and returns scripted JSON
 * responses. Tests assert the request shape per operation, the shared admin
 * headers, response parsing, and error mapping (including 404-means-absent).
 * No network, no AWS; the API key is an obvious placeholder.
 */

const API_KEY = 'test-api-key';
const BASE_URL = 'https://forum.example.org';

/** A scripted response keyed by `"<METHOD> <path-without-query>"`. */
interface Script {
  readonly status: number;
  readonly body?: unknown;
}

/** The path (without query) of a request URL. */
function pathOf(url: string): string {
  const parsed = new URL(url);
  return parsed.pathname;
}

/**
 * A fake {@link HttpClient}: records every request and returns a scripted
 * response. A 2xx with no script returns an empty body; a non-2xx (and not an
 * allowed status the client swallows) is raised as {@link ForumApiError} the
 * same way the real client would, so error mapping can be exercised.
 */
class FakeHttp implements HttpClient {
  readonly requests: HttpRequest[] = [];
  readonly #scripts: Map<string, Script>;

  constructor(scripts: Record<string, Script> = {}) {
    this.#scripts = new Map(Object.entries(scripts));
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(req);
    const key = `${req.method} ${pathOf(req.url)}`;
    const script = this.#scripts.get(key);
    const status = script?.status ?? 200;
    if (status >= 200 && status <= 299) {
      return Promise.resolve({ status, headers: new Headers(), body: script?.body });
    }
    // Mirror the real HttpClient: non-2xx becomes a ForumApiError.
    return Promise.reject(
      new ForumApiError({
        forumId: req.forumId,
        method: req.method,
        path: pathOf(req.url),
        status,
        apiMessage: 'scripted error',
        attempts: 1,
      }),
    );
  }

  /** The recorded `"<METHOD> <path>"` list (query stripped) for assertions. */
  log(): string[] {
    return this.requests.map((r) => `${r.method} ${pathOf(r.url)}`);
  }

  /** The last recorded request. */
  last(): HttpRequest {
    const req = this.requests.at(-1);
    if (req === undefined) {
      throw new Error('no requests recorded');
    }
    return req;
  }
}

/** A no-op logger. */
const logger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function deps(http: HttpClient): SeedClientDeps {
  return { baseUrl: BASE_URL, apiKey: API_KEY, http, logger };
}

/** An apply context with placeholder secrets only. */
const applyContext: ApplyContext = {
  resolveSecret(): Promise<string> {
    return Promise.resolve('test-secret-value');
  },
  randomPassword(): string {
    return 'test-generated-password';
  },
};

function resource(type: SeedResource['type'], naturalKey: string, desired: unknown): SeedResource {
  return { type, naturalKey, desired };
}

function createAction(res: SeedResource): CreateAction {
  return { kind: 'create', resource: res };
}

function updateAction(res: SeedResource, diff: UpdateAction['diff'] = []): UpdateAction {
  return { kind: 'update', resource: res, diff };
}

describe('transformDesiredDiscourse', () => {
  it('encodes booleans as "true"/"false"', () => {
    const out = transformDesiredDiscourse([
      resource('setting', 'enable_x', { value: true }),
      resource('setting', 'enable_y', { value: false }),
    ]);
    expect(out[0]?.desired).toEqual({ value: 'true' });
    expect(out[1]?.desired).toEqual({ value: 'false' });
  });

  it('joins arrays with "|"', () => {
    const out = transformDesiredDiscourse([resource('setting', 'tags', { value: ['a', 'b'] })]);
    expect(out[0]?.desired).toEqual({ value: 'a|b' });
  });

  it('coerces numbers to strings', () => {
    const out = transformDesiredDiscourse([resource('setting', 'max', { value: 5 })]);
    expect(out[0]?.desired).toEqual({ value: '5' });
  });

  it('passes strings through unchanged', () => {
    const out = transformDesiredDiscourse([resource('setting', 'title', { value: 'Hub' })]);
    expect(out[0]?.desired).toEqual({ value: 'Hub' });
  });

  it('leaves non-setting resources unchanged', () => {
    const group = resource('group', 'moderators', { name: 'moderators' });
    const out = transformDesiredDiscourse([group]);
    expect(out[0]).toBe(group);
  });
});

describe('Discourse seed client request shapes', () => {
  it('probe issues a GET to /site.json', async () => {
    const http = new FakeHttp({ 'GET /site.json': { status: 200, body: { categories: [] } } });
    const client = createDiscourseSeedClient(deps(http));
    await client.probe();
    expect(http.log()).toEqual(['GET /site.json']);
    expect(http.last().method).toBe('GET');
  });

  it('includes Api-Key and Api-Username: system headers on every request', async () => {
    const http = new FakeHttp({ 'GET /site.json': { status: 200, body: { categories: [] } } });
    const client = createDiscourseSeedClient(deps(http));
    await client.probe();
    expect(http.last().headers?.['Api-Key']).toBe(API_KEY);
    expect(http.last().headers?.['Api-Username']).toBe('system');
  });

  it('reads settings from GET /admin/site_settings.json', async () => {
    const http = new FakeHttp({
      'GET /admin/site_settings.json': {
        status: 200,
        body: { site_settings: [{ setting: 'title', value: 'Hub' }] },
      },
    });
    const client = createDiscourseSeedClient(deps(http));
    const actual = await client.readActual([resource('setting', 'title', { value: 'Hub' })]);
    expect(http.log()).toEqual(['GET /admin/site_settings.json']);
    expect(actual.entities.get('setting:title')).toEqual({ value: 'Hub' });
  });

  it('writes a setting via PUT /admin/site_settings/{key}.json', async () => {
    const http = new FakeHttp();
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(createAction(resource('setting', 'title', { value: 'Hub' })), applyContext);
    expect(http.log()).toEqual(['PUT /admin/site_settings/title.json']);
    expect(http.last().body).toEqual({ title: 'Hub' });
  });

  it('reads a group from GET /groups/{name}.json', async () => {
    const http = new FakeHttp({
      'GET /groups/moderators.json': {
        status: 200,
        body: { group: { id: 42, name: 'moderators' } },
      },
    });
    const client = createDiscourseSeedClient(deps(http));
    const actual = await client.readActual([
      resource('group', 'moderators', { name: 'moderators' }),
    ]);
    expect(http.log()).toEqual(['GET /groups/moderators.json']);
    expect(actual.entities.get('group:moderators')).toEqual({ name: 'moderators' });
  });

  it('reads categories from GET /site.json', async () => {
    const http = new FakeHttp({
      'GET /site.json': {
        status: 200,
        body: {
          categories: [{ id: 3, slug: 'announcements', name: 'Announcements', color: '0088CC' }],
        },
      },
    });
    const client = createDiscourseSeedClient(deps(http));
    const actual = await client.readActual([
      resource('category', 'announcements', { name: 'Announcements', color: '0088CC' }),
    ]);
    expect(http.log()).toEqual(['GET /site.json']);
    expect(actual.entities.get('category:announcements')).toEqual({
      name: 'Announcements',
      color: '0088CC',
    });
  });

  it('creates a user with active/approved and sends a reset when no password ref', async () => {
    const http = new FakeHttp();
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(
      createAction(resource('user', 'alice', { email: 'alice@example.org', trustLevel: 1 })),
      applyContext,
    );
    expect(http.log()).toEqual(['POST /users.json', 'POST /session/forgot_password']);
    expect(http.requests[0]?.body).toMatchObject({
      username: 'alice',
      email: 'alice@example.org',
      active: true,
      approved: true,
    });
  });

  it('creates a user with a resolved password and no reset when a password ref is declared', async () => {
    const http = new FakeHttp();
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(
      createAction(
        resource('user', 'bob', {
          email: 'bob@example.org',
          trustLevel: 0,
          initialPassword: { store: 'ssm', id: '/community-hub/community-test/main/users/bob' },
        }),
      ),
      applyContext,
    );
    expect(http.log()).toEqual(['POST /users.json']);
    expect(http.requests[0]?.body).toMatchObject({ password: 'test-secret-value' });
  });

  it('adds a member to a normal group via PUT /groups/{id}/members.json', async () => {
    const http = new FakeHttp({
      'GET /groups/veterans.json': { status: 200, body: { group: { id: 7, name: 'veterans' } } },
    });
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(
      createAction(resource('membership', 'veterans:alice', { member: true })),
      applyContext,
    );
    expect(http.log()).toEqual(['GET /groups/veterans.json', 'PUT /groups/7/members.json']);
    expect(http.last().body).toEqual({ usernames: 'alice' });
  });

  it('removes a member from a normal group via DELETE /groups/{id}/members.json', async () => {
    const http = new FakeHttp({
      'GET /groups/veterans.json': { status: 200, body: { group: { id: 7, name: 'veterans' } } },
    });
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(
      updateAction(resource('membership', 'veterans:alice', { member: false }), [
        { field: 'member', from: true, to: false },
      ]),
      applyContext,
    );
    expect(http.log()).toEqual(['GET /groups/veterans.json', 'DELETE /groups/7/members.json']);
    expect(http.last().body).toEqual({ usernames: 'alice' });
  });

  it('grants moderation for the moderators special group', async () => {
    const http = new FakeHttp({
      'GET /u/alice.json': {
        status: 200,
        body: { user: { id: 11, username: 'alice', trust_level: 2 } },
      },
    });
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(
      createAction(resource('membership', 'moderators:alice', { member: true })),
      applyContext,
    );
    expect(http.log()).toEqual(['GET /u/alice.json', 'PUT /admin/users/11/grant_moderation']);
  });

  it('revokes moderation for the moderators special group on removal', async () => {
    const http = new FakeHttp({
      'GET /u/alice.json': {
        status: 200,
        body: { user: { id: 11, username: 'alice', trust_level: 2 } },
      },
    });
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(
      updateAction(resource('membership', 'moderators:alice', { member: false }), [
        { field: 'member', from: true, to: false },
      ]),
      applyContext,
    );
    expect(http.log()).toEqual(['GET /u/alice.json', 'PUT /admin/users/11/revoke_moderation']);
  });

  it('sets a trust level via PUT /admin/users/{id}/trust_level', async () => {
    const http = new FakeHttp({
      'GET /u/alice.json': {
        status: 200,
        body: { user: { id: 11, username: 'alice', trust_level: 1 } },
      },
    });
    const client = createDiscourseSeedClient(deps(http));
    await client.apply(
      createAction(resource('trustLevel', 'alice', { trustLevel: 3 })),
      applyContext,
    );
    expect(http.last().method).toBe('PUT');
    expect(pathOf(http.last().url)).toBe('/admin/users/11/trust_level');
    expect(http.last().body).toEqual({ level: 3 });
  });
});

describe('Discourse seed client reads and error mapping', () => {
  it('treats a 404 on group read as absent (no entry)', async () => {
    const http = new FakeHttp({ 'GET /groups/ghost.json': { status: 404 } });
    const client = createDiscourseSeedClient(deps(http));
    const actual = await client.readActual([resource('group', 'ghost', { name: 'ghost' })]);
    expect(actual.entities.has('group:ghost')).toBe(false);
  });

  it('treats a 404 on user read as absent (no entry)', async () => {
    const http = new FakeHttp({ 'GET /u/ghost.json': { status: 404 } });
    const client = createDiscourseSeedClient(deps(http));
    const actual = await client.readActual([
      resource('user', 'ghost', { email: 'ghost@example.org', trustLevel: 0 }),
    ]);
    expect(actual.entities.has('user:ghost')).toBe(false);
  });

  it('surfaces a non-allowed non-2xx as ForumApiError', async () => {
    const http = new FakeHttp({ 'GET /admin/site_settings.json': { status: 500 } });
    const client = createDiscourseSeedClient(deps(http));
    await expect(
      client.readActual([resource('setting', 'title', { value: 'Hub' })]),
    ).rejects.toBeInstanceOf(ForumApiError);
  });

  it('raises ForumApiError when a response has an unexpected shape', async () => {
    const http = new FakeHttp({
      'GET /admin/site_settings.json': { status: 200, body: { wrong: true } },
    });
    const client = createDiscourseSeedClient(deps(http));
    await expect(
      client.readActual([resource('setting', 'title', { value: 'Hub' })]),
    ).rejects.toBeInstanceOf(ForumApiError);
  });
});
