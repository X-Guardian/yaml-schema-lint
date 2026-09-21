/** https://nodejs.org/api/http.html */
import { STATUS_CODES } from 'node:http';
/** https://nodejs.org/api/timers.html#timers-promises-api */
import { setTimeout as sleepFor } from 'node:timers/promises';
/** https://www.npmjs.com/package/request-light */
import { xhr, type XHRResponse } from 'request-light';

import {
  RETRYABLE_HTTP_STATUSES,
  SCHEMA_FETCH_BASE_DELAY_MS,
  SCHEMA_FETCH_HEADERS,
  SCHEMA_FETCH_MAX_DELAY_MS,
  SCHEMA_FETCH_MAX_RETRIES,
} from './constants';
import type { SchemaFetchRetryOptions } from './interfaces';
import { consoleDebug } from './utils';

/** Default retry behaviour for schema and catalog fetches. */
export const DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS: SchemaFetchRetryOptions = {
  maxRetries: SCHEMA_FETCH_MAX_RETRIES,
  baseDelayMs: SCHEMA_FETCH_BASE_DELAY_MS,
  maxDelayMs: SCHEMA_FETCH_MAX_DELAY_MS,
  sleep: (ms) => sleepFor(ms),
};

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

/**
 * Fetch a URL with request-light's `xhr`, retrying a bounded number of times when the failure looks temporary.
 *
 * A server-supplied `Retry-After` is honoured in preference to backoff. Either delay is capped at `maxDelayMs`.
 * A failure that is not retryable, or that exhausts the budget, is rethrown unchanged so callers can inspect the
 * original rejection.
 * @param url The URL to fetch
 * @param options Overrides for the retry behaviour; unspecified fields use {@link DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS}
 * @returns The successful response
 */
export async function xhrWithRetry(url: string, options: Partial<SchemaFetchRetryOptions> = {}): Promise<XHRResponse> {
  const retryOptions: SchemaFetchRetryOptions = { ...DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS, ...options };
  const totalAttempts = retryOptions.maxRetries + 1;

  for (let attempt = 0; ; attempt++) {
    try {
      return await xhr({ url, followRedirects: 5, headers: SCHEMA_FETCH_HEADERS });
    } catch (error: unknown) {
      const reason = describeXhrError(error);

      if (attempt >= retryOptions.maxRetries || !isRetryableXhrError(error)) {
        consoleDebug(`Fetch of ${url} failed after ${String(attempt + 1)} attempt(s): ${reason}`);
        throw error;
      }

      const retryAfterMs = isXhrResponse(error) ? parseRetryAfterMs(error.headers) : undefined;
      const delayMs = Math.min(retryAfterMs ?? computeBackoffMs(attempt, retryOptions), retryOptions.maxDelayMs);

      consoleDebug(
        `Fetch attempt ${String(attempt + 1)}/${String(totalAttempts)} of ${url} failed: ${reason}; retrying in ${String(delayMs)}ms`,
      );
      await retryOptions.sleep(delayMs);
    }
  }
}
