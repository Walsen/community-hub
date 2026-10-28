import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { exitStatus, summarize } from '../../src/seeder/report.js';
import {
  type ActionResult,
  type ResourceType,
  type RunSummary,
  type SeedResource,
} from '../../src/seeder/types.js';

/**
 * Property 20: Summary counts and exit status.
 *
 * Validates: Requirements 9.4, 9.6
 *
 * `summarize(forumId, results, unreachable)` folds a run's
 * {@link ActionResult}s into a {@link RunSummary} that categorizes each result
 * exactly once and whose counts sum consistently:
 *
 *  - `created`   = results with kind `create` and outcome `applied`;
 *  - `updated`   = kind `update` and outcome `applied`;
 *  - `unchanged` = kind `noop`;
 *  - `skipped`   = kind `skip`;
 *  - `failed`    = outcome `failed` (regardless of kind);
 *  - created + updated + unchanged + skipped + failed === results.length,
 *    when the forum was reachable;
 *  - when `unreachable` is true every count is zero.
 *
 * `exitStatus(summaries)` returns `1` iff some summary has `failed > 0` or is
 * `unreachable`, else `0`.
 *
 * The test recomputes each category independently from the generated results
 * (rather than trusting the implementation's own fold) so the property is a
 * genuine cross-check. A fixed fast-check seed keeps any counterexample
 * reproducible.
 */

const SEED = 0x205c01;

/** Well-formed but arbitrary resource types for generated resources. */
const resourceType: fc.Arbitrary<ResourceType> = fc.constantFrom(
  'setting',
  'group',
  'category',
  'user',
  'membership',
  'trustLevel',
);

/** An arbitrary, well-formed {@link SeedResource} with a scalar desired payload. */
const seedResource: fc.Arbitrary<SeedResource> = fc
  .record({
    type: resourceType,
    naturalKey: fc.string({ minLength: 1, maxLength: 12 }),
    desired: fc.oneof(fc.string({ maxLength: 8 }), fc.integer(), fc.boolean()),
  })
  .map((r) => ({ type: r.type, naturalKey: r.naturalKey, desired: r.desired }));

/**
 * An {@link ActionResult} whose `outcome` is consistent with its `kind`:
 *
 *  - `noop` and `skip` always carry outcome `skipped`;
 *  - `create` and `update` carry either `applied` or `failed`, and a failed
 *    result carries a (body-free) error message.
 *
 * This mirrors how the executor labels outcomes, so the generated space is the
 * space `summarize` actually sees.
 */
const actionResult: fc.Arbitrary<ActionResult> = fc.oneof(
  // noop -> skipped
  seedResource.map((resource): ActionResult => ({ kind: 'noop', resource, outcome: 'skipped' })),
  // skip -> skipped
  fc
    .tuple(seedResource, fc.string({ minLength: 1, maxLength: 20 }))
    .map(([resource, reason]): ActionResult => ({
      kind: 'skip',
      resource,
      reason,
      outcome: 'skipped',
    })),
  // create -> applied | failed
  fc
    .tuple(seedResource, fc.boolean())
    .map(([resource, failed]): ActionResult =>
      failed
        ? { kind: 'create', resource, outcome: 'failed', error: 'create failed' }
        : { kind: 'create', resource, outcome: 'applied' },
    ),
  // update -> applied | failed
  fc
    .tuple(
      seedResource,
      fc.array(fc.record({ field: fc.string(), from: fc.anything(), to: fc.anything() }), {
        maxLength: 3,
      }),
      fc.boolean(),
    )
    .map(([resource, diff, failed]): ActionResult =>
      failed
        ? { kind: 'update', resource, diff, outcome: 'failed', error: 'update failed' }
        : { kind: 'update', resource, diff, outcome: 'applied' },
    ),
);

/** A list of internally-consistent {@link ActionResult}s. */
const actionResults: fc.Arbitrary<readonly ActionResult[]> = fc.array(actionResult, {
  maxLength: 25,
});

/** Count results matching a predicate, computed independently of the implementation. */
function count(results: readonly ActionResult[], pred: (r: ActionResult) => boolean): number {
  return results.reduce((acc, r) => (pred(r) ? acc + 1 : acc), 0);
}

describe('Property 20: Summary counts and exit status', () => {
  it('categorizes each result exactly once and sums to results.length (Req 9.4)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), actionResults, (forumId, results) => {
        const summary = summarize(forumId, results, false);

        const created = count(results, (r) => r.kind === 'create' && r.outcome === 'applied');
        const updated = count(results, (r) => r.kind === 'update' && r.outcome === 'applied');
        const unchanged = count(results, (r) => r.kind === 'noop');
        const skipped = count(results, (r) => r.kind === 'skip');
        const failed = count(results, (r) => r.outcome === 'failed');

        expect(summary.forumId).toBe(forumId);
        expect(summary.unreachable).toBe(false);
        expect(summary.created).toBe(created);
        expect(summary.updated).toBe(updated);
        expect(summary.unchanged).toBe(unchanged);
        expect(summary.skipped).toBe(skipped);
        expect(summary.failed).toBe(failed);

        // Each result is categorized exactly once: the five counts partition the list.
        expect(created + updated + unchanged + skipped + failed).toBe(results.length);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('zeroes every count when the forum is unreachable (Req 9.4)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12 }), actionResults, (forumId, results) => {
        const summary = summarize(forumId, results, true);

        expect(summary).toEqual({
          forumId,
          created: 0,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          failed: 0,
          unreachable: true,
        });
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

/** An arbitrary {@link RunSummary} with non-negative counts and a random reachability. */
const runSummary: fc.Arbitrary<RunSummary> = fc
  .record({
    forumId: fc.string({ minLength: 1, maxLength: 12 }),
    created: fc.nat({ max: 50 }),
    updated: fc.nat({ max: 50 }),
    unchanged: fc.nat({ max: 50 }),
    skipped: fc.nat({ max: 50 }),
    failed: fc.nat({ max: 50 }),
    unreachable: fc.boolean(),
  })
  .map((r): RunSummary =>
    r.unreachable ? { ...r, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 } : r,
  );

describe('Property 20: exit status', () => {
  it('returns 1 iff some summary failed or is unreachable, else 0 (Req 9.4, 9.6)', () => {
    fc.assert(
      fc.property(fc.array(runSummary, { maxLength: 10 }), (summaries) => {
        const anyBad = summaries.some((s) => s.failed > 0 || s.unreachable);
        expect(exitStatus(summaries)).toBe(anyBad ? 1 : 0);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });
});
