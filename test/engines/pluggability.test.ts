/**
 * Pluggability test (task 21.5).
 *
 * This proves a brand-new engine plugs into Community Hub end to end — metadata
 * load, CDK stack synthesis, ACME challenge selection and a Seeder run — WITHOUT
 * editing any `src/` core module. The whole demonstration lives in the test: the
 * only thing a new engine needs is an {@link EngineAdapter} added to the registry
 * the core modules are handed by injection.
 *
 * The engine under test is the in-repo fake `testengine` (`test/support/testengine.ts`),
 * which declares `tls.dns01: false` and a reduced `supportedTypes` set. It is
 * registered alongside the production Discourse and Flarum adapters. Importing
 * those two concrete adapters here is allowed — the architecture boundary forbids
 * `src/infra/`, `src/seeder/` and `src/metadata/` from importing a concrete
 * adapter, not the tests. The core modules in this test (`loadMetadata`,
 * `EnvironmentStack`, `selectChallenge`, `runSeed`) reach the engine only through
 * the {@link EngineRegistry}, never by importing `testengine` themselves.
 *
 * Requirements: 7.3 (adapters resolved only via the registry), 7.4 (unsupported
 * resource types skipped), 13.4 (HTTP-01 for an engine that cannot consume
 * host-issued certificates, in a Route 53 mode) and 10.4 (unit coverage).
 */

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';

