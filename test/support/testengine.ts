/**
 * A fake `testengine` {@link EngineAdapter} for the test suite.
 *
 * This adapter implements the full engine plugin contract with trivial, pure
 * behaviour so loader tests, registry tests and the pluggability test can use a
 * stable in-repo engine without depending on the real Discourse or Flarum
 * adapters. It is imported only by tests, never by `src/`.
 *
 * Highlights the tests rely on:
 * - `tls.dns01` is `false`, exercising the HTTP-01 path.
 * - `seed.supportedTypes` deliberately excludes `trustLevel`, so unsupported
 *   resource-type skip behaviour can be observed.
 * - All members are overridable and dependencies are injected: the in-memory
 *   fake forum (`test/support/fake-forum.ts`, added in task 7.3) is supplied
 *   through an injected {@link SeedClient} factory rather than imported here, so
 *   this module has no hard dependency on it.
 */

import { z } from 'zod';

import type {
  ApplyContext,
  EngineAdapter,
  InstallScriptInput,
  SeedClient,
  SeedClientDeps,
  SeedSupport,
  TlsSupport,
} from '../../src/engines/engine-adapter.js';
import type { ValidationIssue } from '../../src/metadata/errors.js';
import type { EnvironmentModel, ForumModel } from '../../src/metadata/schema.js';
import type {
  ActualState,
  CreateAction,
  ResourceType,
  SeedResource,
  UpdateAction,
} from '../../src/seeder/types.js';

/** Logical secret names the fake engine requires to be present on a forum. */
const DEFAULT_REQUIRED_SECRETS = ['adminPassword', 'apiKey'] as const;

/**
 * Resource types the fake engine supports. Deliberately omits `trustLevel` so
 * tests can assert the reconciler skips unsupported types for this engine.
 */
const DEFAULT_SUPPORTED_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>([
  'setting',
  'group',
  'category',
  'user',
  'membership',
]);

/**
 * TLS capability for the fake engine. `dns01` is `false` (the engine is served
 * through the HTTP-01 challenge) with canonical-looking certificate paths and a
 * no-op reload command.
 */
const DEFAULT_TLS: TlsSupport = {
  dns01: false,
  certPaths: {
    fullchain: '/etc/community-hub/tls/fullchain.pem',
    privkey: '/etc/community-hub/tls/privkey.pem',
  },
  reloadCommand: 'true',
  http01Webroot: '/var/www/acme',
};

/**
 * A permissive but strict options schema: accepts an empty object and rejects
 * unknown keys. Typed as `z.ZodType<unknown>` to match the adapter contract.
 */
const DEFAULT_OPTIONS_SCHEMA: z.ZodType<unknown> = z.strictObject({});

/** An empty actual state, used by the default stub seed client. */
function emptyActualState(): ActualState {
  return { entities: new Map(), memberships: new Map() };
}

/**
 * A minimal stub {@link SeedClient} used when no `seedClientFactory` is
 * injected. It is reachable (`probe` resolves), reports no existing state
 * (`readActual` returns an empty {@link ActualState}) and records the
 * create/update actions passed to `apply` without performing any I/O.
 */
export interface StubSeedClient extends SeedClient {
  /** The create/update actions `apply` was called with, in order. */
  readonly applied: readonly (CreateAction | UpdateAction)[];
}

/** Build the default stub seed client. */
function createStubSeedClient(): StubSeedClient {
  const applied: (CreateAction | UpdateAction)[] = [];
  return {
    applied,
    probe(): Promise<void> {
      return Promise.resolve();
    },
    readActual(desired: readonly SeedResource[]): Promise<ActualState> {
      void desired;
      return Promise.resolve(emptyActualState());
    },
    apply(action: CreateAction | UpdateAction, ctx: ApplyContext): Promise<void> {
      void ctx;
      applied.push(action);
      return Promise.resolve();
    },
  };
}

/** Options for {@link createTestEngine}; every field overrides a default. */
export interface TestEngineOptions {
  /** Override the engine id (default `'testengine'`). */
  readonly id?: string;
  /** Override the minimum RAM in MB (default `512`, so small bundles pass). */
  readonly minRamMb?: number;
  /** Override the set of supported resource types. */
  readonly supportedTypes?: ReadonlySet<ResourceType>;
  /** Override the engine-specific cross-field validation (default: no issues). */
  readonly validate?: (
    forum: ForumModel,
    environment: EnvironmentModel,
  ) => readonly ValidationIssue[];
  /** Override the desired-resource rewrite (default: identity). */
  readonly transformDesired?: (
    resources: readonly SeedResource[],
    forum: ForumModel,
  ) => readonly SeedResource[];
  /**
   * Factory for the {@link SeedClient}, so tests can back the engine with the
   * in-memory fake forum. When omitted, a {@link StubSeedClient} is used.
   */
  readonly seedClientFactory?: (deps: SeedClientDeps) => SeedClient;
}

/** Render a trivial, valid bash script that echoes the host, no secret values. */
function renderTrivialScript(input: InstallScriptInput, purpose: string): string {
  return [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `# testengine ${purpose} for ${input.forumId}`,
    `echo "configuring ${input.hostname}"`,
    '',
  ].join('\n');
}

/**
 * Build a fake {@link EngineAdapter} for tests. All behaviour is overridable
 * through {@link TestEngineOptions}; unset fields use trivial, pure defaults.
 */
export function createTestEngine(options: TestEngineOptions = {}): EngineAdapter {
  const supportedTypes = options.supportedTypes ?? DEFAULT_SUPPORTED_TYPES;
  const validate = options.validate ?? ((): readonly ValidationIssue[] => []);
  const transformDesired =
    options.transformDesired ??
    ((resources: readonly SeedResource[]): readonly SeedResource[] => resources);
  const createClient =
    options.seedClientFactory ??
    ((deps: SeedClientDeps): SeedClient => {
      void deps;
      return createStubSeedClient();
    });

  const seed: SeedSupport = {
    supportedTypes,
    transformDesired,
    createClient,
  };

  return {
    id: options.id ?? 'testengine',
    minRamMb: options.minRamMb ?? 512,
    blueprintId: 'ubuntu_22_04',
    requiredSecrets: DEFAULT_REQUIRED_SECRETS,
    engineOptionsSchema: DEFAULT_OPTIONS_SCHEMA,
    validate,
    tls: DEFAULT_TLS,
    renderInstallScript(input: InstallScriptInput): string {
      return renderTrivialScript(input, 'install');
    },
    renderEmailRefreshScript(input: InstallScriptInput): string {
      return renderTrivialScript(input, 'email refresh');
    },
    seed,
  };
}

/** A ready-made default `testengine` adapter instance. */
export const testEngine: EngineAdapter = createTestEngine();
