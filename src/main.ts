/**
 * CLI to lint YAML files against JSON schemas using the yaml-language-server
 */

/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://www.npmjs.com/package/@commander-js/extra-typings */
import { Command, Option } from '@commander-js/extra-typings';

import {
  CMD_OPTIONS,
  DEFAULT_CACHE_DIR,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_SETTINGS_PATH,
  FAIL_EXIT_CODE,
  FORMAT_CHOICES,
} from './constants';
import { getFormatter } from './yaml-lint-formatters';
import {
  createLanguageService,
  fetchSchemaStoreSchemas,
  loadSchemaSettings,
  lintFiles,
  formatDiagnostics,
  resolveFileGlobs,
} from './yaml-lint';
import { consoleDebug, consoleError, initConsoleDebug, ManagedError, safeProcessExit } from './utils';
import { name, description, version } from '../package.json';

/**
 * Creates and configures the Commander CLI program with all options and the main action handler.
 * @returns The configured Commander program instance
 */
export function createProgram() {
  return new Command()
    .name(name)
    .description(description)
    .version(version)
    .argument('<patterns...>', 'YAML file paths or glob patterns (e.g. "**/*.yml")')
    .addOption(
      new Option(`${CMD_OPTIONS.settingsPath} <path>`, 'Path to settings JSON file with yaml.schemas').default(
        DEFAULT_SETTINGS_PATH,
      ),
    )
    .addOption(new Option(CMD_OPTIONS.noSchemaStore, 'Disable fetching schemas from schemastore.org'))
    .addOption(new Option(`${CMD_OPTIONS.cacheDir} <path>`, 'Cache directory').default(DEFAULT_CACHE_DIR))
    .addOption(
      new Option(`${CMD_OPTIONS.cacheTtl} <seconds>`, 'Schema store cache TTL in seconds')
        .argParser((v) => parseInt(v, 10))
        .default(DEFAULT_CACHE_TTL_SECONDS),
    )
    .addOption(
      new Option(`${CMD_OPTIONS.format} <name>`, 'Output file format')
        .choices(FORMAT_CHOICES)
        .default(FORMAT_CHOICES[0]),
    )
    .addOption(new Option(`${CMD_OPTIONS.outputFile} <path>`, 'Write a report file (uses --format)'))
    .addOption(
      new Option(`${CMD_OPTIONS.ignore} <patterns>`, 'Comma-separated glob patterns to exclude from file matching')
        .default(DEFAULT_IGNORE_PATTERNS)
        .argParser((value) => {
          const values = value.split(',').map((v) => v.trim());
          return values;
        }),
    )
    .addOption(new Option(CMD_OPTIONS.noFailOnNoFiles, 'Exit successfully when no files match the patterns'))
    .addOption(new Option(CMD_OPTIONS.noFailOnWarnings, 'Do not exit with an error when only warnings are found'))
    .addOption(
      new Option(`${CMD_OPTIONS.debug} [true|false]`, 'Enable debug logging')
        .choices(['true', 'false'])
        .argParser((value) => value === 'true')
        .default(false),
    )
    .action(main);
}

export const program = createProgram();

interface CmdOptions {
  settingsPath: string;
  schemaStore: boolean;
  cacheDir: string;
  cacheTtl: number;
  format: string;
  outputFile?: string;
  ignore: string[];
  failOnNoFiles: boolean;
  failOnWarnings: boolean;
  debug: boolean;
}

/**
 * Main function
 * @param patterns The YAML file paths or glob patterns to lint
 * @param options The Commander CLI command options
 */
export async function main(patterns: string[], options: CmdOptions) {
  initConsoleDebug(options.debug);

  consoleDebug('Program options', { patterns, ...options });

  try {
    console.log('yaml-schema-lint');
    console.log('================\n');

    const files = resolveFileGlobs(patterns, options.ignore);
    consoleDebug(`Resolved ${String(patterns.length)} pattern(s) to ${String(files.length)} file(s)`);

    if (files.length === 0) {
      if (options.failOnNoFiles) {
        throw new ManagedError(`No files found matching: ${patterns.join(', ')}`);
      }
      console.log(`No files found matching: ${patterns.join(', ')}`);
      return;
    }

    const settings = loadSchemaSettings(options.settingsPath);
    consoleDebug(`Loaded ${String(settings.schemas.length)} schema association(s) from ${options.settingsPath}`);

    const allSchemas = [...settings.schemas];

    if (options.schemaStore) {
      console.log('Loading schemas from schemastore.org...');
      const schemaStoreSchemas = await fetchSchemaStoreSchemas({
        cacheDir: options.cacheDir,
        cacheTtlSeconds: options.cacheTtl,
      });
      consoleDebug(`Loaded ${String(schemaStoreSchemas.length)} schema(s) from Schema Store`);
      allSchemas.push(...schemaStoreSchemas);
    }

    consoleDebug(`Total schema associations: ${String(allSchemas.length)}`);

    const languageService = createLanguageService(allSchemas, settings.customTags);

    console.log(`Linting ${String(files.length)} file(s)...\n`);

    const results = await lintFiles(languageService, files);

    const { errorCount, warningCount } = formatDiagnostics(results);

    const cleanCount = results.filter((r) => r.diagnostics.length === 0).length;

    console.log('');
    console.log(
      `Results: ${String(files.length)} file(s) linted, ${String(errorCount)} error(s), ${String(warningCount)} warning(s)`,
    );

    if (cleanCount > 0) {
      console.log(`  ${String(cleanCount)} file(s) passed with no issues`);
    }

    if (options.outputFile) {
      const formatter = getFormatter(options.format);
      const content = formatter.formatToString(results);
      fs.writeFileSync(options.outputFile, content, 'utf-8');
      console.log(`\nReport written to ${options.outputFile}`);
    }

    if (errorCount > 0 || (warningCount > 0 && options.failOnWarnings)) {
      safeProcessExit(FAIL_EXIT_CODE);
    }
  } catch (error) {
    if (error instanceof ManagedError) {
      consoleError(error.message);
    } else {
      throw error;
    }
    safeProcessExit(FAIL_EXIT_CODE);
  }
}
