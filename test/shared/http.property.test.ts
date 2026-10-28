/**
 * Property test for the HTTPS client's HTTP 429 retry with exponential backoff.
 *
 * Property 21: 429 retry with exponential backoff. Validates Requirements 9.7.
 *
 * For any k in 0..10 429 responses followed by a terminal response, the client
 * makes `min(k + 1, maxAttempts)` attempts; it succeeds when fewer than
 * `maxAttempts` 429s precede a 2xx and throws `ForumApiError` once the final
 * allowed attempt still sees a 429; and the n-th recorded backoff delay equals
 * `min(maxDelayMs, max(retryAfter_n, baseDelayMs * 2^(n-1)))`, honoring a
 * `Retry-After` header when present.
 *
 * The test injects a scripted fake `fetch` and a fake `sleep` that records
 * delays, so there is no real network access and no real timers. fast-check is
 * configured so a counterexample reports a reproducible seed.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createHttpClient, type HttpRequest } from '../../src/shared/http.js';
import { ForumApiError } from '../../src/shared/errors.js';
import { createFakeFetch, createFakeSleep, type ScriptedResponse } from '../support/fake-http.js';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

const BASE_REQUEST: HttpRequest = {
  forumId: 'main',
  method: 'GET',
  url: 'https://forum.example.org/admin/api.json',
};

/** The expected backoff delay for attempt `n` (1-based) given its Retry-After seconds. */
function expectedDelayMs(attempt: number, retryAfterSeconds: number | undefined): number {
  const retryAfterMs = retryAfterSeconds === undefined ? 0 : retryAfterSeconds * 1_000;
  const backoffMs = BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.min(MAX_DELAY_MS, Math.max(retryAfterMs, backoffMs));
}

/**
 * Build the scripted response queue: `retryAfters.length` 429 responses, each
 * carrying the given optional `Retry-After` header, followed by one terminal
 * response.
 */
function scriptResponses(
  retryAfters: readonly (number | undefined)[],
  terminal: ScriptedResponse,
): ScriptedResponse[] {
  const tooManyRequests = retryAfters.map((seconds): ScriptedResponse =>
    seconds === undefined
      ? { status: 429 }
      : { status: 429, headers: { 'retry-after': String(seconds) } },
  );
  return [...tooManyRequests, terminal];
}

describe('Property 21: 429 retry with exponential backoff', () => {
  it('retries up to maxAttempts, succeeds before the limit, and uses the backoff schedule', async () => {
    const retryAfterArb = fc.option(fc.integer({ min: 0, max: 120 }), { nil: undefined });

    await fc.assert(
      fc.asyncProperty(
        fc.array(retryAfterArb, { minLength: 0, maxLength: 10 }),
        async (retryAfters) => {
          // The client only sleeps between retries, so Retry-After values past
          // the last attempt it is willing to make never affect behavior.
          const consumed429s = Math.min(retryAfters.length, MAX_ATTEMPTS - 1);
          const succeeds = retryAfters.length < MAX_ATTEMPTS;

          const terminal: ScriptedResponse = succeeds
            ? { status: 200, body: { ok: true } }
            : { status: 429 };
          const fakeFetch = createFakeFetch(scriptResponses(retryAfters, terminal));
          const fakeSleep = createFakeSleep();

          const client = createHttpClient({
            fetch: fakeFetch.fetch,
            sleep: fakeSleep.sleep,
            maxAttempts: MAX_ATTEMPTS,
            baseDelayMs: BASE_DELAY_MS,
            maxDelayMs: MAX_DELAY_MS,
          });

          if (succeeds) {
            const response = await client.request(BASE_REQUEST);
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ ok: true });
          } else {
            let thrown: unknown;
            try {
              await client.request(BASE_REQUEST);
            } catch (error) {
              thrown = error;
            }
            expect(thrown).toBeInstanceOf(ForumApiError);
            const apiError = thrown as ForumApiError;
            expect(apiError.status).toBe(429);
            expect(apiError.attempts).toBe(MAX_ATTEMPTS);
          }

          // Attempts never exceed maxAttempts, and a 2xx after some 429s is
          // reached exactly one attempt after the last consumed 429.
          const expectedAttempts = succeeds ? retryAfters.length + 1 : MAX_ATTEMPTS;
          expect(expectedAttempts).toBeLessThanOrEqual(MAX_ATTEMPTS);
          expect(fakeFetch.requests).toHaveLength(expectedAttempts);

          // One sleep per retry; each equals the formula for its attempt index.
          expect(fakeSleep.delays).toHaveLength(consumed429s);
          for (let attempt = 1; attempt <= consumed429s; attempt += 1) {
            expect(fakeSleep.delays[attempt - 1]).toBe(
              expectedDelayMs(attempt, retryAfters[attempt - 1]),
            );
          }
        },
      ),
      { seed: 0x5eed, numRuns: 500 },
    );
  });
});
