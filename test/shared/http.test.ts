import { describe, expect, it } from 'vitest';

import { ForumApiError, ForumUnreachableError } from '../../src/shared/errors.js';
import { createHttpClient, type HttpClientDeps, type HttpRequest } from '../../src/shared/http.js';

/**
 * A recorded call to the fake fetch, capturing the URL and the init options the
 * client passed so tests can assert on method, redirect mode and the abort
 * signal without touching the network.
 */
interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * A deterministic, network-free fake `fetch`. Each invocation consumes the next
 * scripted outcome: either a {@link Response} to return or an error to throw
 * (used to simulate transport failures such as timeouts and redirect refusals).
 * Calls are recorded so tests can assert how many times fetch ran.
 */
function createFakeFetch(outcomes: ReadonlyArray<Response | Error>): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetch = ((input: URL | string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    if (index >= outcomes.length) {
      throw new Error(`fake fetch called more times than scripted (call ${index + 1})`);
    }
    const outcome = outcomes[index];
    index += 1;
    if (outcome instanceof Error) {
      return Promise.reject(outcome);
    }
    return Promise.resolve(outcome as Response);
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A fake `sleep` that records requested delays instead of waiting. */
function createFakeSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  const sleep = (ms: number): Promise<void> => {
    delays.push(ms);
    return Promise.resolve();
  };
  return { sleep, delays };
}

/** Build a JSON {@link Response} with the given status. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An error carrying a Node-style `code`, to simulate transport failures. */
function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** A standard GET request against an https forum URL. */
function getRequest(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    forumId: 'main',
    method: 'GET',
    url: 'https://forum.example.org/admin/x.json',
    ...overrides,
  };
}

/** Build a client from deps, defaulting the fake sleep when omitted. */
function client(deps: Partial<HttpClientDeps> & Pick<HttpClientDeps, 'fetch'>) {
  return createHttpClient({ sleep: createFakeSleep().sleep, ...deps });
}

