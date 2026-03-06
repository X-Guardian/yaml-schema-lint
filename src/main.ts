/**
 * CLI to lint YAML files against JSON schemas using the yaml-language-server
 */

import fs from 'node:fs';
import { Command, Option } from 'commander';

import {
  CMD_OPTIONS,
  DEFAULT_CACHE_DIR,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_SETTINGS_PATH,
  FAIL_EXIT_CODE,
} from './constants';
import { FORMAT_CHOICES, formatGitHubAnnotations, getFormatter } from './yaml-lint-formatters';
import {
  countDiagnostics,
  createLanguageService,
  fetchSchemaStoreSchemas,
  loadSchemaSettings,
  lintFiles,
  formatDiagnostics,
  resolveFileGlobs,
} from './yaml-lint';
import { consoleDebug, consoleError, initConsoleDebug, ManagedError, safeProcessExit } from './utils';
import { name, description, version } from '../package.json';

const program = new Command()
  .name(name)
  .description(description)
  .version(version)
  .argument('<patterns...>', 'YAML file paths or glob patterns (e.g. "**/*.yml")')
  .addOption(
    new Option(`${CMD_OPTIONS.settingsPath} <path>`, 'Path to settings JSON file with yaml.schemas').default(
      DEFAULT_SETTINGS_PATH,
    ),
  )
  .addOption(new Option(`${CMD_OPTIONS.noSchemaStore}`, 'Disable fetching schemas from schemastore.org'))
  .addOption(new Option(`${CMD_OPTIONS.cacheDir} <path>`, 'Cache directory').default(DEFAULT_CACHE_DIR))
  .addOption(
    new Option(`${CMD_OPTIONS.cacheTtl} <seconds>`, 'Schema store cache TTL in seconds')
      .argParser((v) => parseInt(v, 10))
      .default(DEFAULT_CACHE_TTL_SECONDS),
  )
  .addOption(
    new Option(`${CMD_OPTIONS.format} <name>`, 'Output file format').choices(FORMAT_CHOICES).default(FORMAT_CHOICES[0]),
  )
  .addOption(new Option(`${CMD_OPTIONS.outputFile} <path>`, 'Write a report file (uses --format)'))
  .addOption(new Option(`${CMD_OPTIONS.githubAnnotations}`, 'Print GitHub Actions annotation commands to stdout'))
  .addOption(
    new Option(`${CMD_OPTIONS.debug} [true|false]`, 'Enable debug logging')
      .choices(['true', 'false'])
      .argParser((value) => value === 'true')
      .default(false),
  )
  .action(main);

interface CmdOptions {
  settingsPath: string;
  schemaStore: boolean;
  cacheDir: string;
  cacheTtl: number;
  format: string;
  outputFile?: string;
  githubAnnotations?: true;
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

    const files = resolveFileGlobs(patterns);
    consoleDebug(`Resolved ${patterns.length} pattern(s) to ${files.length} file(s)`);

    if (files.length === 0) {
      throw new ManagedError(`No files found matching: ${patterns.join(', ')}`);
    }

    const settings = loadSchemaSettings(options.settingsPath);
    consoleDebug(`Loaded ${settings.schemas.length} schema association(s) from ${options.settingsPath}`);

    const allSchemas = [...settings.schemas];

    if (options.schemaStore !== false) {
      console.log('Loading schemas from schemastore.org...');
      const schemaStoreSchemas = await fetchSchemaStoreSchemas({
        cacheDir: options.cacheDir,
        cacheTtlSeconds: options.cacheTtl,
      });
      consoleDebug(`Loaded ${schemaStoreSchemas.length} schema(s) from Schema Store`);
      allSchemas.push(...schemaStoreSchemas);
    }

    consoleDebug(`Total schema associations: ${allSchemas.length}`);

    const languageService = createLanguageService(allSchemas, settings.customTags);

    console.log(`Linting ${files.length} file(s)...\n`);

    const results = await lintFiles(languageService, files);

    let errorCount: number;
    let warningCount: number;

    if (options.githubAnnotations) {
      const annotations = formatGitHubAnnotations(results);
      if (annotations) {
        console.log(annotations);
      }
      ({ errorCount, warningCount } = countDiagnostics(results));
    } else {
      ({ errorCount, warningCount } = formatDiagnostics(results));
    }

    const cleanCount = results.filter((r) => r.diagnostics.length === 0).length;

    console.log('');
    console.log(`Results: ${files.length} file(s) linted, ${errorCount} error(s), ${warningCount} warning(s)`);

    if (cleanCount > 0) {
      console.log(`  ${cleanCount} file(s) passed with no issues`);
    }

    if (options.outputFile) {
      const formatter = getFormatter(options.format);
      const content = formatter.formatToString(results);
      fs.writeFileSync(options.outputFile, content, 'utf-8');
      console.log(`\nReport written to ${options.outputFile}`);
    }

    if (errorCount > 0) {
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

export { program };
