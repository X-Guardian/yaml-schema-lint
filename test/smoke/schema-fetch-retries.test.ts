/** https://nodejs.org/api/events.html */
import { once } from 'node:events';
/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://nodejs.org/api/http.html */
import http from 'node:http';
/** https://nodejs.org/api/net.html */
import type { AddressInfo } from 'node:net';
/** https://nodejs.org/api/os.html */
import os from 'node:os';
/** https://nodejs.org/api/path.html */
import path from 'node:path';

import { FAIL_EXIT_CODE, FIXTURES_DIR, assertBundleExists, createWorkDir, output, runCliAsync } from './helpers';

/**
 * End-to-end tests for retrying transient schema fetch failures.
 *
 * The bundled CLI is run as a subprocess against an HTTP server started in this process, which fails a configurable
 * number of requests before serving the fixture schema. The CLI must be spawned asynchronously so the server can
 * answer while the CLI waits.
 */

/** Settings file, generated per server port, that maps the fixtures to the local schema server. */
const RETRY_SETTINGS = 'retry-settings.json';

/** Working directory created per test run to hold generated settings. */
let workDir: string;
let server: http.Server;
/** Requests the server has received in the current test. */
let hits: number;
/** How many requests the server should still fail before serving the schema. */
let failuresRemaining: number;
/** HTTP status sent for a failed request. */
let statusOnFailure: number;

/**
 * Run the bundled CLI in the working directory without blocking the event loop.
 * @param args CLI arguments to pass after the bundle path
 * @param env Environment for the child; defaults to the current environment
 * @returns The exit status and captured output
 */
const run = (args: string[], env?: NodeJS.ProcessEnv) => runCliAsync(args, workDir, env);

beforeAll(async () => {
  assertBundleExists();
  workDir = createWorkDir();

  const schemaJson = fs.readFileSync(path.join(FIXTURES_DIR, 'schema.json'), 'utf-8');

  server = http.createServer((_req, res) => {
    hits++;
    if (failuresRemaining > 0) {
      failuresRemaining--;
      // Retry-After: 0 keeps the test fast while still exercising the header path.
      res.writeHead(statusOnFailure, { 'Retry-After': '0' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(schemaJson);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address() as AddressInfo;
  const settings = {
    'yaml.schemas': {
      [`http://127.0.0.1:${String(port)}/schema.json`]: ['valid.yml', 'invalid.yml'],
    },
  };
  fs.writeFileSync(path.join(workDir, RETRY_SETTINGS), JSON.stringify(settings, null, 2), 'utf-8');
});

afterAll(async () => {
  server.close();
  await once(server, 'close');
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  hits = 0;
  failuresRemaining = 0;
  statusOnFailure = 503;
});

describe('schema fetch retries', () => {
  it('recovers when the schema server fails once with 503', async () => {
    failuresRemaining = 1;

    const result = await run(['--no-schema-store', '--settings-path', RETRY_SETTINGS, '--debug', 'true', 'valid.yml']);

    expect(hits).toBe(2);
    expect(result.stdout).toContain('HTTP 503 Service Unavailable; retrying in 0ms');
    expect(result.stdout).toContain('0 error(s), 0 warning(s)');
    expect(result.status).toBe(0);
  });

  it('does not retry a 404 response', async () => {
    failuresRemaining = Number.POSITIVE_INFINITY;
    statusOnFailure = 404;

    const result = await run(['--no-schema-store', '--settings-path', RETRY_SETTINGS, 'valid.yml']);

    expect(hits).toBe(1);
    expect(output(result)).toContain('Unable to load schema from');
    expect(output(result)).toContain('HTTP 404 Not Found');
    expect(result.status).toBe(FAIL_EXIT_CODE);
  });

  it('gives up after the retry budget on a persistent 503', async () => {
    failuresRemaining = Number.POSITIVE_INFINITY;

    const result = await run(['--no-schema-store', '--settings-path', RETRY_SETTINGS, 'valid.yml']);

    // The initial attempt plus 3 retries.
    expect(hits).toBe(4);
    expect(output(result)).toContain('Unable to load schema from');
    expect(output(result)).toContain('HTTP 503 Service Unavailable');
    // An unloadable schema is reported as an error, not a warning.
    expect(output(result)).toContain('1 error(s), 0 warning(s)');
    expect(result.status).toBe(FAIL_EXIT_CODE);
  });

  it('fails on an unloadable schema even when --no-fail-on-warnings is set', async () => {
    failuresRemaining = Number.POSITIVE_INFINITY;

    const result = await run([
      '--no-schema-store',
      '--no-fail-on-warnings',
      '--settings-path',
      RETRY_SETTINGS,
      'valid.yml',
    ]);

    expect(output(result)).toContain('1 error(s), 0 warning(s)');
    expect(result.status).toBe(FAIL_EXIT_CODE);
  });
});

describe('Schema Store catalog fetch', () => {
  it('reports a readable error when the catalog cannot be fetched', async () => {
    // An unreachable proxy makes the catalog request fail at connection level without touching the network.
    const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-schema-lint-smoke-cache-'));
    const env = { ...process.env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' };

    const result = await run(['--cache-dir', cacheDir, 'valid.yml'], env);

    expect(result.stderr).toContain('Failed to fetch the Schema Store catalog from');
    expect(result.stderr).toContain('Use --no-schema-store to skip it.');
    expect(output(result)).not.toContain('UnhandledPromiseRejection');
    expect(result.status).toBe(FAIL_EXIT_CODE);

    fs.rmSync(cacheDir, { recursive: true, force: true });
  }, 30_000);
});
