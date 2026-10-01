/** https://nodejs.org/api/http.html */
import { STATUS_CODES } from 'node:http';
/** https://nodejs.org/api/timers.html#timers-promises-api */
import { setTimeout as sleepFor } from 'node:timers/promises';
/** https://www.npmjs.com/package/request-light */
import { xhr, type XHRResponse } from 'request-light';

import {
  DEFAULT_MAX_RETRY_WAIT_SECONDS,
  RATE_LIMITED_HTTP_STATUS,
  RETRYABLE_HTTP_STATUSES,
  SCHEMA_FETCH_BASE_DELAY_MS,
  SCHEMA_FETCH_HEADERS,
  SCHEMA_FETCH_MAX_DELAY_MS,
  SCHEMA_FETCH_MAX_RETRIES,
  SCHEMA_FETCH_RATE_LIMIT_BASE_DELAY_MS,
  SCHEMA_FETCH_RATE_LIMIT_MAX_DELAY_MS,
} from './constants';
import type { SchemaFetchRetryOptions } from './interfaces';
import { consoleDebug } from './utils';

/** Default retry behaviour for schema and catalog fetches. */
export const DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS: SchemaFetchRetryOptions = {
  maxRetries: SCHEMA_FETCH_MAX_RETRIES,
  baseDelayMs: SCHEMA_FETCH_BASE_DELAY_MS,
  maxDelayMs: SCHEMA_FETCH_MAX_DELAY_MS,
  rateLimitBaseDelayMs: SCHEMA_FETCH_RATE_LIMIT_BASE_DELAY_MS,
  rateLimitMaxDelayMs: SCHEMA_FETCH_RATE_LIMIT_MAX_DELAY_MS,
  maxTotalDelayMs: DEFAULT_MAX_RETRY_WAIT_SECONDS * 1000,
  sleep: (ms) => sleepFor(ms),
};

/**
 * The final failure of a fetch made by {@link xhrWithRetry}. Its message is the reason for the last failure plus how
 * many attempts were made, so a report shows that retrying happened; the last rejection is kept as `cause`.
 */
export class SchemaFetchError extends Error {
  /**
   * @param cause The rejection from the last attempt
   * @param attempts How many requests were made in total
   * @param note Why retrying stopped early, when it was not for lack of attempts
   */
  constructor(
    cause: unknown,
    readonly attempts: number,
    note?: string,
  ) {
    const details = [attempts > 1 ? `after ${String(attempts)} attempts` : undefined, note].filter(Boolean);
    const reason = describeXhrError(cause);
    super(details.length > 0 ? `${reason} (${details.join('; ')})` : reason, { cause });
    this.name = 'SchemaFetchError';
  }
}

/**
 * Check whether a rejection is the response-shaped object that request-light's `xhr` rejects with.
 * request-light never rejects with an `Error`; both HTTP failures and connection failures arrive as a plain
 * object carrying a numeric `status`.
 * @param error The rejection to inspect
 * @returns True when the value carries a numeric `status`
 */
export function isXhrResponse(error: unknown): error is XHRResponse {
  return typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number';
}

/**
 * Check whether a rejected `xhr` call received no HTTP response at all.
 *
 * request-light synthesizes a response for connection-level failures (refused, reset, DNS, stream errors) with a
 * placeholder status of 404 or 500 and an empty `headers` object. A response that really came from a server always
 * carries headers, so an empty (or missing) `headers` object is the reliable marker of a connection failure.
 * @param response The rejected response object
 * @returns True when the response was synthesized by request-light rather than received from a server
 */
export function isConnectionFailure(response: XHRResponse): boolean {
  const headers: unknown = response.headers;
  return typeof headers !== 'object' || headers === null || Object.keys(headers).length === 0;
}

/**
 * Decide whether a failed `xhr` call is worth repeating.
 * @param error The rejection from `xhr`
 * @returns True when the failure looks temporary: a retryable HTTP status, or no HTTP response was received
 */
export function isRetryableXhrError(error: unknown): boolean {
  if (!isXhrResponse(error)) {
    return false;
  }
  return RETRYABLE_HTTP_STATUSES.includes(error.status) || isConnectionFailure(error);
}

/**
 * Describe a failed `xhr` call in one short line suitable for a diagnostic message.
 *
 * A real HTTP failure is described by its status and reason phrase, e.g. `HTTP 503 Service Unavailable`, rather
 * than by the response body, which is often an HTML error page. A connection failure is described by
 * request-light's own text, e.g. `Unable to connect to <url>. Error: connect ECONNREFUSED ...`.
 * @param error The rejection from `xhr`, or any other thrown value
 * @returns A human-readable reason
 */
