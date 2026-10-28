/**
 * HTTPS-only JSON HTTP client used by the Seeder's forum admin API calls.
 *
 * The client refuses any non-`https:` URL before touching the network, uses an
 * {@link AbortSignal.timeout}-based request timeout, rejects redirects, and
 * parses request and response bodies as JSON. It retries only HTTP 429 with
 * deterministic exponential backoff (no jitter) up to a bounded number of
 * attempts. Network, DNS, TLS and timeout failures become
 * {@link ForumUnreachableError}; other non-2xx responses become
 * {@link ForumApiError} without retry.
 *
 * All dependencies (`fetch`, `sleep`) are injected so tests can supply fakes
 * with no real network access or timers. Request bodies and headers are never
 * logged or otherwise surfaced.
 */

import { ForumApiError, ForumUnreachableError, MAX_API_MESSAGE_LENGTH } from './errors.js';

/** HTTP method supported by the forum admin REST APIs. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * A single HTTPS request. `forumId` identifies the Forum_Instance so failures
 * can be mapped to typed errors; `body`, when present, is serialized as JSON.
 */
export interface HttpRequest {
  readonly forumId: string;
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

/** A successful (2xx) HTTP response with its JSON-parsed body. */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/** Issues a single request, applying HTTPS enforcement, timeout and 429 retry. */
export interface HttpClient {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** Injected dependencies and tuning for {@link createHttpClient}. */
export interface HttpClientDeps {
  /** Underlying fetch implementation (injected so tests can fake it). */
  readonly fetch: typeof globalThis.fetch;
  /** Delay primitive (injected so tests avoid real timers). */
  readonly sleep: (ms: number) => Promise<void>;
  /** Per-request timeout in milliseconds. Default 15000. */
  readonly timeoutMs?: number;
  /** Maximum number of attempts for a 429-retried request. Default 5. */
  readonly maxAttempts?: number;
  /** Base backoff delay in milliseconds. Default 1000. */
  readonly baseDelayMs?: number;
  /** Upper bound on any single backoff delay in milliseconds. Default 30000. */
  readonly maxDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Create an HTTPS-only JSON HTTP client bound to the given dependencies.
 *
 * @param deps - Injected `fetch` and `sleep` plus optional timeout and backoff tuning.
 * @returns A {@link HttpClient} whose `request` enforces HTTPS, applies a
 *   timeout, rejects redirects, parses JSON, and retries HTTP 429 with
 *   exponential backoff.
 */
export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  async function request(req: HttpRequest): Promise<HttpResponse> {
    // Reject non-https URLs before any network call. A malformed URL is treated
    // the same way: it is not an https endpoint we are willing to call.
    assertHttpsUrl(req);

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const response = await fetchOnce(deps.fetch, req, timeoutMs);

      if (response.status === 429 && attempt < maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
        const backoffMs = baseDelayMs * 2 ** (attempt - 1);
        const delayMs = Math.min(maxDelayMs, Math.max(retryAfterMs, backoffMs));
        await deps.sleep(delayMs);
        continue;
      }

      if (response.status >= 200 && response.status <= 299) {
        return {
          status: response.status,
          headers: response.headers,
          body: await parseJsonBody(response, req, attempt),
        };
      }

      // Any other non-2xx response (including a 429 after the final attempt)
      // maps to ForumApiError without further retry.
      throw new ForumApiError({
        forumId: req.forumId,
        method: req.method,
        path: pathOf(req.url),
        status: response.status,
        apiMessage: await readApiMessage(response),
        attempts: attempt,
      });
    }
  }

  return { request };
}

/**
 * Throw {@link ForumUnreachableError} unless `req.url` is a syntactically valid
 * `https:` URL. Runs before any network call.
 */
function assertHttpsUrl(req: HttpRequest): void {
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    throw new ForumUnreachableError({
      forumId: req.forumId,
      url: req.url,
      cause: 'ERR_INVALID_URL',
    });
  }
  if (parsed.protocol !== 'https:') {
    throw new ForumUnreachableError({
      forumId: req.forumId,
      url: req.url,
      cause: 'ERR_INSECURE_PROTOCOL',
    });
  }
}

/**
 * Perform one fetch with a timeout and no redirect following, mapping transport
 * failures to {@link ForumUnreachableError}.
 */