// Concrete adapters: imported by the TEST only, to mirror createDefaultRegistry's
// list. Core src/ modules must never do this; they take a registry by injection.
import { discourseAdapter } from '../../src/engines/discourse/adapter.js';
import { flarumAdapter } from '../../src/engines/flarum/adapter.js';
import type {
  EngineAdapter,
  SeedClient,
  SeedClientDeps,
} from '../../src/engines/engine-adapter.js';
import { EngineRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import type { ValidatedModel } from '../../src/metadata/schema.js';
import { EnvironmentStack } from '../../src/infra/environment-stack.js';
import { names } from '../../src/infra/naming.js';
import { selectChallenge } from '../../src/infra/tls/challenge.js';
import { runSeed } from '../../src/seeder/run.js';
import { resourceKey, type ResourceKey } from '../../src/seeder/types.js';
import type { Logger } from '../../src/shared/logger.js';

import { createFakeForum, type EntityAttrs, type FakeForum } from '../support/fake-forum.js';
import { createTestEngine } from '../support/testengine.js';

/** A no-op {@link Logger} for the seed run: nothing is asserted on log output here. */
const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Context key the CDK toolkit reads to decide which stacks to bundle assets for. */
const BUNDLING_STACKS = 'aws:cdk:bundling-stacks';

/** A concrete placeholder account so ARNs resolve to literals, never `Ref`s. */
const ACCOUNT = '123456789012';

/** Environment name and region reused across the assertions. */
const ENV = 'community-test';
const REGION = 'us-east-1';

/** The engine id the new engine registers under. */
const ENGINE_ID = 'testengine';

/** The single forum id driven by the new engine throughout the test. */
const FORUM_ID = 'community';

/** Placeholder secret value the resolver returns for every reference. */
const PLACEHOLDER_API_KEY = 'test-api-key-value';

/**
 * Metadata with exactly one `testengine` forum in `route53` (a Route 53 mode),
 * on a `small_3_0` bundle that meets testengine's 512 MB minimum, declaring the
 * required `adminPassword` and `apiKey` secrets. The `config` block declares a
 * setting, a group with a member, a category, a user and a `trustLevel` — the
 * last is unsupported by testengine, so it exercises the skip path (Req 7.4).
 */
const METADATA_YAML = `
version: 1
environment:
  name: ${ENV}
  region: ${REGION}
  availabilityZone: us-east-1a
  dnsMode: route53
  rootDomain: example.org
  adminEmail: ops@example.org
  sshAllowedCidrs:
    - 203.0.113.0/24
forums:
  - id: ${FORUM_ID}
    engine: ${ENGINE_ID}
    subdomain: forum
    bundleId: small_3_0
    senderAddress: noreply
    secrets:
      adminPassword: ssm:/community-hub/${ENV}/${FORUM_ID}/admin-password
      apiKey: ssm:/community-hub/${ENV}/${FORUM_ID}/api-key
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
`;

/**
 * Build a registry with the production engines PLUS `testengine`, mirroring the
 * array `createDefaultRegistry()` constructs and appending the new adapter. This
 * is the one-line change a new engine requires; nothing in `src/` is touched.
 *
 * @param seedClientFactory - optional factory so the seed-run assertion can back
 *   the engine with an in-memory fake forum.
 * @returns the registry and the exact `testengine` adapter instance registered.
 */
function buildRegistry(seedClientFactory?: (deps: SeedClientDeps) => SeedClient): {
  registry: EngineRegistry;
  testEngine: EngineAdapter;
} {
  const testEngine = createTestEngine(
    seedClientFactory === undefined ? { id: ENGINE_ID } : { id: ENGINE_ID, seedClientFactory },
  );
  const registry = new EngineRegistry([discourseAdapter, flarumAdapter, testEngine]);
  return { registry, testEngine };
}

describe('engine pluggability with testengine (no core changes)', () => {
  describe('LOAD: the loader accepts a testengine forum via the registry', () => {
    it('resolves the engine, validates options and secrets, and freezes the model', () => {
      const { registry } = buildRegistry();
      const model: ValidatedModel = loadMetadata(METADATA_YAML, registry);

      expect(model.forums).toHaveLength(1);
      const forum = model.forums[0];
      expect(forum?.engine).toBe(ENGINE_ID);
      // Required secrets (adminPassword, apiKey) are present and parsed as refs.
      expect(forum?.secrets.adminPassword).toBeDefined();
      expect(forum?.secrets.apiKey).toBeDefined();
      // The model is deep-frozen like every validated model.
      expect(Object.isFrozen(model)).toBe(true);
    });
  });

  describe('STACK SYNTHESIS: EnvironmentStack resolves testengine only via the registry', () => {
    let template: Template;

    beforeAll(() => {
      const { registry } = buildRegistry();
      const model = loadMetadata(METADATA_YAML, registry);
      const app = new App({ context: { [BUNDLING_STACKS]: [] } });
      const stack = new EnvironmentStack(app, names.stack(model.environment.name), {
        model,
        registry,
        env: { account: ACCOUNT, region: REGION },
      });
      template = Template.fromStack(stack);
    });

    it('synthesizes without throwing', () => {
      expect(template.toJSON()).toBeTypeOf('object');
    });

    it('creates the testengine forum instance and its static IP', () => {
      template.resourceCountIs('AWS::Lightsail::Instance', 1);
      template.resourceCountIs('AWS::Lightsail::StaticIp', 1);
      template.hasResourceProperties('AWS::Lightsail::Instance', {
        InstanceName: names.instance(ENV, FORUM_ID),
      });
      template.hasResourceProperties('AWS::Lightsail::StaticIp', {
        StaticIpName: names.staticIp(ENV, FORUM_ID),
      });
    });

    it('grants the node role no Route 53 DNS-01 statements (testengine is HTTP-01)', () => {
      const roles = template.findResources('AWS::IAM::Role', {
        Properties: { RoleName: names.nodeRole(ENV, FORUM_ID) },
      });
      const roleList = Object.values(roles);
      expect(roleList).toHaveLength(1);

      // The whole node-role policy carries no route53: action, because an
      // HTTP-01 forum never gets DNS-01 permissions merged in.
      const serialized = JSON.stringify(roleList[0]?.Properties);
      expect(serialized).not.toContain('route53:');
    });
  });

  describe('CHALLENGE: HTTP-01 is selected for testengine in a Route 53 mode (Req 13.4)', () => {
    it('selectChallenge returns http-01 because testengine declares dns01: false', () => {
      const { testEngine } = buildRegistry();
      // Guard: the assertion only means something if testengine is HTTP-01.
      expect(testEngine.tls.dns01).toBe(false);
      expect(selectChallenge('route53', testEngine.tls)).toBe('http-01');
      expect(selectChallenge('route53-existing', testEngine.tls)).toBe('http-01');
    });
  });

  describe('SEED RUN: runSeed reconciles a testengine forum against a fake forum', () => {
    it('applies the supported resources, skips the unsupported trustLevel, exits 0', async () => {
      const fake: FakeForum = createFakeForum({ forumId: FORUM_ID });
      // Bind the engine's seed client to the in-memory fake forum.
      const { registry } = buildRegistry((): SeedClient => fake.client);
      const model = loadMetadata(METADATA_YAML, registry);

      const result = await runSeed({
        model,
        registry,
        dryRun: false,
        deps: {
          secrets: () => Promise.resolve(PLACEHOLDER_API_KEY),
          http: {
            request(): never {
              throw new Error('HttpClient.request should not be called by the fake forum');
            },
          },
          logger: NOOP_LOGGER,
          randomPassword: () => 'test-random-password',
        },
      });

      // The supported resources were created in the fake forum.
      const createdKeys = fake.calls
        .filter((call) => call.method === 'create')
        .map((call) => `${call.type}:${call.naturalKey}`);
      expect(createdKeys).toContain('setting:title');
      expect(createdKeys).toContain('group:moderators');
      expect(createdKeys).toContain('category:announcements');
      expect(createdKeys).toContain('user:alice');
      expect(fake.calls).toContainEqual({
        method: 'addMember',
        type: 'membership',
        naturalKey: 'moderators:alice',
      });

      // The setting really landed in the fake's in-memory state.
      const titleKey: ResourceKey = resourceKey('setting', 'title');
      const title: EntityAttrs | undefined = fake.entities().get(titleKey);
      expect(title).toBeDefined();

      const summary = result.summaries.find((s) => s.forumId === FORUM_ID);
      // setting, group, category, user, membership = 5 created; trustLevel skipped.
      expect(summary?.created).toBe(5);
      expect(summary?.skipped).toBe(1);
      expect(summary?.failed).toBe(0);
      expect(result.exitStatus).toBe(0);
    });

    it('a dry run issues zero mutating calls and leaves the fake forum unchanged', async () => {
      const fake: FakeForum = createFakeForum({ forumId: FORUM_ID });
      const { registry } = buildRegistry((): SeedClient => fake.client);
      const model = loadMetadata(METADATA_YAML, registry);

      const result = await runSeed({
        model,
        registry,
        dryRun: true,
        deps: {
          secrets: () => Promise.resolve(PLACEHOLDER_API_KEY),
          http: {
            request(): never {
              throw new Error('HttpClient.request should not be called by the fake forum');
            },
          },
          logger: NOOP_LOGGER,
          randomPassword: () => 'test-random-password',
        },
      });

      expect(fake.calls).toHaveLength(0);
      expect(fake.entities().size).toBe(0);
      expect(fake.memberships().size).toBe(0);
      // The planned creates are still counted and reported.
      const summary = result.summaries.find((s) => s.forumId === FORUM_ID);
      expect(summary?.created).toBe(5);
      expect(summary?.skipped).toBe(1);
      expect(result.report).toContain(`${FORUM_ID}:`);
    });
  });
});
