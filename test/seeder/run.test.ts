/**
 * Unit tests for the Seeder run orchestration ({@link runSeed}).
 *
 * These exercise the edge that wires the pure pieces (`buildDesired`, `plan`,
 * `summarize`, `formatReport`, `formatPlan`) to the injected I/O (secret
 * resolution and the engine's seed client). The engine is a `testengine`
 * adapter backed by the in-memory `createFakeForum`, so reachability, initial
 * state and the mutating call log are fully under test control and no network,
 * clock or randomness is involved.
 *
 * Covered (design "Run orchestration" + Requirements 2.4, 8.9, 9.3, 9.8):
 * - forum selection and the unknown-forum error,
 * - preflight API-key resolution before any forum call,
 * - unreachable-forum handling with continue-on,
 * - dry-run purity (no mutating call),
 * - the happy path applying planned creates/updates.
 */

import { describe, expect, it } from 'vitest';

import type { SeedClient, SeedClientDeps } from '../../src/engines/engine-adapter.js';
import { EngineRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import type { ValidatedModel } from '../../src/metadata/schema.js';
import { formatSecretReference, type SecretReference } from '../../src/metadata/secret-ref.js';
import { runSeed } from '../../src/seeder/run.js';
import { resourceKey } from '../../src/seeder/types.js';
import { SecretResolutionError } from '../../src/shared/errors.js';
import type { HttpClient } from '../../src/shared/http.js';
import { createLogger, Redactor, type LogSink } from '../../src/shared/logger.js';
import type { SecretResolver } from '../../src/shared/secrets.js';

import { createFakeForum, type FakeForum, type EntityAttrs } from '../support/fake-forum.js';
import { createTestEngine } from '../support/testengine.js';
import type { ResourceKey } from '../../src/seeder/types.js';

/**
 * A metadata document with two `testengine` forums. `main` declares content
 * (settings, a group with a member, a category and a user) so planning yields
 * concrete create/update actions; `dev` is content-free so it plans to nothing,
 * which keeps the multi-forum behaviour (selection, continue-on) easy to read.
 */
const TWO_FORUM_YAML = `
version: 1
environment:
  name: community-test
  region: us-east-1
  availabilityZone: us-east-1a
  dnsMode: route53
  rootDomain: example.org
  adminEmail: ops@example.org
  sshAllowedCidrs:
    - 203.0.113.0/24
forums:
  - id: main
    engine: testengine
    subdomain: forum
    bundleId: small_3_0
    senderAddress: noreply
    secrets:
      adminPassword: ssm:/community-hub/community-test/main/admin-password
      apiKey: ssm:/community-hub/community-test/main/api-key
    config:
      settings:
        title: Example Community
      groups:
        - name: moderators
          members:
            - alice
      categories:
        - slug: announcements
          name: Announcements
          color: "0088CC"
      users:
        - username: alice
          email: alice@example.org
          trustLevel: 3
  - id: dev
    engine: flarum-ish
    subdomain: dev
    bundleId: small_3_0
    senderAddress: dev-forum
    secrets:
      adminPassword: ssm:/community-hub/community-test/dev/admin-password
      apiKey: ssm:/community-hub/community-test/dev/api-key
`;

/** Placeholder secret value returned for any resolvable reference. */
const PLACEHOLDER_API_KEY = 'test-api-key-value';

/** Build the engine registry, binding each forum id to its fake forum. */
function buildRegistry(options: { fakes: ReadonlyMap<string, FakeForum> }): EngineRegistry {
  const seedClientFactory = (deps: SeedClientDeps): SeedClient => {
    // The fake forum is selected by the forum subdomain encoded in baseUrl so a
    // single registry can serve different fakes per forum.
    const forumId = forumIdFromBaseUrl(deps.baseUrl);
    const fake = options.fakes.get(forumId);
    if (fake === undefined) {
      throw new Error(`no fake forum registered for '${forumId}'`);
    }
    return fake.client;
  };

  const testengine = createTestEngine({ id: 'testengine', seedClientFactory });
  // A second engine id for the `dev` forum, so both forums resolve. It shares
  // the same factory, keyed by base URL, so each forum gets its own fake.
  const flarumIsh = createTestEngine({ id: 'flarum-ish', seedClientFactory });
  return new EngineRegistry([testengine, flarumIsh]);
}

/** Map a forum base URL (`https://<subdomain>.example.org`) to its forum id. */
function forumIdFromBaseUrl(baseUrl: string): string {
  // forum.example.org -> main; dev.example.org -> dev. The map below is keyed
  // by subdomain, matching the YAML above.
  const subdomain = new URL(baseUrl).hostname.split('.')[0];
  switch (subdomain) {
    case 'forum':
      return 'main';
    case 'dev':
      return 'dev';
    default:
      return subdomain ?? '';
  }
}

/** Load the two-forum model against a registry built from the given fakes. */
function loadTwoForumModel(fakes: ReadonlyMap<string, FakeForum>): {
  model: ValidatedModel;
  registry: EngineRegistry;
} {
  const registry = buildRegistry({ fakes });
  const model = loadMetadata(TWO_FORUM_YAML, registry);
  return { model, registry };
}

/** An in-memory log sink that records every written line. */
function createRecordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    sink: {
      write(line: string): void {
        lines.push(line);
      },
    },
  };
}

