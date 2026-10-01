/** https://www.npmjs.com/package/request-light */
import type { XHRResponse } from 'request-light';

import { SCHEMA_FETCH_MAX_RETRIES } from './constants';
import {
  DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS,
  SchemaFetchError,
  computeBackoffMs,
  describeXhrError,
  isConnectionFailure,
  isRetryableXhrError,
  isXhrResponse,
  parseRetryAfterMs,
  xhrWithRetry,
} from './schema-request';
import * as utils from './utils';

jest.mock('request-light', () => ({
  xhr: jest.fn(),
  getErrorStatusDescription: jest.fn(),
}));

const { xhr } = jest.requireMock<{ xhr: jest.Mock }>('request-light');
const consoleDebugSpy = jest.spyOn(utils, 'consoleDebug').mockImplementation();

const URL = 'https://example.com/schema.json';

/** Headers a real HTTP response always carries. */
const REAL_HEADERS = { date: 'Sat, 19 Sep 2026 09:00:00 GMT', connection: 'close' };

/** Delays requested from the injected sleep, in order. */
const delays: number[] = [];
const sleep = jest.fn((ms: number): Promise<void> => {
  delays.push(ms);
  return Promise.resolve();
});

/**
 * Build the plain object request-light rejects with for an HTTP error response.
 * @param status The HTTP status
 * @param headers Response headers; defaults to those of a real response
 * @param responseText Response body
 * @returns A rejection value shaped like request-light's XHRResponse
 */
function httpFailure(status: number, headers: XHRResponse['headers'] = REAL_HEADERS, responseText = ''): XHRResponse {
  return { status, headers, responseText, body: new Uint8Array() };
}

/**
 * Build the plain object request-light rejects with when no HTTP response was received.
 * @param message The underlying socket or DNS error message
 * @returns A rejection value shaped like request-light's synthesized XHRResponse
 */
function connectionFailure(message: string): XHRResponse {
  return {
    status: 404,
    headers: {},
    responseText: `Unable to connect to ${URL}. Error: ${message}`,
    body: new Uint8Array(),
  };
}

const success: XHRResponse = {
  status: 200,
  headers: REAL_HEADERS,
  responseText: '{"type":"object"}',
  body: new Uint8Array(),
};

beforeEach(() => {
  jest.clearAllMocks();
  xhr.mockReset();
  delays.length = 0;
  jest.spyOn(Math, 'random').mockReturnValue(0.5);
});

describe('isXhrResponse', () => {
  it('recognises an object with a numeric status', () => {
    expect(isXhrResponse(httpFailure(503))).toBe(true);
    expect(isXhrResponse(connectionFailure('socket hang up'))).toBe(true);
  });

  it('rejects errors, strings and nullish values', () => {
    expect(isXhrResponse(new Error('boom'))).toBe(false);
    expect(isXhrResponse('boom')).toBe(false);
    expect(isXhrResponse(undefined)).toBe(false);
    expect(isXhrResponse(null)).toBe(false);
    expect(isXhrResponse({ status: '503' })).toBe(false);
  });
});

describe('isConnectionFailure', () => {
  it('is true when the response carries no headers', () => {
    expect(isConnectionFailure(connectionFailure('connect ECONNREFUSED'))).toBe(true);
    expect(
      isConnectionFailure({ status: 500, headers: undefined as never, responseText: '', body: new Uint8Array() }),
    ).toBe(true);
  });

  it('is false for a response that came from a server', () => {
    expect(isConnectionFailure(httpFailure(404))).toBe(false);
  });
});