describe('createHttpClient URL enforcement', () => {
  it('rejects a non-https URL with ForumUnreachableError and zero fetch calls', async () => {
    const { fetch, calls } = createFakeFetch([]);
    const http = client({ fetch });

    await expect(
      http.request(getRequest({ url: 'http://forum.example.org/admin/x.json' })),
    ).rejects.toBeInstanceOf(ForumUnreachableError);
    expect(calls).toHaveLength(0);
  });

  it('rejects a non-https URL with the insecure-protocol cause', async () => {
    const { fetch } = createFakeFetch([]);
    const http = client({ fetch });

    await expect(
      http.request(getRequest({ url: 'http://forum.example.org/' })),
    ).rejects.toMatchObject({
      name: 'ForumUnreachableError',
      forumId: 'main',
      cause: 'ERR_INSECURE_PROTOCOL',
    });
  });

  it('rejects a malformed URL with ForumUnreachableError and zero fetch calls', async () => {
    const { fetch, calls } = createFakeFetch([]);
    const http = client({ fetch });

    await expect(http.request(getRequest({ url: 'not a url' }))).rejects.toMatchObject({
      name: 'ForumUnreachableError',
      cause: 'ERR_INVALID_URL',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('createHttpClient transport failures', () => {
  it('maps a timeout to ForumUnreachableError with ETIMEDOUT', async () => {
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const { fetch, calls } = createFakeFetch([timeout]);
    const http = client({ fetch });

    await expect(http.request(getRequest())).rejects.toMatchObject({
      name: 'ForumUnreachableError',
      cause: 'ETIMEDOUT',
    });
    expect(calls).toHaveLength(1);
  });

  it('maps an abort to ForumUnreachableError with ETIMEDOUT', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { fetch } = createFakeFetch([abort]);
    const http = client({ fetch });

    await expect(http.request(getRequest())).rejects.toMatchObject({
      name: 'ForumUnreachableError',
      cause: 'ETIMEDOUT',
    });
  });

  it('preserves a Node network error code as the cause', async () => {
    const { fetch } = createFakeFetch([codedError('ECONNREFUSED')]);
    const http = client({ fetch });

    await expect(http.request(getRequest())).rejects.toMatchObject({
      name: 'ForumUnreachableError',
      cause: 'ECONNREFUSED',
    });
  });

  it('preserves a TLS certificate error code as the cause', async () => {
    const { fetch } = createFakeFetch([codedError('CERT_HAS_EXPIRED')]);
    const http = client({ fetch });

    await expect(http.request(getRequest())).rejects.toMatchObject({
      name: 'ForumUnreachableError',
      cause: 'CERT_HAS_EXPIRED',
    });
  });

  it('maps a thrown redirect error to ForumUnreachableError (redirect: error)', async () => {
    // fetch with redirect: 'error' throws a TypeError on a redirect response.
    const redirectError = new TypeError('fetch failed: unexpected redirect');
    const { fetch, calls } = createFakeFetch([redirectError]);
    const http = client({ fetch });

    await expect(http.request(getRequest())).rejects.toBeInstanceOf(ForumUnreachableError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe('error');
  });
});

describe('createHttpClient non-2xx handling', () => {
  it('maps a 5xx to ForumApiError and does not retry', async () => {
    const { fetch, calls } = createFakeFetch([jsonResponse(500, { error: 'boom' })]);
    const http = client({ fetch });

    await expect(http.request(getRequest({ method: 'POST' }))).rejects.toMatchObject({
      name: 'ForumApiError',
      forumId: 'main',
      method: 'POST',
      status: 500,
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it('maps a 4xx (non-429) to ForumApiError and does not retry', async () => {
    const { fetch, calls } = createFakeFetch([
      jsonResponse(422, { errors: ['slug has already been taken'] }),
    ]);
    const http = client({ fetch });

    await expect(http.request(getRequest())).rejects.toMatchObject({
      name: 'ForumApiError',
      status: 422,
      attempts: 1,
    });
    expect(calls).toHaveLength(1);
  });

  it('extracts apiMessage from a JSON error body', async () => {
    const { fetch } = createFakeFetch([
      jsonResponse(400, { errors: ['bad slug', 'missing name'] }),
    ]);
    const http = client({ fetch });

    const error = await http.request(getRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForumApiError);
    expect((error as ForumApiError).apiMessage).toBe('bad slug, missing name');
  });

  it('never surfaces an unstructured body (HTML or echoed content) in apiMessage', async () => {
    const echoed = 'token=test-secret-value password=test-secret-value';
    const { fetch } = createFakeFetch([
      new Response(`<html><body>${echoed}</body></html>`, { status: 500 }),
    ]);
    const http = client({ fetch, maxAttempts: 1 });
    const error = await http.request(getRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForumApiError);
    const message = (error as ForumApiError).apiMessage;
    expect(message).not.toContain('test-secret-value');
    expect(message).toBe('error response body omitted (no recognised error field)');
  });

  it('ignores unrecognised JSON fields instead of echoing the whole body', async () => {
    const { fetch } = createFakeFetch([
      jsonResponse(400, { echo: 'test-secret-value', request: { password: 'test-secret-value' } }),
    ]);
    const http = client({ fetch });
    const error = await http.request(getRequest()).catch((e: unknown) => e);
    const message = (error as ForumApiError).apiMessage;
    expect(message).not.toContain('test-secret-value');
  });

  it('extracts the detail from a JSON:API errors array', async () => {
    const { fetch } = createFakeFetch([
      jsonResponse(422, {
        errors: [{ status: '422', code: 'validation_error', detail: 'bad tag' }],
      }),
    ]);
    const http = client({ fetch });
    const error = await http.request(getRequest()).catch((e: unknown) => e);
    expect((error as ForumApiError).apiMessage).toBe('bad tag');
  });

  it('collapses newlines and control characters in apiMessage', async () => {
    const { fetch } = createFakeFetch([jsonResponse(400, { message: 'line one\n\nline\ttwo' })]);
    const http = client({ fetch });
    const error = await http.request(getRequest()).catch((e: unknown) => e);
    expect((error as ForumApiError).apiMessage).toBe('line one line two');
  });

  it('truncates a long apiMessage to 500 characters', async () => {
    const long = 'x'.repeat(1000);
    const { fetch } = createFakeFetch([jsonResponse(400, { message: long })]);
    const http = client({ fetch });

    const error = await http.request(getRequest()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForumApiError);
    expect((error as ForumApiError).apiMessage).toHaveLength(500);
    expect((error as ForumApiError).apiMessage).toBe('x'.repeat(500));
  });
});

describe('createHttpClient success handling', () => {
  it('parses a 2xx JSON body', async () => {
    const { fetch, calls } = createFakeFetch([jsonResponse(200, { id: 7, name: 'moderators' })]);
    const http = client({ fetch });

    const response = await http.request(getRequest());
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 7, name: 'moderators' });
    expect(calls).toHaveLength(1);
  });

  it('returns undefined for an empty 2xx body', async () => {
    const { fetch } = createFakeFetch([new Response('', { status: 200 })]);
    const http = client({ fetch });

    const response = await http.request(getRequest({ method: 'DELETE' }));
    expect(response.status).toBe(200);
    expect(response.body).toBeUndefined();
  });

  it('serializes a JSON request body and sets content-type', async () => {
    const { fetch, calls } = createFakeFetch([jsonResponse(200, { ok: true })]);
    const http = client({ fetch });

    await http.request(getRequest({ method: 'POST', body: { name: 'announcements' } }));
    const init = calls[0]?.init;
    expect(init?.body).toBe(JSON.stringify({ name: 'announcements' }));
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
  });
});
