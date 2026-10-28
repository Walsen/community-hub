import { describe, expect, it } from 'vitest';

import {
  createFlarumSeedClient,
  resolveTrustLevelGroup,
  transformDesiredFlarum,
} from '../../../src/engines/flarum/seed-client.js';
import type { ApplyContext, SeedClientDeps } from '../../../src/engines/engine-adapter.js';
import type { ForumModel } from '../../../src/metadata/schema.js';
import type { CreateAction, SeedResource, UpdateAction } from '../../../src/seeder/types.js';
import { ForumApiError } from '../../../src/shared/errors.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../../../src/shared/http.js';
import type { Logger } from '../../../src/shared/logger.js';

/**
 * Unit tests for the Flarum seed client (task 11.4).
 *
 * The client is driven through its composed `readActual`/`apply` surface with a
 * fake {@link HttpClient} that records every request and returns scripted
 * JSON:API responses. Tests assert the request shape per operation, the shared
 * `Authorization: Token <apiKey>` header, response parsing, and error mapping.
 * The pure `resolveTrustLevelGroup` and `transformDesiredFlarum` helpers are
 * tested directly. No network, no AWS; the API key is an obvious placeholder.
 */

const API_KEY = 'test-api-key';
const BASE_URL = 'https://dev.example.org';

/** A scripted response keyed by `"<METHOD> <path-without-query>"`. */
interface Script {
  readonly status: number;
  readonly body?: unknown;
}

/** The path (without query) of a request URL. */
function pathOf(url: string): string {
  return new URL(url).pathname;
}

/**
 * A fake {@link HttpClient}: records every request and returns a scripted
 * response. A 2xx with no script returns an empty body; a non-2xx is raised as
 * {@link ForumApiError} the same way the real client would, so error mapping
 * can be exercised.
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

  /** The full query string (with `?`) of the last recorded request. */
  lastSearch(): string {
    return new URL(this.last().url).search;
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

describe('resolveTrustLevelGroup', () => {
  const mapping = { '0': 'members', '3': 'veterans' } as const;

  it('returns the exact-key match when present', () => {
    expect(resolveTrustLevelGroup(mapping, 0)).toBe('members');
    expect(resolveTrustLevelGroup(mapping, 3)).toBe('veterans');
  });

  it('falls back to the greatest key <= the level', () => {
    expect(resolveTrustLevelGroup(mapping, 1)).toBe('members');
    expect(resolveTrustLevelGroup(mapping, 2)).toBe('members');
    expect(resolveTrustLevelGroup(mapping, 4)).toBe('veterans');
  });

  it('returns undefined when no key is at or below the level', () => {
    expect(resolveTrustLevelGroup({ '3': 'veterans' }, 2)).toBeUndefined();
  });
});

describe('transformDesiredFlarum', () => {
  /** A ForumModel carrying only the engineOptions the transform reads. */
  function forumWith(trustLevelGroups: Record<string, string>): ForumModel {
    return { engineOptions: { trustLevelGroups } } as unknown as ForumModel;
  }

  it('rewrites a trust level mapped to a declared group into a membership', () => {
    const forum = forumWith({ '0': 'members', '3': 'veterans' });
    const out = transformDesiredFlarum([resource('trustLevel', 'alice', { trustLevel: 3 })], forum);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      type: 'membership',
      naturalKey: 'veterans:alice',
      desired: { member: true },
    });
  });

  it('drops a trust level mapped to the implicit Member group', () => {
    const forum = forumWith({ '0': 'members', '3': 'veterans' });
    const out = transformDesiredFlarum([resource('trustLevel', 'bob', { trustLevel: 0 })], forum);
    expect(out).toHaveLength(0);
  });

  it('drops a trust level that is not mapped', () => {
    const forum = forumWith({ '3': 'veterans' });
    const out = transformDesiredFlarum([resource('trustLevel', 'carol', { trustLevel: 0 })], forum);
    expect(out).toHaveLength(0);
  });

  it('passes non-trustLevel resources through unchanged', () => {
    const forum = forumWith({ '0': 'members' });
    const group = resource('group', 'veterans', { name: 'veterans' });
    const out = transformDesiredFlarum([group], forum);
    expect(out[0]).toBe(group);
  });

  it('maps a colorScheme to Flarum theme color settings and drops other slots', () => {
    const forum = forumWith({});
    const scheme = resource('colorScheme', 'K Builders', {
      name: 'K Builders',
      mode: 'dark',
      color_primary: '222222',
      color_secondary: 'FFFFFF',
      color_tertiary: '0088CC',
      color_highlight: 'FFFF4D',
    });
    const out = transformDesiredFlarum([scheme], forum);
    const byKey = new Map(out.map((r) => [`${r.type}:${r.naturalKey}`, r.desired] as const));
    // primary/secondary map to Flarum theme settings (with a leading #); the
    // mode maps to the dark-mode toggle; tertiary/highlight are dropped.
    expect(byKey.get('setting:theme_primary_color')).toEqual({ value: '#222222' });
    expect(byKey.get('setting:theme_secondary_color')).toEqual({ value: '#FFFFFF' });
    expect(byKey.get('setting:theme_dark_mode_default')).toEqual({ value: true });
    expect(out.some((r) => r.type === 'colorScheme')).toBe(false);
    expect(out).toHaveLength(3);
  });

  it('remaps the canonical title branding setting to forum_title and drops logo/favicon', () => {
    const forum = forumWith({});
    const out = transformDesiredFlarum(
      [
        resource('setting', 'title', { value: 'K Builders' }),
        resource('setting', 'logo', { value: 'https://x/logo.png' }),
        resource('setting', 'favicon', { value: 'https://x/favicon.ico' }),
      ],
      forum,
    );
    const keys = out.map((r) => `${r.type}:${r.naturalKey}`);
    expect(keys).toContain('setting:forum_title');
    expect(keys).not.toContain('setting:logo');
    expect(keys).not.toContain('setting:favicon');
    expect(out).toHaveLength(1);
  });
});

