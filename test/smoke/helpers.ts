/** https://nodejs.org/api/child_process.html */
import { spawn, spawnSync } from 'node:child_process';
/** https://nodejs.org/api/events.html */
import { once } from 'node:events';
/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://nodejs.org/api/os.html */
import os from 'node:os';
/** https://nodejs.org/api/path.html */
import path from 'node:path';
/** https://nodejs.org/api/url.html */
import { pathToFileURL } from 'node:url';

/**
 * Shared helpers for tests that run the built bundle as a real subprocess.
 */

/** Path to the bundled CLI under test. */
export const BUNDLE_PATH = path.resolve(__dirname, '../../dist/yaml-schema-lint.js');

/** Directory holding the committed YAML and schema fixtures. */
export const FIXTURES_DIR = path.resolve(__dirname, 'fixtures');

/** Exit code the CLI uses for lint failures and fatal errors. */
export const FAIL_EXIT_CODE = 1;

/** The parts of a completed CLI run that the tests assert on. */
export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Fail fast with a helpful message when the bundle has not been built.
 */
export function assertBundleExists(): void {
  if (!fs.existsSync(BUNDLE_PATH)) {
    throw new Error(`Bundle not found at ${BUNDLE_PATH}. Run "pnpm build" before the smoke tests.`);
  }
}

/**
 * Create a temporary working directory containing the fixtures and a `.vscode/settings.json` that maps them to the
 * fixture schema. The schema association must be an absolute file:// URI, which differs per machine, so the settings
 * file is generated rather than committed.
 * @returns The absolute path of the new directory; remove it with `fs.rmSync` when done
 */
export function createWorkDir(): string {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-schema-lint-smoke-'));
  fs.cpSync(FIXTURES_DIR, workDir, { recursive: true });

  const schemaUri = pathToFileURL(path.join(workDir, 'schema.json')).href;
  const settings = {
    'yaml.schemas': {
      [schemaUri]: ['valid.yml', 'invalid.yml'],
    },
  };

  fs.mkdirSync(path.join(workDir, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  return workDir;
}

/**
 * Run the bundled CLI as a subprocess and wait for it to finish.
 * @param args CLI arguments to pass after the bundle path
 * @param cwd Working directory for the CLI
 * @returns The exit status and captured output
 */
export function runCli(args: string[], cwd: string): CliResult {
  const { status, stdout, stderr } = spawnSync(process.execPath, [BUNDLE_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status, stdout, stderr };
}

/**
 * Run the bundled CLI as a subprocess without blocking the event loop, so that an HTTP server started in this
 * process can answer the CLI's requests while it runs. `spawnSync` would block the loop and the server would
 * never respond.
 * @param args CLI arguments to pass after the bundle path
 * @param cwd Working directory for the CLI
 * @param env Environment for the child; defaults to the current environment
 * @returns The exit status and captured output
 */
export async function runCliAsync(
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CliResult> {
  const child = spawn(process.execPath, [BUNDLE_PATH, ...args], { cwd, env });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf-8');
  child.stderr.setEncoding('utf-8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [status] = (await once(child, 'close')) as [number | null];
  return { status, stdout, stderr };
}

/**
 * Combine stdout and stderr so assertions do not depend on which stream is used.
 * @param result A completed CLI run
 * @returns The concatenated output
 */
export function output(result: CliResult): string {
  return `${result.stdout}${result.stderr}`;
}