describe('isRetryableXhrError', () => {
  it.each([429, 500, 502, 503, 504])('retries HTTP %i', (status) => {
    expect(isRetryableXhrError(httpFailure(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 501])('does not retry HTTP %i from a server', (status) => {
    expect(isRetryableXhrError(httpFailure(status))).toBe(false);
  });

  it('retries connection-level failures synthesized by request-light', () => {
    expect(isRetryableXhrError(connectionFailure('connect ECONNREFUSED 127.0.0.1:443'))).toBe(true);
    expect(isRetryableXhrError(connectionFailure('socket hang up'))).toBe(true);
    expect(isRetryableXhrError(connectionFailure('getaddrinfo ENOTFOUND example.com'))).toBe(true);
    expect(isRetryableXhrError(httpFailure(500, {}, `Unable to access ${URL}. Error: aborted`))).toBe(true);
  });

  it('does not retry values that are not request-light responses', () => {
    expect(isRetryableXhrError(new Error('boom'))).toBe(false);
    expect(isRetryableXhrError('boom')).toBe(false);
    expect(isRetryableXhrError(undefined)).toBe(false);
  });
});

describe('describeXhrError', () => {
  it('describes an HTTP failure by status and reason phrase, not by body', () => {
    expect(describeXhrError(httpFailure(503, REAL_HEADERS, '<html>Service Unavailable</html>'))).toBe(
      'HTTP 503 Service Unavailable',
    );
    expect(describeXhrError(httpFailure(429))).toBe('HTTP 429 Too Many Requests');
  });

  it('falls back to the bare status for an unknown status code', () => {
    expect(describeXhrError(httpFailure(599))).toBe('HTTP 599');
  });

  it("uses request-light's text for a connection failure", () => {
    expect(describeXhrError(connectionFailure('socket hang up'))).toBe(
      `Unable to connect to ${URL}. Error: socket hang up`,
    );
  });

  it('uses the message of an Error and stringifies anything else', () => {
    expect(describeXhrError(new Error('boom'))).toBe('boom');
    expect(describeXhrError('boom')).toBe('boom');
  });
});

describe('parseRetryAfterMs', () => {
  const now = Date.parse('2026-09-19T09:00:00Z');

  it('parses delay-seconds', () => {
    expect(parseRetryAfterMs({ 'retry-after': '3' }, now)).toBe(3000);
    expect(parseRetryAfterMs({ 'retry-after': '0' }, now)).toBe(0);
    expect(parseRetryAfterMs({ 'retry-after': '0.5' }, now)).toBe(500);
  });

  it('parses an HTTP-date relative to now', () => {
    expect(parseRetryAfterMs({ 'retry-after': 'Sat, 19 Sep 2026 09:00:02 GMT' }, now)).toBe(2000);
  });

  it('returns 0 for an HTTP-date in the past', () => {
    expect(parseRetryAfterMs({ 'retry-after': 'Sat, 19 Sep 2026 08:00:00 GMT' }, now)).toBe(0);
  });

  it('returns undefined when the header is missing, empty, negative or unparseable', () => {
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
    expect(parseRetryAfterMs({}, now)).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': '' }, now)).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': '-1' }, now)).toBeUndefined();
    expect(parseRetryAfterMs({ 'retry-after': 'soon' }, now)).toBeUndefined();
  });

  it('uses the first value when the header is repeated', () => {
    expect(parseRetryAfterMs({ 'retry-after': ['4', '9'] }, now)).toBe(4000);
  });
});

describe('computeBackoffMs', () => {
  const options = { baseDelayMs: 500, maxDelayMs: 5000 };

  it('doubles per attempt with equal jitter', () => {
    expect(computeBackoffMs(0, options)).toBe(375);
    expect(computeBackoffMs(1, options)).toBe(750);
    expect(computeBackoffMs(2, options)).toBe(1500);
  });

  it('never exceeds the maximum delay', () => {
    jest.spyOn(Math, 'random').mockReturnValue(1);
    expect(computeBackoffMs(10, options)).toBe(5000);
  });

  it('stays within the equal-jitter range', () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    expect(computeBackoffMs(0, options)).toBe(250);
    jest.spyOn(Math, 'random').mockReturnValue(0.999);
    expect(computeBackoffMs(0, options)).toBeLessThanOrEqual(500);
  });
});

