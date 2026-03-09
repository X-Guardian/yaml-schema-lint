/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://www.npmjs.com/package/@commander-js/extra-typings */
import { Command, Option } from '@commander-js/extra-typings';
/** https://www.npmjs.com/package/yaml-language-server */
import { DiagnosticSeverity, type LanguageService } from 'yaml-language-server';
import * as yamlLint from './yaml-lint';
import * as formatters from './yaml-lint-formatters';
import * as utils from './utils';
import {
  CMD_OPTIONS,
  DEFAULT_CACHE_DIR,
  DEFAULT_CACHE_TTL_SECONDS,
  DEFAULT_IGNORE_PATTERNS,
  DEFAULT_SETTINGS_PATH,
  FORMAT_CHOICES,
} from './constants';
import { createCommandOptions } from './test-utils';
import type { LintFileResult } from './yaml-lint';
import { main } from './main';

jest.mock('./main', () => {
  return { ...jest.requireActual<object>('./main') };
});

const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();
const consoleErrorSpy = jest.spyOn(utils, 'consoleError');
const safeProcessExitSpy = jest.spyOn(utils, 'safeProcessExit');
const initConsoleDebugSpy = jest.spyOn(utils, 'initConsoleDebug');
const resolveFileGlobsSpy = jest.spyOn(yamlLint, 'resolveFileGlobs');
const loadSchemaSettingsSpy = jest.spyOn(yamlLint, 'loadSchemaSettings');
const fetchSchemaStoreSchemasSpy = jest.spyOn(yamlLint, 'fetchSchemaStoreSchemas');
const createLanguageServiceSpy = jest.spyOn(yamlLint, 'createLanguageService');
const lintFilesSpy = jest.spyOn(yamlLint, 'lintFiles');
const formatDiagnosticsSpy = jest.spyOn(yamlLint, 'formatDiagnostics');
const writeFileSyncSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();

const mockLanguageService = {
  doValidation: jest.fn(),
  configure: jest.fn(),
} as unknown as LanguageService;

/**
 * Build a Command instance that routes to the exported `main` function.
 * This mirrors the CLI structure without triggering `program.parseAsync()`.
 * @returns A configured Command instance
 */
function buildCommand(): Command {
  const cmd = new Command();
  cmd.exitOverride();
  cmd.configureOutput({ outputError: (str: string) => str });

  cmd
    .argument('<patterns...>', 'YAML file paths or glob patterns')
    .addOption(
      new Option(`${CMD_OPTIONS.settingsPath} <path>`, 'Path to settings JSON file with yaml.schemas').default(
        DEFAULT_SETTINGS_PATH,
      ),
    )
    .addOption(new Option(CMD_OPTIONS.noSchemaStore, 'Disable fetching schemas from schemastore.org'))
    .addOption(new Option(`${CMD_OPTIONS.cacheDir} <path>`, 'Cache directory').default(DEFAULT_CACHE_DIR))
    .addOption(
      new Option(`${CMD_OPTIONS.cacheTtl} <seconds>`, 'Schema store cache TTL in seconds')
        .argParser((v: string) => parseInt(v, 10))
        .default(DEFAULT_CACHE_TTL_SECONDS),
    )
    .addOption(
      new Option(`${CMD_OPTIONS.format} <name>`, 'Output file format')
        .choices(FORMAT_CHOICES)
        .default(FORMAT_CHOICES[0]),
    )
    .addOption(new Option(`${CMD_OPTIONS.outputFile} <path>`, 'Write a report file (uses --format)'))
    .addOption(
      new Option(`${CMD_OPTIONS.ignore} <patterns...>`, 'Glob patterns to exclude from file matching').default(
        DEFAULT_IGNORE_PATTERNS,
      ),
    )
    .addOption(new Option(CMD_OPTIONS.noFailOnNoFiles, 'Exit successfully when no files match the patterns'))
    .addOption(new Option(CMD_OPTIONS.noFailOnWarnings, 'Do not exit with an error when only warnings are found'))
    .addOption(
      new Option(`${CMD_OPTIONS.debug} [true|false]`, 'Enable debug logging')
        .choices(['true', 'false'])
        .argParser((value: string) => value === 'true')
        .default(false),
    )
    .action(main);

  return cmd;
}