describe('Flarum seed client request shapes', () => {
  function forumDoc(attributes: Record<string, unknown> = {}): Script {
    return { status: 200, body: { data: { attributes } } };
  }

  it('probe issues a GET to /api', async () => {
    const http = new FakeHttp({ 'GET /api': forumDoc() });
    const client = createFlarumSeedClient(deps(http));
    await client.probe();
    expect(http.log()).toEqual(['GET /api']);
  });

  it('sends Authorization: Token <apiKey> on every request', async () => {
    const http = new FakeHttp({ 'GET /api': forumDoc() });
    const client = createFlarumSeedClient(deps(http));
    await client.probe();
    expect(http.last().headers?.['Authorization']).toBe(`Token ${API_KEY}`);
  });

  it('reads an allowlisted setting from the GET /api forum attributes', async () => {
    const http = new FakeHttp({ 'GET /api': forumDoc({ forum_title: 'Hub' }) });
    const client = createFlarumSeedClient(deps(http));
    const actual = await client.readActual([resource('setting', 'forum_title', { value: 'Hub' })]);
    expect(http.log()).toEqual(['GET /api']);
    expect(actual.entities.get('setting:forum_title')).toEqual({ value: 'Hub' });
  });

  it('writes a setting via POST /api/settings as a flat key/value object', async () => {
    const http = new FakeHttp();
    const client = createFlarumSeedClient(deps(http));
    await client.apply(
      createAction(resource('setting', 'forum_title', { value: 'Hub' })),
      applyContext,
    );
    expect(http.log()).toEqual(['POST /api/settings']);
    expect(http.last().body).toEqual({ forum_title: 'Hub' });
  });

  it('throws ForumApiError when writing a non-allowlisted setting', async () => {
    const http = new FakeHttp();
    const client = createFlarumSeedClient(deps(http));
    await expect(
      client.apply(
        createAction(resource('setting', 'mail_driver', { value: 'smtp' })),
        applyContext,
      ),
    ).rejects.toBeInstanceOf(ForumApiError);
    // No HTTP call is made for a rejected setting key.
    expect(http.requests).toHaveLength(0);
  });

  it('reads groups from GET /api/groups', async () => {
    const http = new FakeHttp({
      'GET /api/groups': {
        status: 200,
        body: { data: [{ id: '4', attributes: { nameSingular: 'veterans' } }] },
      },
    });
    const client = createFlarumSeedClient(deps(http));
    const actual = await client.readActual([resource('group', 'veterans', { name: 'veterans' })]);
    expect(http.log()).toEqual(['GET /api/groups']);
    expect(actual.entities.get('group:veterans')).toEqual({ name: 'veterans' });
  });

  it('creates a group via POST /api/groups', async () => {
    const http = new FakeHttp();
    const client = createFlarumSeedClient(deps(http));
    await client.apply(
      createAction(resource('group', 'veterans', { name: 'veterans' })),
      applyContext,
    );
    expect(http.log()).toEqual(['POST /api/groups']);
    expect(http.last().body).toEqual({
      data: { type: 'groups', attributes: { nameSingular: 'veterans', namePlural: 'veterans' } },
    });
  });

  it('reads categories as tags from GET /api/tags', async () => {
    const http = new FakeHttp({
      'GET /api/tags': {
        status: 200,
        body: {
          data: [
            {
              id: '2',
              attributes: { slug: 'announcements', name: 'Announcements', color: '#0088CC' },
            },
          ],
        },
      },
    });
    const client = createFlarumSeedClient(deps(http));
    const actual = await client.readActual([
      resource('category', 'announcements', { name: 'Announcements', color: '0088CC' }),
    ]);
    expect(http.log()).toEqual(['GET /api/tags']);
    expect(actual.entities.get('category:announcements')).toEqual({
      name: 'Announcements',
      color: '0088CC',
    });
  });

  it('creates a category as a tag via POST /api/tags', async () => {
    const http = new FakeHttp();
    const client = createFlarumSeedClient(deps(http));
    await client.apply(
      createAction(
        resource('category', 'announcements', { name: 'Announcements', color: '0088CC' }),
      ),
      applyContext,
    );
    expect(http.log()).toEqual(['POST /api/tags']);
    expect(http.last().body).toEqual({
      data: {
        type: 'tags',
        attributes: { name: 'Announcements', slug: 'announcements', color: '#0088CC' },
      },
    });
  });

  it('finds a user via GET /api/users?filter[q]=username:<u>', async () => {
    const http = new FakeHttp({
      'GET /api/users': {
        status: 200,
        body: {
          data: [{ id: '9', attributes: { username: 'alice', email: 'alice@example.org' } }],
        },
      },
    });
    const client = createFlarumSeedClient(deps(http));
    const actual = await client.readActual([
      resource('user', 'alice', { email: 'alice@example.org' }),
    ]);
    expect(http.log()).toEqual(['GET /api/users']);
    expect(http.lastSearch()).toContain('filter[q]=username%3Aalice');
    expect(actual.entities.get('user:alice')).toEqual({ email: 'alice@example.org' });
  });

  it('creates a user (isEmailConfirmed true) and sends a reset when no password ref', async () => {
    const http = new FakeHttp();
    const client = createFlarumSeedClient(deps(http));
    await client.apply(
      createAction(resource('user', 'alice', { email: 'alice@example.org' })),
      applyContext,
    );
    expect(http.log()).toEqual(['POST /api/users', 'POST /api/forgot']);
    expect(http.requests[0]?.body).toEqual({
      data: {
        type: 'users',
        attributes: {
          username: 'alice',
          email: 'alice@example.org',
          password: 'test-generated-password',
          isEmailConfirmed: true,
        },
      },
    });
    expect(http.requests[1]?.body).toEqual({ data: { email: 'alice@example.org' } });
  });

  it('creates a user with a resolved password and no reset when a password ref is declared', async () => {
    const http = new FakeHttp();
    const client = createFlarumSeedClient(deps(http));
    await client.apply(
      createAction(
        resource('user', 'bob', {
          email: 'bob@example.org',
          initialPassword: { store: 'ssm', id: '/community-hub/community-test/dev/users/bob' },
        }),
      ),
      applyContext,
    );
    expect(http.log()).toEqual(['POST /api/users']);
    const body = http.requests[0]?.body as { data: { attributes: { password: string } } };
    expect(body.data.attributes.password).toBe('test-secret-value');
  });

  it('adds a membership by PATCHing the user groups relationship', async () => {
    const http = new FakeHttp({
      'GET /api/groups': {
        status: 200,
        body: { data: [{ id: '4', attributes: { nameSingular: 'veterans' } }] },
      },
      'GET /api/users': {
        status: 200,
        body: {
          data: [
            {
              id: '9',
              attributes: { username: 'alice' },
              relationships: { groups: { data: [] } },
            },
          ],
        },
      },
    });
    const client = createFlarumSeedClient(deps(http));
    await client.apply(
      createAction(resource('membership', 'veterans:alice', { member: true })),
      applyContext,
    );
    expect(http.last().method).toBe('PATCH');
    expect(pathOf(http.last().url)).toBe('/api/users/9');
    expect(http.last().body).toEqual({
      data: {
        type: 'users',
        id: '9',
        relationships: { groups: { data: [{ type: 'groups', id: '4' }] } },
      },
    });
  });

  it('removes a membership by PATCHing the user groups relationship without the group', async () => {
    const http = new FakeHttp({
      'GET /api/groups': {
        status: 200,
        body: { data: [{ id: '4', attributes: { nameSingular: 'veterans' } }] },
      },
      'GET /api/users': {
        status: 200,
        body: {
          data: [
            {
              id: '9',
              attributes: { username: 'alice' },
              relationships: { groups: { data: [{ id: '4' }] } },
            },
          ],
        },
      },
    });
    const client = createFlarumSeedClient(deps(http));
    await client.apply(
      updateAction(resource('membership', 'veterans:alice', { member: false }), [
        { field: 'member', from: true, to: false },
      ]),
      applyContext,
    );
    expect(http.last().method).toBe('PATCH');
    expect(pathOf(http.last().url)).toBe('/api/users/9');
    expect(http.last().body).toEqual({
      data: {
        type: 'users',
        id: '9',
        relationships: { groups: { data: [] } },
      },
    });
  });
});

