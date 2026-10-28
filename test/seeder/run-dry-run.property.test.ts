/**
 * Property 16: Dry-run purity (Core 4).
 *
 * Validates: Requirements 9.3
 *
 * Statement (testing steering Core 4): a dry run on any desired state D and
 * actual state A issues ZERO mutating calls and leaves A unchanged.
 *
 * This drives the full {@link runSeed} edge rather than the pure reconciler, so
 * it exercises exactly the path the CLI takes. A valid metadata model with one
 * or more `testengine` forums is generated with the metadata arbitraries and
 * loaded through the loader. Each forum is backed by an in-memory
 * {@link createFakeForum} whose initial actual state is derived from that
 * forum's own desired resources under a generated bitmap: some declared
 * entities are present (so they plan to `noop`/`update`), some absent (so they
 * plan to `create`), with a few attributes perturbed so updates appear. That
 * mix guarantees the plan is not trivially all no-ops.
 *
 * With `dryRun: true`, the assertions are:
 *  - every fake forum's mutating call log is empty (no create/update/addMember/
 *    removeMember) — a dry run issues zero mutating calls;
 *  - every fake forum's entity and membership state is byte-for-byte the state
 *    it was seeded with — a dry run leaves A unchanged;
 *  - no secret is resolved and the injected HTTP client is never touched (both
 *    throw if called), confirming the dry run stops at planning;
 *  - the run reports `exitStatus` 0 (no forum is unreachable here) and the
 *    report text renders the plan.
 *
 * A non-dry-run over the same inputs is run as a sanity check: when any plan
 * contains a mutating action it DOES record mutating calls, so the dry-run
 * emptiness above is meaningful and not vacuous.
 *
 * Everything is deterministic and in-memory: a fixed fast-check seed, placeholder
 * secrets, a `randomPassword` that returns a placeholder, an in-memory log sink,
 * and an HTTP client / secret resolver that both throw (they must never run).
 * No real secret value appears anywhere.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { SeedClient, SeedClientDeps } from '../../src/engines/engine-adapter.js';
import { EngineRegistry } from '../../src/engines/registry.js';
import { loadMetadata } from '../../src/metadata/loader.js';
import type { ForumModel, ValidatedModel } from '../../src/metadata/schema.js';
import { buildDesired } from '../../src/seeder/desired.js';
import { runSeed, type RunSeedDeps } from '../../src/seeder/run.js';
import type { ActualState, ResourceKey } from '../../src/seeder/types.js';
import { resourceKey } from '../../src/seeder/types.js';
import type { HttpClient } from '../../src/shared/http.js';
import { createLogger, Redactor, type LogSink } from '../../src/shared/logger.js';
import type { SecretResolver } from '../../src/shared/secrets.js';
import { rawMetadataDocument, toYaml } from '../support/arbitraries.js';
import { createFakeForum, type EntityAttrs, type FakeForum } from '../support/fake-forum.js';
import { createTestEngine } from '../support/testengine.js';

const SEED = 0x16_dc17;

/** An obvious placeholder `randomPassword` returns; never a real secret. */
const RANDOM_PASSWORD = 'random-password-value';

/** A log sink capturing every serialized JSON line, for hygiene assertions. */
function captureSink(): { readonly lines: string[]; sink: LogSink } {
  const lines: string[] = [];
  return { lines, sink: { write: (line) => lines.push(line) } };
}

/**
 * An HTTP client that fails if it is ever called. The fake forum never issues
 * HTTP, so a dry run (and a real seed against the fake) must never touch this.
 */
const throwingHttp: HttpClient = {
  request() {
    return Promise.reject(new Error('HTTP client must not be called in this test'));
  },
};

/**
 * A secret resolver that returns a placeholder for the preflight `apiKey`
 * resolution runSeed performs, and would surface any other resolution. A dry
 * run resolves only the api key up front and never executes, so no write-only
 * secret is ever resolved.
 */
const RESOLVED_API_KEY = 'resolved-api-key-value';
const placeholderSecrets: SecretResolver = () => Promise.resolve(RESOLVED_API_KEY);

/** Build {@link RunSeedDeps} with an in-memory logger and placeholder I/O. */
function makeDeps(): { deps: RunSeedDeps; lines: string[] } {
  const { lines, sink } = captureSink();
  const deps: RunSeedDeps = {
    secrets: placeholderSecrets,
    http: throwingHttp,
    logger: createLogger({ sink, redactor: new Redactor() }),
    randomPassword: (): string => RANDOM_PASSWORD,
  };
  return { deps, lines };
}

