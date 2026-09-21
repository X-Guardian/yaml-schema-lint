/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://nodejs.org/api/path.html */
import path from 'node:path';

import { FAIL_EXIT_CODE, assertBundleExists, createWorkDir, output, runCli } from './helpers';

/**
 * End-to-end smoke tests for the bundled CLI.
 *
 * These run against `dist/yaml-schema-lint.js` as a real subprocess rather than importing from `src/`, so they exercise
 * what is actually published: the esbuild bundle and its inlined dependencies. Unit tests import TypeScript directly
 * and would not catch a dependency or bundling regression that only manifests once the bundle is built.
 *
 * Behavioural end-to-end tests that need a live HTTP server live in their own files alongside this one.
 */

/** Working directory created per test run to hold generated settings. */
let workDir: string;

/**
 * Run the bundled CLI in the working directory.
 * @param args CLI arguments to pass after the bundle path
 * @returns The exit status and captured output
 */
const run = (args: string[]) => runCli(args, workDir);

beforeAll(() => {
  assertBundleExists();
  workDir = createWorkDir();
});

afterAll(() => {
  if (workDir) {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

describe('bundled CLI', () => {
  it('reports its version', () => {
    const result = run(['--version']);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits cleanly for a YAML file that matches its schema', () => {
    const result = run(['--no-schema-store', 'valid.yml']);

    expect(output(result)).toContain('0 error(s), 0 warning(s)');
    expect(result.status).toBe(0);
  });

  it('reports schema violations for a YAML file that does not match its schema', () => {
    const result = run(['--no-schema-store', 'invalid.yml']);

    // Both violations must be detected: a type mismatch and a disallowed property.
    expect(output(result)).toContain('Incorrect type. Expected "integer".');
    expect(output(result)).toContain('Property extra is not allowed.');
    expect(output(result)).toContain('0 error(s), 2 warning(s)');
  });

  it('fails on warnings by default', () => {
    const result = run(['--no-schema-store', 'invalid.yml']);

    expect(result.status).toBe(FAIL_EXIT_CODE);
  });

  it('succeeds on warnings when --no-fail-on-warnings is set', () => {
    const result = run(['--no-schema-store', '--no-fail-on-warnings', 'invalid.yml']);

    expect(output(result)).toContain('2 warning(s)');
    expect(result.status).toBe(0);
  });

  it('fails when no files match the given pattern', () => {
    const result = run(['--no-schema-store', 'does-not-exist.yml']);

    expect(output(result)).toContain('No files found matching');
    expect(result.status).toBe(FAIL_EXIT_CODE);
  });

  it('succeeds on no matching files when --no-fail-on-no-files is set', () => {
    const result = run(['--no-schema-store', '--no-fail-on-no-files', 'does-not-exist.yml']);

    expect(output(result)).toContain('No files found matching');
    expect(result.status).toBe(0);
  });

  it('writes a report file in the requested format', () => {
    const reportPath = path.join(workDir, 'report.json');
    const result = run([
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
