/** https://nodejs.org/api/child_process.html */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://nodejs.org/api/os.html */
import os from 'node:os';
/** https://nodejs.org/api/path.html */
import path from 'node:path';
/** https://nodejs.org/api/url.html */
import { pathToFileURL } from 'node:url';

/**
 * End-to-end smoke tests for the bundled CLI.
 *
 * These run against `dist/yaml-schema-lint.js` as a real subprocess rather than importing from `src/`, so they exercise
 * what is actually published: the esbuild bundle and its inlined dependencies. Unit tests import TypeScript directly
 * and would not catch a dependency or bundling regression that only manifests once the bundle is built.
 */

/** Path to the bundled CLI under test. */
const BUNDLE_PATH = path.resolve(__dirname, '../../dist/yaml-schema-lint.js');

/** Directory holding the committed YAML and schema fixtures. */
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

/** Exit code the CLI uses for lint failures and fatal errors. */
const FAIL_EXIT_CODE = 1;

/** Working directory created per test run to hold generated settings. */
let workDir: string;

/**
 * Run the bundled CLI as a subprocess.
 * @param args CLI arguments to pass after the bundle path
 * @returns The completed spawn result with stdout and stderr as strings
 */
function runCli(args: string[]): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [BUNDLE_PATH, ...args], {
    cwd: workDir,
    encoding: 'utf-8',
  });
}

/**
 * Combine stdout and stderr so assertions do not depend on which stream is used.
 * @param result A completed spawn result
 * @returns The concatenated output
 */
function output(result: SpawnSyncReturns<string>): string {
  return `${result.stdout}${result.stderr}`;
}

beforeAll(() => {
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error(`Bundle not found at ${BUNDLE_PATH}. Run "pnpm build" before the smoke tests.`);
  }

  // The schema association must be an absolute file:// URI, which differs per machine, so the settings file is
  // generated here rather than committed.
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-schema-lint-smoke-'));
  fs.cpSync(FIXTURES_DIR, workDir, { recursive: true });

  const schemaUri = pathToFileURL(path.join(workDir, 'schema.json')).href;
  const settings = {
    'yaml.schemas': {
      [schemaUri]: ['valid.yml', 'invalid.yml'],
    },
  };

  fs.mkdirSync(path.join(workDir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
});

afterAll(() => {
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

describe('bundled CLI', () => {
  it('reports its version', () => {
    const result = runCli(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits cleanly for a YAML file that matches its schema', () => {
    const result = runCli(['--no-schema-store', 'valid.yml']);

    expect(output(result)).toContain('0 error(s), 0 warning(s)');
    expect(result.status).toBe(0);
  });

  it('reports schema violations for a YAML file that does not match its schema', () => {
    const result = runCli(['--no-schema-store', 'invalid.yml']);

    // Both violations must be detected: a type mismatch and a disallowed property.
    expect(output(result)).toContain('Incorrect type. Expected "integer".');
    expect(output(result)).toContain('Property extra is not allowed.');
    expect(output(result)).toContain('0 error(s), 2 warning(s)');
  });

  it('fails on warnings by default', () => {
    const result = runCli(['--no-schema-store', 'invalid.yml']);

    expect(result.status).toBe(FAIL_EXIT_CODE);
  });

  it('succeeds on warnings when --no-fail-on-warnings is set', () => {
    const result = runCli(['--no-schema-store', '--no-fail-on-warnings', 'invalid.yml']);

    expect(output(result)).toContain('2 warning(s)');
    expect(result.status).toBe(0);
  });

  it('fails when no files match the given pattern', () => {
    const result = runCli(['--no-schema-store', 'does-not-exist.yml']);

    expect(output(result)).toContain('No files found matching');
    expect(result.status).toBe(FAIL_EXIT_CODE);
  });

  it('succeeds on no matching files when --no-fail-on-no-files is set', () => {
    const result = runCli(['--no-schema-store', '--no-fail-on-no-files', 'does-not-exist.yml']);

    expect(output(result)).toContain('No files found matching');
    expect(result.status).toBe(0);
  });

  it('writes a report file in the requested format', () => {
    const reportPath = path.join(workDir, 'report.json');
    const result = runCli([
      '--no-schema-store',
      '--no-fail-on-warnings',
      '--format',
      'json',
      '--output-file',
      reportPath,
      'invalid.yml',
    ]);

    expect(result.status).toBe(0);
    expect(fs.existsSync(reportPath)).toBe(true);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as {
      filePath: string;
      diagnostics: { message: string; severity: string }[];
    }[];

    expect(report).toHaveLength(1);
    expect(report[0].filePath).toBe('invalid.yml');
    expect(report[0].diagnostics.map((d) => d.message)).toEqual([
      'Incorrect type. Expected "integer".',
      'Property extra is not allowed.',
    ]);
  });
});