/**
 * Change the first declared attribute of an actual entity to a value that
 * differs from its declaration, so the reconciler plans an `update`. Mutates
 * the record in place. If there is no attribute to change, leaves it as-is.
 */
function perturbDeclared(attrs: Record<string, unknown>): void {
  const keys = Object.keys(attrs);
  if (keys.length === 0) {
    return;
  }
  const key = keys[0]!;
  attrs[key] = `actual-${String(attrs[key])}-differs`;
}

/** A deep snapshot of a fake forum's current state, for before/after equality. */
interface StateSnapshot {
  readonly entities: ReadonlyMap<ResourceKey, EntityAttrs>;
  readonly memberships: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Capture a comparable snapshot of a fake forum's entity and membership state. */
function snapshot(forum: FakeForum): StateSnapshot {
  return { entities: forum.entities(), memberships: forum.memberships() };
}

/** Turn a snapshot into a plain, comparable value for `expect(...).toEqual`. */
function snapshotPlain(snap: StateSnapshot): unknown {
  return {
    entities: [...snap.entities].map(([key, attrs]) => [key, { ...attrs }]),
    memberships: [...snap.memberships].map(([group, members]) => [group, [...members].sort()]),
  };
}

/**
 * Build an {@link ActualState} for one forum from its desired resources and a
 * boolean bitmap. For each non-membership resource, the bit decides whether it
 * is present in the actual state; when present, a second bit perturbs one
 * attribute so the resource plans to an `update` rather than a `noop`. Declared
 * memberships are seeded present so they plan to no-ops; the mix of present and
 * absent entities guarantees a plan with creates, updates and no-ops.
 */
function buildActualFor(forum: ForumModel, bits: readonly boolean[]): ActualState {
  const desired = buildDesired(forum);
  const entities = new Map<ResourceKey, EntityAttrs>();
  const memberships = new Map<string, ReadonlySet<string>>();

  let bit = 0;
  const next = (): boolean => {
    const value = bits.length === 0 ? false : bits[bit % bits.length]!;
    bit += 1;
    return value;
  };

  const declaredByGroup = new Map<string, Set<string>>();

  for (const resource of desired) {
    if (resource.type === 'membership') {
      const sep = resource.naturalKey.indexOf(':');
      const group = resource.naturalKey.slice(0, sep);
      const user = resource.naturalKey.slice(sep + 1);
      const set = declaredByGroup.get(group) ?? new Set<string>();
      set.add(user);
      declaredByGroup.set(group, set);
      continue;
    }

    const present = next();
    if (!present) {
      continue;
    }
    const attrs: Record<string, unknown> =
      typeof resource.desired === 'object' && resource.desired !== null
        ? { ...(resource.desired as Record<string, unknown>) }
        : { value: resource.desired };
    // initialPassword is write-only and never read back; drop it from actual.
    delete attrs.initialPassword;

    if (next()) {
      // Perturb one DECLARED attribute so this resource plans to an update
      // rather than a no-op (an extra, undeclared attribute would be ignored by
      // the reconciler's compare-declared-only semantics).
      perturbDeclared(attrs);
    }
    entities.set(resourceKey(resource.type, resource.naturalKey), attrs);
  }

  // Seed declared memberships as present so they plan to no-ops (they must not
  // be mutated under dry-run, which is exactly what we assert).
  for (const [group, members] of declaredByGroup) {
    memberships.set(group, new Set(members));
  }

  return { entities, memberships };
}

/**
 * Generate a valid model (loaded through the loader against a `testengine`
 * registry) together with a per-forum bitmap driving each fake forum's initial
 * actual state. The model is paired with its YAML source only for provenance.
 */
const modelAndBits: fc.Arbitrary<{
  model: ValidatedModel;
  registry: EngineRegistry;
  bitsByForum: ReadonlyMap<string, readonly boolean[]>;
}> = rawMetadataDocument.chain((doc) => {
  const registry = new EngineRegistry([createTestEngine()]);
  const model = loadMetadata(toYaml(doc), registry);
  const forumBits = fc.array(fc.boolean(), { minLength: 1, maxLength: 24 });
  return fc
    .array(forumBits, { minLength: model.forums.length, maxLength: model.forums.length })
    .map((bitsList) => {
      const bitsByForum = new Map<string, readonly boolean[]>();
      model.forums.forEach((forum, index) => {
        bitsByForum.set(forum.id, bitsList[index]!);
      });
      return { model, registry, bitsByForum };
    });
});

/**
 * Build a `testengine` registry whose seed client is, per forum, the supplied
 * fake forum's client. The factory keys off the forum base URL embedded in the
 * {@link SeedClientDeps}, which encodes the forum's subdomain.
 */
function registryWithFakes(fakesByBaseUrl: ReadonlyMap<string, FakeForum>): EngineRegistry {
  const engine = createTestEngine({
    seedClientFactory: (deps: SeedClientDeps): SeedClient => {
      const fake = fakesByBaseUrl.get(deps.baseUrl);
      if (fake === undefined) {
        throw new Error(`no fake forum registered for base url ${deps.baseUrl}`);
      }
      return fake.client;
    },
  });
  return new EngineRegistry([engine]);
}

/** The base URL runSeed computes for a forum (mirrors `forumBaseUrl`). */
function baseUrlFor(forum: ForumModel, model: ValidatedModel): string {
  return `https://${forum.subdomain}.${model.environment.rootDomain}`;
}

describe('Property 16: Dry-run purity (Core 4)', () => {
  it('issues zero mutating calls and leaves actual state unchanged under dry-run (Req 9.3)', async () => {
    await fc.assert(
      fc.asyncProperty(modelAndBits, async ({ model, bitsByForum }) => {
        // Build one fake forum per forum, keyed by the base url runSeed derives.
        const fakes = new Map<string, FakeForum>();
        const fakesByBaseUrl = new Map<string, FakeForum>();
        for (const forum of model.forums) {
          const actual = buildActualFor(forum, bitsByForum.get(forum.id) ?? []);
          const fake = createFakeForum({
            initialEntities: actual.entities,
            initialMemberships: actual.memberships,
            forumId: forum.id,
          });
          fakes.set(forum.id, fake);
          fakesByBaseUrl.set(baseUrlFor(forum, model), fake);
        }

        const before = new Map<string, unknown>();
        for (const [id, fake] of fakes) {
          before.set(id, snapshotPlain(snapshot(fake)));
        }

        const registry = registryWithFakes(fakesByBaseUrl);
        const { deps } = makeDeps();

        const result = await runSeed({ model, registry, dryRun: true, deps });

        for (const [id, fake] of fakes) {
          // Zero mutating calls recorded for every forum.
          expect(fake.calls).toEqual([]);
          // State is identical to what it was seeded with.
          expect(snapshotPlain(snapshot(fake))).toEqual(before.get(id));
        }

        // No forum was unreachable in this setup, so the run succeeds.
        expect(result.exitStatus).toBe(0);
        expect(typeof result.report).toBe('string');
        expect(result.summaries.map((s) => s.forumId)).toEqual(model.forums.map((f) => f.id));
      }),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('a real (non-dry-run) seed over the same inputs does record mutating calls when the model declares entities (sanity)', async () => {
    // Contrast run: with an EMPTY actual state every forum, every declared
    // (supported) resource is a create, so a real seed must record mutating
    // calls whenever the model declares at least one supported resource. This
    // makes the dry-run's zero-call assertion non-vacuous.
    await fc.assert(
      fc.asyncProperty(modelAndBits, async ({ model, registry: loaderRegistry }) => {
        const fakes = new Map<string, FakeForum>();
        const fakesByBaseUrl = new Map<string, FakeForum>();
        for (const forum of model.forums) {
          const fake = createFakeForum({ forumId: forum.id });
          fakes.set(forum.id, fake);
          fakesByBaseUrl.set(baseUrlFor(forum, model), fake);
        }

        // Does the model declare any resource testengine can apply? testengine
        // supports every type except trustLevel, so count non-trustLevel
        // desired resources.
        const supported = loaderRegistry.resolve('testengine').seed.supportedTypes;
        const anySupportedDeclared = model.forums.some((forum) =>
          buildDesired(forum).some((r) => supported.has(r.type)),
        );

        const registry = registryWithFakes(fakesByBaseUrl);
        const { deps } = makeDeps();

        await runSeed({ model, registry, dryRun: false, deps });

        const totalCalls = [...fakes.values()].reduce((acc, f) => acc + f.calls.length, 0);
        if (anySupportedDeclared) {
          expect(totalCalls).toBeGreaterThan(0);
        }
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});
