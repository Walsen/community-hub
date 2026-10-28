/**
 * Test doubles for the HTTPS client's injected `fetch` and `sleep`.
 *
 * These fakes keep the default test suite free of network access and real
 * timers (see the testing steering): a scripted fetch returns a prepared queue
 * of responses and records every request it received; a fake sleep resolves
 * immediately and records each delay it was asked to wait. Nothing here touches
 * the network, the clock, or global state.
 */

/** A single scripted HTTP response the fake fetch will return, in order. */
export interface ScriptedResponse {
  /** HTTP status code to report. */
  readonly status: number;
  /** Response body. A non-string is JSON-encoded; `undefined` is an empty body. */
  readonly body?: unknown;
  /** Response headers (for example a `Retry-After` on a 429). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A request the fake fetch observed, captured for later assertions. */
export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

/** A scripted `fetch` plus the requests it recorded. */
export interface FakeFetch {
  /** Drop-in replacement for `globalThis.fetch`. */
  readonly fetch: typeof globalThis.fetch;
  /** Requests observed so far, in call order. */
  readonly requests: readonly RecordedRequest[];
}

/**
 * Build a fake `fetch` that returns `responses` in order, one per call, and
 * records each request. Calling it more times than there are scripted
 * responses throws, which surfaces an unexpected extra attempt in a test.
 *
 * @param responses - Responses to return on successive calls, in order.
 * @returns A {@link FakeFetch} exposing the `fetch` function and recorded requests.
 */
export function createFakeFetch(responses: readonly ScriptedResponse[]): FakeFetch {
  const requests: RecordedRequest[] = [];
  let index = 0;

  const fetch = ((
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    const recordedHeaders: Record<string, string> = {};
    headers.forEach((value, key) => {
      recordedHeaders[key] = value;
    });
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: recordedHeaders,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const scripted = responses[index];
    index += 1;
    if (scripted === undefined) {
      throw new Error(
        `fake fetch called ${String(index)} time(s) but only ${String(responses.length)} response(s) were scripted`,
      );
    }

    const bodyText =
      scripted.body === undefined
        ? ''
        : typeof scripted.body === 'string'
          ? scripted.body
          : JSON.stringify(scripted.body);
    const responseInit: ResponseInit = {
      status: scripted.status,
      ...(scripted.headers !== undefined ? { headers: scripted.headers } : {}),
    };
    return Promise.resolve(new Response(bodyText.length === 0 ? null : bodyText, responseInit));
  }) as typeof globalThis.fetch;

  return {
    fetch,
    get requests() {
      return requests;
    },
  };
}

/** A fake `sleep` plus the delays it was asked to wait, in order. */
export interface FakeSleep {
  /** Drop-in replacement for an injected `sleep(ms)`; resolves immediately. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Delays (in ms) requested so far, in call order. */
  readonly delays: readonly number[];
}

/**
 * Build a fake `sleep` that never actually waits but records every requested
 * delay, so tests can assert the backoff schedule without real timers.
 *
 * @returns A {@link FakeSleep} exposing the `sleep` function and recorded delays.
 */
export function createFakeSleep(): FakeSleep {
  const delays: number[] = [];
  return {
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    },
    get delays() {
      return delays;
    },
  };
}