describe('Flarum seed client reads and error mapping', () => {
  it('omits an absent setting from actual state', async () => {
    const http = new FakeHttp({ 'GET /api': { status: 200, body: { data: { attributes: {} } } } });
    const client = createFlarumSeedClient(deps(http));
    const actual = await client.readActual([resource('setting', 'forum_title', { value: 'Hub' })]);
    expect(actual.entities.has('setting:forum_title')).toBe(false);
  });

  it('omits an absent group from actual state', async () => {
    const http = new FakeHttp({ 'GET /api/groups': { status: 200, body: { data: [] } } });
    const client = createFlarumSeedClient(deps(http));
    const actual = await client.readActual([resource('group', 'ghost', { name: 'ghost' })]);
    expect(actual.entities.has('group:ghost')).toBe(false);
  });

  it('surfaces a non-2xx read as ForumApiError', async () => {
    const http = new FakeHttp({ 'GET /api/groups': { status: 500 } });
    const client = createFlarumSeedClient(deps(http));
    await expect(
      client.readActual([resource('group', 'veterans', { name: 'veterans' })]),
    ).rejects.toBeInstanceOf(ForumApiError);
  });

  it('raises ForumApiError when a response has an unexpected shape', async () => {
    const http = new FakeHttp({ 'GET /api/groups': { status: 200, body: { wrong: true } } });
    const client = createFlarumSeedClient(deps(http));
    await expect(
      client.readActual([resource('group', 'veterans', { name: 'veterans' })]),
    ).rejects.toBeInstanceOf(ForumApiError);
  });
});
