/**
 * The pure Seeder reporter.
 *
 * This module folds a run's {@link ActionResult}s into per-forum
 * {@link RunSummary} tallies, decides the process exit status, and renders
 * human-readable output for both a completed run ({@link formatReport}) and a
 * `--dry-run` plan ({@link formatPlan}). It is the reporting half of the
 * "Reconcile: read → pure `plan()` → `execute()`" design (Req 9.4).
 *
 * This module is pure: no I/O, no clock, no randomness, no AWS or forum calls.
 * It only reads its inputs and returns plain data or strings.
 *
 * Secret hygiene: no secret value is ever rendered. Fields named in
 * {@link WRITE_ONLY_FIELDS} (for example a user's `initialPassword` reference)
 * are never printed with a value, even if one somehow reaches a diff; this is a
 * backstop on top of the reconciler already excluding them from comparison.
 */

import { WRITE_ONLY_FIELDS } from './desired.js';
import {
  type ActionResult,
  type FieldDiff,
  type ForumPlan,
  type PlanAction,
  type RunSummary,
} from './types.js';

/**
 * Folds a forum's {@link ActionResult}s into a {@link RunSummary}.
 *
 * Each result is counted once by its `kind` and `outcome`:
 * - a `create` that `applied` → `created`;
 * - an `update` that `applied` → `updated`;
 * - a `noop` → `unchanged`;
 * - a `skip` → `skipped`;
 * - any result whose `outcome` is `failed` → `failed` (and nothing else,
 *   so a `create`/`update` that failed counts only as failed).
 *
 * When `unreachable` is true the forum was never probed and no action ran, so
 * every count is zero regardless of `results`.
 *
 * @param forumId - The forum these results belong to.
 * @param results - The outcome of executing the forum's plan.
 * @param unreachable - Whether the forum could not be probed.
 * @returns The per-forum tally.
 */
export function summarize(
  forumId: string,
  results: readonly ActionResult[],
  unreachable: boolean,
): RunSummary {
  if (unreachable) {
    return {
      forumId,
      created: 0,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      unreachable: true,
    };
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  for (const result of results) {
    if (result.outcome === 'failed') {
      failed += 1;
      continue;
    }
    switch (result.kind) {
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
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }

  return { forumId, created, updated, unchanged, skipped, failed, unreachable: false };
}

/**
 * Decides the CLI exit status from the run's summaries.
 *
 * Returns `1` if any forum reported a failed resource or was unreachable, and
 * `0` otherwise. Exit code `2` is reserved for configuration and secret errors
 * raised before or during a run and is never produced here.
 *
 * @param summaries - The per-forum tallies of the run.
 * @returns `0` when everything succeeded, `1` on any failure or unreachable forum.
 */
export function exitStatus(summaries: readonly RunSummary[]): 0 | 1 {
  for (const summary of summaries) {
    if (summary.failed > 0 || summary.unreachable) {
      return 1;
    }
  }
  return 0;
}

/**
 * Renders the run's summaries as a concise, multi-line human-readable report:
 * one block per forum, each with the forum id, its counts, and an
 * `UNREACHABLE` marker when the forum could not be probed. No secret values
 * appear in the output.
 *
 * @param summaries - The per-forum tallies of the run.
 * @returns The formatted report (no trailing newline).
 */
export function formatReport(summaries: readonly RunSummary[]): string {
  return summaries.map(formatSummaryBlock).join('\n\n');
}

/** Renders a single {@link RunSummary} as a forum id header plus count lines. */
function formatSummaryBlock(summary: RunSummary): string {
  const lines: string[] = [];
  if (summary.unreachable) {
    lines.push(`${summary.forumId}: UNREACHABLE`);
    return lines.join('\n');
  }
  lines.push(`${summary.forumId}:`);
  lines.push(`  created:   ${summary.created}`);
  lines.push(`  updated:   ${summary.updated}`);
  lines.push(`  unchanged: ${summary.unchanged}`);
  lines.push(`  skipped:   ${summary.skipped}`);
  lines.push(`  failed:    ${summary.failed}`);
  return lines.join('\n');
}

/**
 * Renders a {@link ForumPlan} as a dry-run preview string: one line per action
 * showing its kind, resource type and natural key, with update actions listing
 * each diffed field and its `from → to` values, and skip actions showing their
 * reason.
 *
 * A field named in {@link WRITE_ONLY_FIELDS} is never rendered with a value —
 * its diff is shown as a bare field name — so a write-only secret reference can
 * never leak into the output.
 *
 * @param plan - The forum's planned actions.
 * @returns The formatted plan (no trailing newline).
 */
export function formatPlan(plan: ForumPlan): string {
  const lines: string[] = [`${plan.forumId}:`];
  for (const action of plan.actions) {
    lines.push(...formatAction(action));
  }
  return lines.join('\n');
}

/** Renders a single {@link PlanAction} as one or more indented lines. */
function formatAction(action: PlanAction): string[] {
  const { type, naturalKey } = action.resource;
  const head = `  ${action.kind} ${type} ${naturalKey}`;
  switch (action.kind) {
    case 'create':
    case 'noop':
      return [head];
    case 'skip':
      return [`${head} (skipped: ${action.reason})`];
    case 'update':
      return [head, ...action.diff.map((diff) => `      ${formatDiff(diff)}`)];
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/**
 * Renders one {@link FieldDiff}. For a write-only field only the field name is
 * shown; for any other field the `from → to` values are rendered.
 */
function formatDiff(diff: FieldDiff): string {
  if (WRITE_ONLY_FIELDS.has(diff.field)) {
    return diff.field;
  }
  return `${diff.field}: ${renderValue(diff.from)} -> ${renderValue(diff.to)}`;
}

/** Renders an arbitrary diff value as a compact, side-effect-free string. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}
