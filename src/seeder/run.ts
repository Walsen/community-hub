/**
 * Seeder run orchestration.
 *
 * {@link runSeed} drives one seeding run end to end: it selects the forums to
 * reconcile, resolves their admin API keys up front, then — forum by forum,
 * sequentially — reads actual state, computes a pure {@link module:seeder/reconciler.plan | plan},
 * and either prints the plan (`--dry-run`) or executes it. It is the edge that
 * ties the pure pieces (`buildDesired`, `plan`, `summarize`, `formatReport`,
 * `formatPlan`) to the injected I/O (secret resolution, forum HTTP clients).
 *
 * Boundaries this module preserves (architecture steering):
 * - It makes no AWS or infrastructure calls. Secrets are read only through the
 *   injected {@link module:shared/secrets.SecretResolver}; forum state and
 *   mutations go only through the engine's {@link SeedClient}.
 * - No secret value is logged, printed or placed on a result. Resolved API keys
 *   stay in local variables and reach the client as its `apiKey` dependency.
 * - Planning and reporting are delegated to the pure reconciler and reporter.
 */

import type { EngineRegistry } from '../engines/registry.js';
import type { SeedClient, SeedClientDeps } from '../engines/engine-adapter.js';
import type { ForumModel, ValidatedModel } from '../metadata/schema.js';
import type { SecretReference } from '../metadata/secret-ref.js';
import {
  SecretResolutionError,
  ForumUnreachableError,
  UnknownForumError,
} from '../shared/errors.js';
import type { HttpClient } from '../shared/http.js';
import type { Logger } from '../shared/logger.js';
import type { SecretResolver } from '../shared/secrets.js';

import { buildDesired } from './desired.js';
import { execute } from './executor.js';
import { plan } from './reconciler.js';
import { exitStatus, formatPlan, formatReport, summarize } from './report.js';
import type { ForumPlan, RunSummary } from './types.js';

/** Injected dependencies for {@link runSeed}. */
export interface RunSeedDeps {
  /** Resolves a Secret_Reference to its value, at the edge, just in time. */
  readonly secrets: SecretResolver;
  /** HTTPS-only JSON client the forum seed clients issue requests through. */
  readonly http: HttpClient;
  /** Redacting logger; never receives secret values or request/response bodies. */
  readonly logger: Logger;
  /** Generates a fresh random password for a user with no declared one. */
  readonly randomPassword: () => string;
}

/** Input to {@link runSeed}. */
export interface RunSeedInput {
  /** The validated, expanded metadata model. */
  readonly model: ValidatedModel;
  /** The engine registry used to resolve each forum's adapter. */
  readonly registry: EngineRegistry;
  /** Optional `--forum` filter; when set, only that forum is reconciled. */
  readonly forumId?: string;
  /** When true, stop after planning and print the plan without mutating. */
  readonly dryRun: boolean;
  /** Injected I/O dependencies. */
  readonly deps: RunSeedDeps;
}

/** The outcome of a {@link runSeed} call. */
export interface RunSeedResult {
  /** Per-forum tallies, in the order the forums were processed. */
  readonly summaries: RunSummary[];
  /** `0` when everything succeeded, `1` on any failure or unreachable forum. */
  readonly exitStatus: 0 | 1;
  /** Human-readable output: the completed-run report, or the dry-run plan text. */
  readonly report: string;
}

/**
 * Runs the Seeder against the selected forums and returns the summaries, the
 * CLI exit status and the human-readable report.
 *
 * Behaviour:
 * 1. Select forums — all of them, or just the one matching `forumId`. An
 *    unknown `forumId` throws {@link UnknownForumError} (the CLI maps this to
 *    exit 2); nothing is probed or mutated.
 * 2. Preflight — resolve every selected forum's `apiKey` reference before any
 *    forum API call. A failure propagates as {@link SecretResolutionError}, so
 *    the run aborts before touching any forum (exit 2).
 * 3. Per forum, sequentially — build the seed client, `probe()`, read actual
 *    state and compute a plan. A forum that is unreachable is recorded with
 *    `unreachable: true` and skipped; the run continues with the next forum.
 * 4. Dry-run — do not execute: the report is each forum's plan rendered by
 *    {@link module:seeder/report.formatPlan}, and the summaries count the
 *    planned actions (create/update are reported as created/updated even though
 *    nothing was applied). Only `GET` requests have been issued.
 * 5. Otherwise — {@link module:seeder/executor.execute} the plan; the executor
 *    resolves any write-only secret just in time via the injected resolver.
 *
 * @param input - The model, registry, optional forum filter, dry-run flag and
 *   injected dependencies. See {@link RunSeedInput}.
 * @returns The per-forum summaries, exit status and report.
 * @throws UnknownForumError when `forumId` matches no forum.
 * @throws SecretResolutionError when a selected forum's `apiKey` cannot resolve.
 */