/**
 * Build the injected {@link RunSeedDeps}. The HTTP client is a never-called
 * stub (the fake forums do not issue real requests), and `randomPassword`
 * returns an obvious placeholder.
 */
function buildDeps(options: { secrets: SecretResolver; logLines?: string[] }): {
  secrets: SecretResolver;
  http: HttpClient;
  logger: ReturnType<typeof createLogger>;
  randomPassword: () => string;
} {
  const redactor = new Redactor();
  const { sink, lines } = createRecordingSink();
  if (options.logLines !== undefined) {
    // Mirror lines into the caller's array for assertions.
    const original = sink.write.bind(sink);
    sink.write = (line: string): void => {
      original(line);
      options.logLines?.push(line);
    };
  }
  void lines;
  const http: HttpClient = {
    request(): never {
      throw new Error('HttpClient.request should not be called by the fake forum');
    },
  };
  return {
    secrets: options.secrets,
    http,
    logger: createLogger({ sink, redactor }),
    randomPassword: () => 'test-random-password',
  };
}

/** A resolver that returns the placeholder for every reference. */
const alwaysResolves: SecretResolver = () => Promise.resolve(PLACEHOLDER_API_KEY);

describe('runSeed', () => {
  describe('forum selection', () => {
    it('throws UnknownForumError listing known ids and probes nothing', async () => {
      const main = createFakeForum({ forumId: 'main' });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      const error = await runSeed({
        model,
        registry,
        forumId: 'nope',
        dryRun: false,
        deps: buildDeps({ secrets: alwaysResolves }),
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as { name: string }).name).toBe('UnknownForumError');
      expect((error as { known: readonly string[] }).known).toEqual(['main', 'dev']);
      // No forum was touched.
      expect(main.calls).toHaveLength(0);
      expect(dev.calls).toHaveLength(0);
    });

    it('with a --forum filter processes only the named forum', async () => {
      const main = createFakeForum({ forumId: 'main' });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      const result = await runSeed({
        model,
        registry,
        forumId: 'main',
        dryRun: false,
        deps: buildDeps({ secrets: alwaysResolves }),
      });

      expect(result.summaries.map((s) => s.forumId)).toEqual(['main']);
      // dev was never probed or mutated.
      expect(dev.calls).toHaveLength(0);
    });
  });

  describe('preflight secret resolution', () => {
    it('propagates a SecretResolutionError for an apiKey and probes no forum', async () => {
      const main = createFakeForum({ forumId: 'main' });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      let probed = false;
      const originalProbe = main.client.probe.bind(main.client);
      // Flag any probe so we can assert preflight aborted before it.
      (main.client as { probe: () => Promise<void> }).probe = () => {
        probed = true;
        return originalProbe();
      };

      // Fail resolution for the main forum's apiKey reference only.
      const mainApiKeyRef = model.forums[0]!.secrets.apiKey!;
      const secrets: SecretResolver = (ref: SecretReference) => {
        if (formatSecretReference(ref) === formatSecretReference(mainApiKeyRef)) {
          return Promise.reject(
            new SecretResolutionError({
              reference: formatSecretReference(ref),
              reason: 'access_denied',
            }),
          );
        }
        return Promise.resolve(PLACEHOLDER_API_KEY);
      };

      const error = await runSeed({
        model,
        registry,
        dryRun: false,
        deps: buildDeps({ secrets }),
      }).then(
        () => undefined,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(SecretResolutionError);
      expect(probed).toBe(false);
      expect(main.calls).toHaveLength(0);
      expect(dev.calls).toHaveLength(0);
    });
  });

  describe('unreachable forum (Req 9.8)', () => {
    it('records unreachable: true, continues to other forums, exit status 1', async () => {
      const main = createFakeForum({ forumId: 'main', unreachable: true });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      const result = await runSeed({
        model,
        registry,
        dryRun: false,
        deps: buildDeps({ secrets: alwaysResolves }),
      });

      const mainSummary = result.summaries.find((s) => s.forumId === 'main');
      expect(mainSummary?.unreachable).toBe(true);
      // The unreachable forum made no mutating calls.
      expect(main.calls).toHaveLength(0);

      // The other forum was still processed (its summary exists and is reachable).
      const devSummary = result.summaries.find((s) => s.forumId === 'dev');
      expect(devSummary).toBeDefined();
      expect(devSummary?.unreachable).toBe(false);

      expect(result.exitStatus).toBe(1);
      expect(result.report).toContain('main: UNREACHABLE');
    });
  });

  describe('dry-run (Req 9.3)', () => {
    it('issues no mutating calls and reports the plan with planned counts', async () => {
      const main = createFakeForum({ forumId: 'main' });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      const result = await runSeed({
        model,
        registry,
        forumId: 'main',
        dryRun: true,
        deps: buildDeps({ secrets: alwaysResolves }),
      });

      // No create/update/addMember/removeMember happened: only GET-only
      // probe/readActual, which the fake does not record as calls.
      expect(main.calls).toHaveLength(0);
      // In-memory state is unchanged (empty, as seeded).
      expect(main.entities().size).toBe(0);
      expect(main.memberships().size).toBe(0);

      // The planned creates are reported and counted.
      const mainSummary = result.summaries.find((s) => s.forumId === 'main');
      expect(mainSummary).toBeDefined();
      // setting(title), group(moderators), category(announcements), user(alice),
      // membership(moderators:alice). trustLevel is unsupported by testengine ->
      // skipped.
      expect(mainSummary?.created).toBe(5);
      expect(mainSummary?.skipped).toBe(1);
      expect(mainSummary?.updated).toBe(0);
      expect(mainSummary?.failed).toBe(0);

      // The report is the plan text, naming the forum and planned resources.
      expect(result.report).toContain('main:');
      expect(result.report).toContain('create setting title');
      expect(result.report).toContain('create user alice');
      expect(result.report).toContain('create membership moderators:alice');
    });
  });

  describe('happy path', () => {
    it('applies planned creates, counts them, and exits 0', async () => {
      const main = createFakeForum({ forumId: 'main' });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      const result = await runSeed({
        model,
        registry,
        forumId: 'main',
        dryRun: false,
        deps: buildDeps({ secrets: alwaysResolves }),
      });

      // Mutating calls were recorded for the planned creates.
      const createdKeys = main.calls
        .filter((c) => c.method === 'create')
        .map((c) => `${c.type}:${c.naturalKey}`);
      expect(createdKeys).toContain('setting:title');
      expect(createdKeys).toContain('group:moderators');
      expect(createdKeys).toContain('category:announcements');
      expect(createdKeys).toContain('user:alice');
      // The membership was added.
      expect(main.calls).toContainEqual({
        method: 'addMember',
        type: 'membership',
        naturalKey: 'moderators:alice',
      });

      // State changed in the fake forum.
      const settingKey: ResourceKey = resourceKey('setting', 'title');
      const setting: EntityAttrs | undefined = main.entities().get(settingKey);
      expect(setting).toBeDefined();

      const mainSummary = result.summaries.find((s) => s.forumId === 'main');
      expect(mainSummary?.created).toBe(5);
      expect(mainSummary?.skipped).toBe(1); // trustLevel unsupported by testengine
      expect(mainSummary?.failed).toBe(0);
      expect(result.exitStatus).toBe(0);
    });

    it('updates an existing entity whose declared field drifted', async () => {
      // Seed the forum with a title setting that differs from the declaration.
      const initialEntities = new Map<ResourceKey, EntityAttrs>([
        [resourceKey('setting', 'title'), { value: 'Old Title' }],
      ]);
      const main = createFakeForum({ forumId: 'main', initialEntities });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      const result = await runSeed({
        model,
        registry,
        forumId: 'main',
        dryRun: false,
        deps: buildDeps({ secrets: alwaysResolves }),
      });

      // The title setting was updated, not created.
      expect(main.calls).toContainEqual({
        method: 'update',
        type: 'setting',
        naturalKey: 'title',
      });
      const mainSummary = result.summaries.find((s) => s.forumId === 'main');
      expect(mainSummary?.updated).toBe(1);
      expect(main.entities().get(resourceKey('setting', 'title'))).toEqual({
        value: 'Example Community',
      });
      expect(result.exitStatus).toBe(0);
    });
  });

  describe('secret hygiene', () => {
    it('never writes the resolved api key into the report or logs', async () => {
      const main = createFakeForum({ forumId: 'main' });
      const dev = createFakeForum({ forumId: 'dev' });
      const fakes = new Map([
        ['main', main],
        ['dev', dev],
      ]);
      const { model, registry } = loadTwoForumModel(fakes);

      const logLines: string[] = [];
      const result = await runSeed({
        model,
        registry,
        dryRun: false,
        deps: buildDeps({ secrets: alwaysResolves, logLines }),
      });

      expect(result.report).not.toContain(PLACEHOLDER_API_KEY);
      for (const line of logLines) {
        expect(line).not.toContain(PLACEHOLDER_API_KEY);
      }
    });
  });
});