export function describeXhrError(error: unknown): string {
  if (isXhrResponse(error)) {
    if (isConnectionFailure(error)) {
      return error.responseText || `HTTP ${String(error.status)}`;
    }
    const reason = STATUS_CODES[error.status];
    return reason ? `HTTP ${String(error.status)} ${reason}` : `HTTP ${String(error.status)}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Parse a `Retry-After` header, which may be given as a number of seconds or as an HTTP date.
 * @param headers The response headers, if any were returned
 * @param nowMs The current time in milliseconds since the epoch, against which an HTTP date is measured
 * @returns The delay in milliseconds, or undefined when the header is absent or unparseable
 */
export function parseRetryAfterMs(headers: unknown, nowMs: number = Date.now()): number | undefined {
  if (typeof headers !== 'object' || headers === null) {
    return undefined;
  }
  const raw: unknown = (headers as Record<string, unknown>)['retry-after'];
  const value: unknown = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  if (typeof value !== 'string' || value.trim() === '') {
    return undefined;
  }

  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    return seconds >= 0 ? seconds * 1000 : undefined;
  }

  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}

/**
 * Compute an exponential backoff delay with equal jitter, so that several fetches failing together do not retry
 * in lockstep. The result lies between half of and the full capped exponential delay.
 * @param attempt The zero-based index of the attempt that just failed
 * @param options The base and maximum delay
 * @returns The delay in milliseconds
 */
export function computeBackoffMs(
  attempt: number,
  options: Pick<SchemaFetchRetryOptions, 'baseDelayMs' | 'maxDelayMs'>,
): number {
  const exponential = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  const half = exponential / 2;
  return Math.round(half + Math.random() * half);
}

/** The outcome of deciding whether, and how long, to wait before the next attempt. */
type RetryPlan = { delayMs: number } | { giveUp: string | undefined };

/**
 * Decide how long to wait before retrying a failed fetch, if at all.
 *
 * A server-supplied `Retry-After` is honoured when it fits in the remaining wait budget; when it does not, the fetch
 * gives up at once rather than retrying before the server said it would succeed. Otherwise a rate-limited (429)
 * response backs off on the slow schedule, which spans a typical per-minute rate-limit window, and other failures on
 * the fast one, which suits momentary outages. A backoff delay is trimmed to the remaining budget.
 * @param error The rejection from `xhr`
 * @param attempt The zero-based index of the attempt that just failed
 * @param remainingMs The wait budget left, in milliseconds
 * @param options The retry behaviour
 * @returns The delay before the next attempt, or a reason to give up (undefined when the reason is obvious)
 */
function planRetry(error: unknown, attempt: number, remainingMs: number, options: SchemaFetchRetryOptions): RetryPlan {
  if (attempt >= options.maxRetries || !isRetryableXhrError(error) || remainingMs <= 0) {
    return { giveUp: undefined };
  }

  const response = error as XHRResponse;
  const retryAfterMs = parseRetryAfterMs(response.headers);
  if (retryAfterMs !== undefined) {
    return retryAfterMs <= remainingMs
      ? { delayMs: retryAfterMs }
      : { giveUp: `server asked to retry in ${formatSeconds(retryAfterMs)}, beyond the retry wait limit` };
  }

  const backoffMs =
    response.status === RATE_LIMITED_HTTP_STATUS
      ? computeBackoffMs(attempt, {
          baseDelayMs: options.rateLimitBaseDelayMs,
          maxDelayMs: options.rateLimitMaxDelayMs,
        })
      : computeBackoffMs(attempt, options);
  return { delayMs: Math.min(backoffMs, remainingMs) };
}

/**
 * Format a duration in milliseconds as whole seconds, rounding up so a short wait never reads as zero.
 * @param ms The duration in milliseconds
 * @returns The duration, e.g. `60s`
 */
function formatSeconds(ms: number): string {
  return `${String(Math.ceil(ms / 1000))}s`;
}

/**
 * Fetch a URL with request-light's `xhr`, retrying a bounded number of times when the failure looks temporary.
 *
 * The total time spent waiting between attempts is capped at `maxTotalDelayMs`; see {@link planRetry} for how each
 * delay is chosen.
 * @param url The URL to fetch
 * @param options Overrides for the retry behaviour; unspecified fields use {@link DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS}
 * @returns The successful response
 * @throws {SchemaFetchError} When the last attempt fails, with that attempt's rejection as `cause`
 */
export async function xhrWithRetry(url: string, options: Partial<SchemaFetchRetryOptions> = {}): Promise<XHRResponse> {
  const retryOptions: SchemaFetchRetryOptions = { ...DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS, ...options };
  const totalAttempts = retryOptions.maxRetries + 1;
  let waitedMs = 0;

  for (let attempt = 0; ; attempt++) {
    try {
      return await xhr({ url, followRedirects: 5, headers: SCHEMA_FETCH_HEADERS });
    } catch (error: unknown) {
      const reason = describeXhrError(error);
      const plan = planRetry(error, attempt, retryOptions.maxTotalDelayMs - waitedMs, retryOptions);

      if ('giveUp' in plan) {
        const note = plan.giveUp ? `; ${plan.giveUp}` : '';
        consoleDebug(`Fetch of ${url} failed after ${String(attempt + 1)} attempt(s): ${reason}${note}`);
        throw new SchemaFetchError(error, attempt + 1, plan.giveUp);
      }

      consoleDebug(
        `Fetch attempt ${String(attempt + 1)}/${String(totalAttempts)} of ${url} failed: ${reason}; retrying in ${String(plan.delayMs)}ms`,
      );
      waitedMs += plan.delayMs;
      await retryOptions.sleep(plan.delayMs);
    }
  }
}