const baseOptionsBuilder = createCommandOptions('').addOption(CMD_OPTIONS.debug, 'false');

let command: Command;

beforeEach(() => {
  jest.resetAllMocks();

  command = buildCommand();

  initConsoleDebugSpy.mockImplementation();
  consoleLogSpy.mockImplementation();
  safeProcessExitSpy.mockImplementation(() => {
    throw new Error('process.exit called');
  });
  consoleErrorSpy.mockImplementation();

  resolveFileGlobsSpy.mockImplementation((patterns) => patterns);
  loadSchemaSettingsSpy.mockReturnValue({ schemas: [], customTags: [] });
  fetchSchemaStoreSchemasSpy.mockResolvedValue([]);
  createLanguageServiceSpy.mockReturnValue(mockLanguageService);
  lintFilesSpy.mockResolvedValue([]);
  formatDiagnosticsSpy.mockReturnValue({ errorCount: 0, warningCount: 0 });
});

describe('yaml-schema-lint command', () => {
  it('uses default settings path when not specified', async () => {
    const args = [...baseOptionsBuilder.build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(loadSchemaSettingsSpy).toHaveBeenCalledWith(DEFAULT_SETTINGS_PATH);
  });

  it('uses custom settings path when specified', async () => {
    const args = [
      ...baseOptionsBuilder.clone().addOption(CMD_OPTIONS.settingsPath, '/custom/settings.json').build(),
      'test.yaml',
    ];
    await command.parseAsync(args, { from: 'user' });

    expect(loadSchemaSettingsSpy).toHaveBeenCalledWith('/custom/settings.json');
  });

  it('fetches schema store schemas by default with default cache options', async () => {
    const mockSchemaStoreSchemas = [{ uri: 'https://json.schemastore.org/gitlab-ci', fileMatch: ['.gitlab-ci.yml'] }];
    fetchSchemaStoreSchemasSpy.mockResolvedValue(mockSchemaStoreSchemas);

    const args = [...baseOptionsBuilder.build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(fetchSchemaStoreSchemasSpy).toHaveBeenCalledWith({
      cacheDir: DEFAULT_CACHE_DIR,
      cacheTtlSeconds: DEFAULT_CACHE_TTL_SECONDS,
    });
    expect(createLanguageServiceSpy).toHaveBeenCalledWith(mockSchemaStoreSchemas, []);
  });

  it('merges local schema settings with schema store schemas', async () => {
    const localSchemas = [{ uri: 'https://example.com/local.json', fileMatch: ['*.yml'] }];
    loadSchemaSettingsSpy.mockReturnValue({ schemas: localSchemas, customTags: ['!Ref'] });

    const storeSchemas = [{ uri: 'https://json.schemastore.org/gitlab-ci', fileMatch: ['.gitlab-ci.yml'] }];
    fetchSchemaStoreSchemasSpy.mockResolvedValue(storeSchemas);

    const args = [...baseOptionsBuilder.build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(createLanguageServiceSpy).toHaveBeenCalledWith([...localSchemas, ...storeSchemas], ['!Ref']);
  });

  it('skips schema store when --no-schema-store is specified', async () => {
    const args = [...baseOptionsBuilder.clone().build(), CMD_OPTIONS.noSchemaStore, 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(fetchSchemaStoreSchemasSpy).not.toHaveBeenCalled();
  });

  it('resolves glob patterns and lints matched files', async () => {
    resolveFileGlobsSpy.mockReturnValue(['dir/a.yml', 'dir/b.yml']);

    const args = [...baseOptionsBuilder.build(), 'dir/*.yml'];
    await command.parseAsync(args, { from: 'user' });

    expect(resolveFileGlobsSpy).toHaveBeenCalledWith(['dir/*.yml'], DEFAULT_IGNORE_PATTERNS);
    expect(lintFilesSpy).toHaveBeenCalledWith(mockLanguageService, ['dir/a.yml', 'dir/b.yml']);
  });

  it('lints all provided literal files', async () => {
    const args = [...baseOptionsBuilder.build(), 'a.yaml', 'b.yaml', 'c.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(lintFilesSpy).toHaveBeenCalledWith(mockLanguageService, ['a.yaml', 'b.yaml', 'c.yaml']);
  });

  it('exits with error when no files match the patterns', async () => {
    resolveFileGlobsSpy.mockReturnValue([]);

    const args = [...baseOptionsBuilder.build(), 'no-match/**/*.yml'];

    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('No files found matching: no-match/**/*.yml');
    expect(safeProcessExitSpy).toHaveBeenCalledWith(1);
  });

  it('exits successfully when no files match and --no-fail-on-no-files is set', async () => {
    resolveFileGlobsSpy.mockReturnValue([]);

    const args = [...baseOptionsBuilder.build(), CMD_OPTIONS.noFailOnNoFiles, 'no-match/**/*.yml'];
    await command.parseAsync(args, { from: 'user' });

    expect(consoleLogSpy).toHaveBeenCalledWith('No files found matching: no-match/**/*.yml');
    expect(safeProcessExitSpy).not.toHaveBeenCalled();
  });

  it('exits with code 1 when errors are found', async () => {
    formatDiagnosticsSpy.mockReturnValue({ errorCount: 2, warningCount: 0 });

    const args = [...baseOptionsBuilder.build(), 'test.yaml'];

    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit called');

    expect(safeProcessExitSpy).toHaveBeenCalledWith(1);
  });

  it('exits with code 1 when only warnings are found', async () => {
    formatDiagnosticsSpy.mockReturnValue({ errorCount: 0, warningCount: 3 });

    const args = [...baseOptionsBuilder.build(), 'test.yaml'];

    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit called');

    expect(safeProcessExitSpy).toHaveBeenCalledWith(1);
  });

  it('does not exit with error when only warnings are found and --no-fail-on-warnings is set', async () => {
    formatDiagnosticsSpy.mockReturnValue({ errorCount: 0, warningCount: 3 });

    const args = [...baseOptionsBuilder.build(), CMD_OPTIONS.noFailOnWarnings, 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(safeProcessExitSpy).not.toHaveBeenCalled();
  });

  it('does not exit with error when no issues are found', async () => {
    formatDiagnosticsSpy.mockReturnValue({ errorCount: 0, warningCount: 0 });

    const args = [...baseOptionsBuilder.build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(safeProcessExitSpy).not.toHaveBeenCalled();
  });

  it('handles ManagedError by logging and exiting', async () => {
    resolveFileGlobsSpy.mockImplementation(() => {
      throw new utils.ManagedError('test error');
    });

    const args = [...baseOptionsBuilder.build(), 'test.yaml'];

    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit called');

    expect(consoleErrorSpy).toHaveBeenCalledWith('test error');
    expect(safeProcessExitSpy).toHaveBeenCalledWith(1);
  });

  it('rethrows non-ManagedError errors', async () => {
    resolveFileGlobsSpy.mockImplementation(() => {
      throw new TypeError('unexpected');
    });

    const args = [...baseOptionsBuilder.build(), 'test.yaml'];

    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow('unexpected');
  });

  it('initializes debug logging', async () => {
    const args = [...createCommandOptions('').addOption(CMD_OPTIONS.debug, 'true').build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(initConsoleDebugSpy).toHaveBeenCalledWith(true);
  });

  it('logs summary with file count and issue counts', async () => {
    const mockResults: LintFileResult[] = [
      { filePath: 'a.yaml', diagnostics: [] },
      {
        filePath: 'b.yaml',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: 'err',
            severity: DiagnosticSeverity.Error,
          },
        ],
      },
    ];
    lintFilesSpy.mockResolvedValue(mockResults);
    formatDiagnosticsSpy.mockReturnValue({ errorCount: 1, warningCount: 0 });

    const args = [...baseOptionsBuilder.build(), 'a.yaml', 'b.yaml'];

    await expect(command.parseAsync(args, { from: 'user' })).rejects.toThrow('process.exit called');

    expect(consoleLogSpy).toHaveBeenCalledWith('Results: 2 file(s) linted, 1 error(s), 0 warning(s)');
    expect(consoleLogSpy).toHaveBeenCalledWith('  1 file(s) passed with no issues');
  });

  it('does not write a report file when --output-file is not specified', async () => {
    const args = [...baseOptionsBuilder.build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(writeFileSyncSpy).not.toHaveBeenCalled();
  });

  it('writes a report file when --output-file is specified', async () => {
    const getFormatterSpy = jest.spyOn(formatters, 'getFormatter');
    const mockFormatter = { formatToString: jest.fn().mockReturnValue('[{"mock":"data"}]') };
    getFormatterSpy.mockReturnValue(mockFormatter);

    const args = [...baseOptionsBuilder.clone().addOption(CMD_OPTIONS.outputFile, 'report.json').build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(getFormatterSpy).toHaveBeenCalledWith('gitlab-codequality');
    expect(mockFormatter.formatToString).toHaveBeenCalledWith([]);
    expect(writeFileSyncSpy).toHaveBeenCalledWith('report.json', '[{"mock":"data"}]', 'utf-8');
    expect(consoleLogSpy).toHaveBeenCalledWith('\nReport written to report.json');

    getFormatterSpy.mockRestore();
  });

  it('uses the format specified by --format for the report file', async () => {
    const getFormatterSpy = jest.spyOn(formatters, 'getFormatter');
    const mockFormatter = { formatToString: jest.fn().mockReturnValue('[]') };
    getFormatterSpy.mockReturnValue(mockFormatter);

    const args = [
      ...baseOptionsBuilder
        .clone()
        .addOption(CMD_OPTIONS.format, 'gitlab-codequality')
        .addOption(CMD_OPTIONS.outputFile, 'out.json')
        .build(),
      'test.yaml',
    ];
    await command.parseAsync(args, { from: 'user' });

    expect(getFormatterSpy).toHaveBeenCalledWith('gitlab-codequality');

    getFormatterSpy.mockRestore();
  });

  it('still prints console output when --output-file is specified', async () => {
    const getFormatterSpy = jest.spyOn(formatters, 'getFormatter');
    getFormatterSpy.mockReturnValue({ formatToString: jest.fn().mockReturnValue('[]') });

    const args = [...baseOptionsBuilder.clone().addOption(CMD_OPTIONS.outputFile, 'report.json').build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(formatDiagnosticsSpy).toHaveBeenCalled();

    getFormatterSpy.mockRestore();
  });

  it('passes custom --cache-dir to fetchSchemaStoreSchemas', async () => {
    const args = [...baseOptionsBuilder.clone().addOption(CMD_OPTIONS.cacheDir, '/custom/cache').build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(fetchSchemaStoreSchemasSpy).toHaveBeenCalledWith(expect.objectContaining({ cacheDir: '/custom/cache' }));
  });

  it('passes custom --cache-ttl to fetchSchemaStoreSchemas', async () => {
    const args = [...baseOptionsBuilder.clone().addOption(CMD_OPTIONS.cacheTtl, '7200').build(), 'test.yaml'];
    await command.parseAsync(args, { from: 'user' });

    expect(fetchSchemaStoreSchemasSpy).toHaveBeenCalledWith(expect.objectContaining({ cacheTtlSeconds: 7200 }));
  });
});