describe('xhrWithRetry', () => {
  it('returns the first successful response without sleeping', async () => {
    xhr.mockResolvedValue(success);

    await expect(xhrWithRetry(URL, { sleep })).resolves.toBe(success);

    expect(xhr).toHaveBeenCalledTimes(1);
    expect(xhr).toHaveBeenCalledWith({ url: URL, followRedirects: 5, headers: { 'Accept-Encoding': 'gzip, deflate' } });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient status and returns the eventual response', async () => {
    xhr.mockRejectedValueOnce(httpFailure(503)).mockResolvedValueOnce(success);

    await expect(xhrWithRetry(URL, { sleep })).resolves.toBe(success);

    expect(xhr).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries a connection-level failure', async () => {
    xhr.mockRejectedValueOnce(connectionFailure('socket hang up')).mockResolvedValueOnce(success);

    await expect(xhrWithRetry(URL, { sleep })).resolves.toBe(success);

    expect(xhr).toHaveBeenCalledTimes(2);
  });

  it('honours Retry-After in preference to backoff', async () => {
    xhr.mockRejectedValueOnce(httpFailure(429, { ...REAL_HEADERS, 'retry-after': '2' })).mockResolvedValueOnce(success);

    await xhrWithRetry(URL, { sleep });

    expect(delays).toEqual([2000]);
  });

  it('honours a long Retry-After that fits in the wait budget, beyond the backoff cap', async () => {
    xhr
      .mockRejectedValueOnce(httpFailure(503, { ...REAL_HEADERS, 'retry-after': '45' }))
      .mockResolvedValueOnce(success);

    await xhrWithRetry(URL, { sleep });

    expect(delays).toEqual([45_000]);
  });

  it('gives up at once when Retry-After exceeds the remaining wait budget', async () => {
    const failure = httpFailure(429, { ...REAL_HEADERS, 'retry-after': '3600' });
    xhr.mockRejectedValue(failure);

    const promise = xhrWithRetry(URL, { sleep });

    await expect(promise).rejects.toThrow(
      'HTTP 429 Too Many Requests (server asked to retry in 3600s, beyond the retry wait limit)',
    );
    await expect(promise).rejects.toHaveProperty('cause', failure);
    expect(xhr).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('counts earlier waits against the budget when judging a later Retry-After', async () => {
    xhr
      .mockRejectedValueOnce(httpFailure(503, { ...REAL_HEADERS, 'retry-after': '40' }))
      .mockRejectedValueOnce(httpFailure(503, { ...REAL_HEADERS, 'retry-after': '30' }));

    await expect(xhrWithRetry(URL, { sleep })).rejects.toThrow(
      'HTTP 503 Service Unavailable (after 2 attempts; server asked to retry in 30s, beyond the retry wait limit)',
    );

    expect(delays).toEqual([40_000]);
  });

  it('backs off on the slow schedule after a rate-limited response', async () => {
    xhr.mockRejectedValue(httpFailure(429));

    await expect(xhrWithRetry(URL, { sleep })).rejects.toThrow('HTTP 429 Too Many Requests (after 5 attempts)');

    // 7.5s, 15s and 22.5s leave 15s of the 60s budget, so the fourth 22.5s wait is trimmed to fit.
    expect(delays).toEqual([7500, 15_000, 22_500, 15_000]);
  });

  it('spends at most the default wait budget on a persistent rate limit', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1);
    xhr.mockRejectedValue(httpFailure(429));

    await expect(xhrWithRetry(URL, { sleep })).rejects.toBeInstanceOf(SchemaFetchError);

    // The worst-case jitter uses the whole 60s budget: 10s, 20s, then the 30s per-wait cap.
    expect(delays).toEqual([10_000, 20_000, 30_000]);
  });

  it('trims backoff to the remaining wait budget and stops once it is spent', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(1);
    xhr.mockRejectedValue(httpFailure(429));

    await expect(xhrWithRetry(URL, { sleep, maxTotalDelayMs: 15_000 })).rejects.toThrow(
      'HTTP 429 Too Many Requests (after 3 attempts)',
    );

    expect(delays).toEqual([10_000, 5000]);
  });

  it('does not retry when the wait budget is zero', async () => {
    xhr.mockRejectedValue(httpFailure(503, { ...REAL_HEADERS, 'retry-after': '0' }));

    await expect(xhrWithRetry(URL, { sleep, maxTotalDelayMs: 0 })).rejects.toThrow(/^HTTP 503 Service Unavailable$/);

    expect(xhr).toHaveBeenCalledTimes(1);
  });

  it('treats Retry-After: 0 as an immediate retry rather than falling back to backoff', async () => {
    xhr.mockRejectedValueOnce(httpFailure(503, { ...REAL_HEADERS, 'retry-after': '0' })).mockResolvedValueOnce(success);

    await xhrWithRetry(URL, { sleep });

    expect(delays).toEqual([0]);
  });

  it('backs off exponentially when no Retry-After is given', async () => {
    xhr.mockRejectedValue(httpFailure(503));

    await expect(xhrWithRetry(URL, { sleep })).rejects.toBeDefined();

    expect(delays).toEqual([750, 1500, 3000, 6000]);
  });

  it('gives up after the retry budget and reports the attempts, keeping the last rejection as the cause', async () => {
    const failure = httpFailure(503);
    xhr.mockRejectedValue(failure);

    const promise = xhrWithRetry(URL, { sleep });

    await expect(promise).rejects.toBeInstanceOf(SchemaFetchError);
    await expect(promise).rejects.toThrow('HTTP 503 Service Unavailable (after 5 attempts)');
    await expect(promise).rejects.toMatchObject({ attempts: 5, cause: failure });

    expect(xhr).toHaveBeenCalledTimes(SCHEMA_FETCH_MAX_RETRIES + 1);
    expect(sleep).toHaveBeenCalledTimes(SCHEMA_FETCH_MAX_RETRIES);
  });

  it('does not retry a permanent status', async () => {
    const failure = httpFailure(404);
    xhr.mockRejectedValue(failure);

    const promise = xhrWithRetry(URL, { sleep });

    // A single attempt needs no attempt count.
    await expect(promise).rejects.toThrow(/^HTTP 404 Not Found$/);
    await expect(promise).rejects.toMatchObject({ attempts: 1, cause: failure });

    expect(xhr).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a rejection that is not a request-light response', async () => {
    xhr.mockRejectedValue(new Error('boom'));

    await expect(xhrWithRetry(URL, { sleep })).rejects.toThrow('boom');

    expect(xhr).toHaveBeenCalledTimes(1);
  });

  it('makes a single attempt when the budget is zero', async () => {
    xhr.mockRejectedValue(httpFailure(503));

    await expect(xhrWithRetry(URL, { sleep, maxRetries: 0 })).rejects.toBeDefined();

    expect(xhr).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('logs each failed attempt and the final failure with the HTTP reason', async () => {
    xhr.mockRejectedValue(httpFailure(503));

    await expect(xhrWithRetry(URL, { sleep })).rejects.toBeDefined();

    expect(consoleDebugSpy).toHaveBeenCalledWith(
      `Fetch attempt 1/5 of ${URL} failed: HTTP 503 Service Unavailable; retrying in 750ms`,
    );
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      `Fetch of ${URL} failed after 5 attempt(s): HTTP 503 Service Unavailable`,
    );
  });

  it('uses a real sleep by default', async () => {
    await expect(DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS.sleep(0)).resolves.toBeUndefined();
  });
});
