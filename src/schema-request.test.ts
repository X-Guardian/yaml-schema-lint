/** https://www.npmjs.com/package/request-light */
import type { XHRResponse } from 'request-light';

import { SCHEMA_FETCH_MAX_DELAY_MS, SCHEMA_FETCH_MAX_RETRIES } from './constants';
import {
  DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS,
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
  it.each([429, 502, 503, 504])('retries HTTP %i', (status) => {
    expect(isRetryableXhrError(httpFailure(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 500])('does not retry HTTP %i from a server', (status) => {
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

  it('caps an excessive Retry-After at the maximum delay', async () => {
    xhr
      .mockRejectedValueOnce(httpFailure(429, { ...REAL_HEADERS, 'retry-after': '3600' }))
      .mockResolvedValueOnce(success);

    await xhrWithRetry(URL, { sleep });

    expect(delays).toEqual([SCHEMA_FETCH_MAX_DELAY_MS]);
  });

  it('treats Retry-After: 0 as an immediate retry rather than falling back to backoff', async () => {
    xhr.mockRejectedValueOnce(httpFailure(503, { ...REAL_HEADERS, 'retry-after': '0' })).mockResolvedValueOnce(success);

    await xhrWithRetry(URL, { sleep });

    expect(delays).toEqual([0]);
  });

  it('backs off exponentially when no Retry-After is given', async () => {
    xhr.mockRejectedValue(httpFailure(503));

    await expect(xhrWithRetry(URL, { sleep })).rejects.toBeDefined();

    expect(delays).toEqual([375, 750, 1500]);
  });

  it('gives up after the retry budget and rejects with the original rejection', async () => {
    const failure = httpFailure(503);
    xhr.mockRejectedValue(failure);

    await expect(xhrWithRetry(URL, { sleep })).rejects.toBe(failure);

    expect(xhr).toHaveBeenCalledTimes(SCHEMA_FETCH_MAX_RETRIES + 1);
    expect(sleep).toHaveBeenCalledTimes(SCHEMA_FETCH_MAX_RETRIES);
  });

  it('does not retry a permanent status', async () => {
    const failure = httpFailure(404);
    xhr.mockRejectedValue(failure);

    await expect(xhrWithRetry(URL, { sleep })).rejects.toBe(failure);

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
      `Fetch attempt 1/4 of ${URL} failed: HTTP 503 Service Unavailable; retrying in 375ms`,
    );
    expect(consoleDebugSpy).toHaveBeenCalledWith(
      `Fetch of ${URL} failed after 4 attempt(s): HTTP 503 Service Unavailable`,
    );
  });

  it('uses a real sleep by default', async () => {
    await expect(DEFAULT_SCHEMA_FETCH_RETRY_OPTIONS.sleep(0)).resolves.toBeUndefined();
  });
});