async function fetchOnce(
  fetchImpl: typeof globalThis.fetch,
  req: HttpRequest,
  timeoutMs: number,
): Promise<Response> {
  const headers = new Headers(req.headers);
  let body: string | undefined;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.body = body;
  }

  try {
    return await fetchImpl(req.url, init);
  } catch (error) {
    throw new ForumUnreachableError({
      forumId: req.forumId,
      url: req.url,
      cause: transportCause(error),
    });
  }
}

/**
 * Classify a thrown transport error into a short cause code for
 * {@link ForumUnreachableError}. Prefers a Node error `code` (for example
 * `ENOTFOUND`, `ECONNREFUSED`, a `CERT_*` TLS code), falls back to the abort
 * reason for timeouts, then the error `name`, then a generic code. Never
 * surfaces request or response bodies.
 */
function transportCause(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) {
      return code;
    }
    const name = (error as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return 'ETIMEDOUT';
    }
    if (typeof name === 'string' && name.length > 0) {
      return name;
    }
  }
  return 'ERR_NETWORK';
}

/**
 * Parse a `Retry-After` header expressed in seconds into milliseconds. Returns
 * `0` when the header is absent or not a non-negative number (HTTP-date form is
 * not honored).
 */
function parseRetryAfterMs(retryAfter: string | null): number {
  if (retryAfter === null) {
    return 0;
  }
  const seconds = Number(retryAfter.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 0;
  }
  return seconds * 1_000;
}

/**
 * Parse a successful response body as JSON. An empty body parses to
 * `undefined`; a non-JSON body maps to {@link ForumUnreachableError} because a
 * well-behaved admin API that returned 2xx should return JSON.
 */
async function parseJsonBody(
  response: Response,
  req: HttpRequest,
  attempt: number,
): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ForumApiError({
      forumId: req.forumId,
      method: req.method,
      path: pathOf(req.url),
      status: response.status,
      apiMessage: 'response body was not valid JSON',
      attempts: attempt,
    });
  }
}

/**
 * Extract a short, body-free API message from a non-2xx response for
 * {@link ForumApiError}. Prefers a JSON `errors`/`error`/`message` field, falls
 * back to the raw text, and truncates to the error's maximum. Never logs.
 */
async function readApiMessage(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return '';
  }
  if (text.length === 0) {
    return '';
  }
  const message = extractMessage(text);
  // Collapse control characters and whitespace runs so a message cannot smuggle
  // multi-line content into logs, then apply the length cap.
  return message
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_API_MESSAGE_LENGTH);
}

/** Message used when an error body has no recognised error field. */
const UNSTRUCTURED_BODY_MESSAGE = 'error response body omitted (no recognised error field)';

/**
 * Pull a human-readable message out of a JSON error body, but ONLY from the
 * documented error fields (`errors`, `error`, `message`, `detail`, including
 * JSON:API `errors[].detail|title`). A body that is not JSON, or has none of
 * those fields (an HTML page, or a forum echoing the request back), is NEVER
 * surfaced verbatim: it could carry a value we did not register with the
 * redactor. A fixed marker is returned instead.
 */
function extractMessage(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return UNSTRUCTURED_BODY_MESSAGE;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return UNSTRUCTURED_BODY_MESSAGE;
  }
  const record = parsed as Record<string, unknown>;
  const errors = record['errors'];
  if (Array.isArray(errors) && errors.length > 0) {
    // Discourse: ["msg", ...]. Flarum (JSON:API): [{ detail|title|code }, ...].
    const parts = errors
      .map((entry): string | undefined => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (typeof entry === 'object' && entry !== null) {
          const e = entry as Record<string, unknown>;
          for (const key of ['detail', 'title', 'code'] as const) {
            const value = e[key];
            if (typeof value === 'string' && value.length > 0) {
              return value;
            }
          }
        }
        return undefined;
      })
      .filter((part): part is string => part !== undefined);
    if (parts.length > 0) {
      return parts.join(', ');
    }
  }
  for (const key of ['error', 'message', 'detail'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return UNSTRUCTURED_BODY_MESSAGE;
}

/** The path (plus query) of a URL, for error context. Falls back to the raw URL. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