export async function runSeed(input: RunSeedInput): Promise<RunSeedResult> {
  const { model, registry, forumId, dryRun, deps } = input;

  const forums = selectForums(model.forums, forumId);

  // Preflight: resolve every selected forum's API key before any forum API
  // call, so a secret failure aborts the run before any forum is touched.
  const apiKeys = new Map<string, string>();
  for (const forum of forums) {
    apiKeys.set(forum.id, await deps.secrets(apiKeyReference(forum)));
  }

  const summaries: RunSummary[] = [];
  const plans: ForumPlan[] = [];

  for (const forum of forums) {
    const adapter = registry.resolve(forum.engine);
    const apiKey = apiKeys.get(forum.id);
    // apiKey is guaranteed present: preflight resolved one key per forum.
    if (apiKey === undefined) {
      throw new SecretResolutionError({
        reference: formatApiKeyReference(forum),
        reason: 'unknown',
      });
    }

    const clientDeps: SeedClientDeps = {
      baseUrl: forumBaseUrl(forum, model),
      apiKey,
      http: deps.http,
      logger: deps.logger,
    };
    const client: SeedClient = adapter.seed.createClient(clientDeps);

    try {
      await client.probe();
    } catch (error) {
      if (error instanceof ForumUnreachableError) {
        summaries.push(summarize(forum.id, [], true));
        continue;
      }
      throw error;
    }

    const desired = adapter.seed.transformDesired(buildDesired(forum), forum);
    const actual = await client.readActual(desired);
    const forumPlan = plan({
      forumId: forum.id,
      engineId: forum.engine,
      supportedTypes: adapter.seed.supportedTypes,
      desired,
      actual,
    });

    if (dryRun) {
      plans.push(forumPlan);
      summaries.push(summarizePlan(forumPlan));
      continue;
    }

    const results = await execute(forumPlan, client, {
      secrets: deps.secrets,
      randomPassword: deps.randomPassword,
      logger: deps.logger,
    });
    summaries.push(summarize(forum.id, results, false));
  }

  const report = dryRun ? plans.map(formatPlan).join('\n\n') : formatReport(summaries);

  return { summaries, exitStatus: exitStatus(summaries), report };
}

/**
 * Selects the forums to reconcile. With no filter, every forum is returned in
 * declaration order; with a filter, just the one forum whose id matches.
 *
 * @throws UnknownForumError naming the unknown id and the known ids.
 */
function selectForums(
  forums: readonly ForumModel[],
  forumId: string | undefined,
): readonly ForumModel[] {
  if (forumId === undefined) {
    return forums;
  }
  const match = forums.find((forum) => forum.id === forumId);
  if (match === undefined) {
    throw new UnknownForumError({ forumId, known: forums.map((forum) => forum.id) });
  }
  return [match];
}

/**
 * The `apiKey` Secret_Reference for a forum. The loader guarantees `apiKey` is
 * present; if it is somehow absent, resolution fails as `not_found` naming the
 * reference rather than leaking an undefined into the resolver.
 */
function apiKeyReference(forum: ForumModel): SecretReference {
  const ref = forum.secrets.apiKey;
  if (ref === undefined) {
    throw new SecretResolutionError({
      reference: formatApiKeyReference(forum),
      reason: 'not_found',
    });
  }
  return ref;
}

/** A body-free reference label for a forum's missing API key, for errors. */
function formatApiKeyReference(forum: ForumModel): string {
  return `apiKey of forum '${forum.id}'`;
}

/** The forum's base URL, `https://<subdomain>.<rootDomain>`. */
function forumBaseUrl(forum: ForumModel, model: ValidatedModel): string {
  return `https://${forum.subdomain}.${model.environment.rootDomain}`;
}

/**
 * Builds a {@link RunSummary} for a dry run from a forum's plan, counting what
 * each action *would* do: `create` → created, `update` → updated, `noop` →
 * unchanged, `skip` → skipped. A dry run issues no mutating calls, so nothing
 * failed and the forum was reachable (`unreachable: false`).
 */
function summarizePlan(forumPlan: ForumPlan): RunSummary {
  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const action of forumPlan.actions) {
    switch (action.kind) {
      case 'create':
        created += 1;
        break;
      case 'update':
        updated += 1;
        break;
      case 'noop':
        unchanged += 1;
        break;
      case 'skip':
        skipped += 1;
        break;
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  return {
    forumId: forumPlan.forumId,
    created,
    updated,
    unchanged,
    skipped,
    failed: 0,
    unreachable: false,
  };
}
