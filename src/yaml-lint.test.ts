import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DiagnosticSeverity } from 'yaml-language-server';

import fg from 'fast-glob';
import {
  loadSchemaSettings,
  toFileUri,
  resolveFileGlobs,
  countDiagnostics,
  formatDiagnostics,
  fetchSchemaStoreSchemas,
  createLanguageService,
  lintFiles,
  type LintFileResult,
  type SchemaStoreCacheOptions,
} from './yaml-lint';

jest.mock('colorette', () => ({
  bold: (t: string) => t,
  underline: (t: string) => t,
  red: (t: string) => t,
  yellow: (t: string) => t,
  cyan: (t: string) => t,
  gray: (t: string) => t,
  dim: (t: string) => t,
}));

jest.mock('request-light', () => ({
  xhr: jest.fn(),
  getErrorStatusDescription: jest.fn((status: number) => `HTTP Error ${status}`),
}));

const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation();

beforeEach(() => {
  jest.clearAllMocks();
  consoleLogSpy.mockImplementation();
});

describe('loadSchemaSettings', () => {
  it('returns empty settings when file does not exist', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = loadSchemaSettings('/nonexistent/settings.json');

    expect(result).toEqual({ schemas: [], customTags: [] });
  });

  it('returns empty settings when file contains invalid JSON', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue('not valid json');

    const result = loadSchemaSettings('/some/settings.json');

    expect(result).toEqual({ schemas: [], customTags: [] });
  });

  it('parses yaml.schemas with string glob values', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        'yaml.schemas': {
          'https://example.com/schema.json': '*.yml',
        },
      }),
    );

    const result = loadSchemaSettings('/some/settings.json');

    expect(result.schemas).toHaveLength(1);
    expect(result.schemas[0]).toEqual({
      uri: 'https://example.com/schema.json',
      fileMatch: ['*.yml'],
      priority: 3,
    });
  });

  it('parses yaml.schemas with array glob values', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        'yaml.schemas': {
          'https://example.com/schema.json': ['a.yml', 'b.yml'],
        },
      }),
    );

    const result = loadSchemaSettings('/some/settings.json');

    expect(result.schemas).toHaveLength(1);
    expect(result.schemas[0].fileMatch).toEqual(['a.yml', 'b.yml']);
  });

  it('parses multiple schema entries', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        'yaml.schemas': {
          'https://example.com/a.json': '*.yml',
          'https://example.com/b.json': ['ci/*.yml'],
        },
      }),
    );

    const result = loadSchemaSettings('/some/settings.json');

    expect(result.schemas).toHaveLength(2);
  });

  it('parses yaml.customTags', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        'yaml.schemas': {},
        'yaml.customTags': ['!reference sequence', '!Ref'],
      }),
    );

    const result = loadSchemaSettings('/some/settings.json');

    expect(result.customTags).toEqual(['!reference sequence', '!Ref']);
  });

  it('returns empty customTags when yaml.customTags is not present', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        'yaml.schemas': {},
      }),
    );

    const result = loadSchemaSettings('/some/settings.json');

    expect(result.customTags).toEqual([]);
  });

  it('returns empty schemas when yaml.schemas is not present', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify({ other: 'setting' }));

    const result = loadSchemaSettings('/some/settings.json');

    expect(result.schemas).toEqual([]);
  });

  it('filters non-string values from yaml.customTags', () => {
    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        'yaml.customTags': ['!Ref', 42, null, '!Sub'],
      }),
    );

    const result = loadSchemaSettings('/some/settings.json');

    expect(result.customTags).toEqual(['!Ref', '!Sub']);
  });
});

describe('toFileUri', () => {
  it('converts an absolute path to a file URI', () => {
    const result = toFileUri('/home/user/test.yaml');

    expect(result).toBe(pathToFileURL('/home/user/test.yaml').toString());
  });

  it('resolves a relative path to an absolute file URI', () => {
    const result = toFileUri('test.yaml');
    const expected = pathToFileURL(path.resolve('test.yaml')).toString();

    expect(result).toBe(expected);
  });
});

describe('countDiagnostics', () => {
  it('returns zero counts for empty results', () => {
    expect(countDiagnostics([])).toEqual({ errorCount: 0, warningCount: 0 });
  });

  it('counts errors and warnings without printing', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'a.yaml',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: 'err',
            severity: DiagnosticSeverity.Error,
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
            message: 'warn',
            severity: DiagnosticSeverity.Warning,
          },
        ],
      },
    ];

    const result = countDiagnostics(results);

    expect(result).toEqual({ errorCount: 1, warningCount: 1 });
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });
});

describe('formatDiagnostics', () => {
  it('returns zero counts for empty results', () => {
    const result = formatDiagnostics([]);

    expect(result).toEqual({ errorCount: 0, warningCount: 0 });
  });

  it('returns zero counts when all files are clean', () => {
    const results: LintFileResult[] = [{ filePath: 'test.yaml', diagnostics: [] }];

    const result = formatDiagnostics(results);

    expect(result).toEqual({ errorCount: 0, warningCount: 0 });
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it('counts errors correctly', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'test.yaml',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            message: 'Syntax error',
            severity: DiagnosticSeverity.Error,
            source: 'yaml',
          },
          {
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 10 } },
            message: 'Another error',
            severity: DiagnosticSeverity.Error,
          },
        ],
      },
    ];

    const result = formatDiagnostics(results);

    expect(result).toEqual({ errorCount: 2, warningCount: 0 });
  });

  it('counts warnings correctly', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'test.yaml',
        diagnostics: [
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
            message: 'A warning',
            severity: DiagnosticSeverity.Warning,
          },
        ],
      },
    ];

    const result = formatDiagnostics(results);

    expect(result).toEqual({ errorCount: 0, warningCount: 1 });
  });

  it('prints a file header followed by indented diagnostic lines', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'config.yaml',
        diagnostics: [
          {
            range: { start: { line: 4, character: 2 }, end: { line: 4, character: 10 } },
            message: 'Unexpected property',
            severity: DiagnosticSeverity.Error,
            source: 'yaml-schema',
          },
        ],
      },
    ];

    formatDiagnostics(results);

    expect(consoleLogSpy).toHaveBeenCalledWith('config.yaml');
    expect(consoleLogSpy).toHaveBeenCalledWith('  5:3  error  Unexpected property  (yaml-schema)');
  });

  it('omits source parentheses when source is undefined', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'test.yaml',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: 'Some error',
            severity: DiagnosticSeverity.Error,
          },
        ],
      },
    ];

    formatDiagnostics(results);

    expect(consoleLogSpy).toHaveBeenCalledWith('  1:1  error  Some error  ');
  });

  it('aligns columns across diagnostics within a file', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'file.yml',
        diagnostics: [
          {
            range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } },
            message: 'short',
            severity: DiagnosticSeverity.Error,
          },
          {
            range: { start: { line: 99, character: 11 }, end: { line: 99, character: 15 } },
            message: 'another',
            severity: DiagnosticSeverity.Warning,
          },
        ],
      },
    ];

    formatDiagnostics(results);

    const calls = consoleLogSpy.mock.calls.map((c) => c[0] as string);
    const diagLines = calls.filter((c) => c.startsWith('  '));
    expect(diagLines).toHaveLength(2);
    expect(diagLines[0]).toBe('  1:4     error    short  ');
    expect(diagLines[1]).toBe('  100:12  warning  another  ');
  });

  it('counts mixed errors and warnings across multiple files', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'a.yaml',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: 'err',
            severity: DiagnosticSeverity.Error,
          },
        ],
      },
      {
        filePath: 'b.yaml',
        diagnostics: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            message: 'warn',
            severity: DiagnosticSeverity.Warning,
          },
          {
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
            message: 'info',
            severity: DiagnosticSeverity.Information,
          },
        ],
      },
    ];

    const result = formatDiagnostics(results);

    expect(result).toEqual({ errorCount: 1, warningCount: 1 });
    expect(consoleLogSpy).toHaveBeenCalledWith('a.yaml');
    expect(consoleLogSpy).toHaveBeenCalledWith('b.yaml');
  });
});

describe('resolveFileGlobs', () => {
  const syncSpy = jest.spyOn(fg, 'sync');

  it('passes all patterns to fast-glob with dot enabled', () => {
    syncSpy.mockReturnValue(['a.yaml', 'b.yml']);

    const result = resolveFileGlobs(['a.yaml', 'b.yml']);

    expect(syncSpy).toHaveBeenCalledWith(['a.yaml', 'b.yml'], { dot: true, unique: true });
    expect(result).toEqual(['a.yaml', 'b.yml']);
  });

  it('expands glob patterns including dotfiles', () => {
    syncSpy.mockReturnValue(['.gitlab-ci.yml', 'dir/one.yml', 'dir/two.yml']);

    const result = resolveFileGlobs(['**/*.yml']);

    expect(syncSpy).toHaveBeenCalledWith(['**/*.yml'], { dot: true, unique: true });
    expect(result).toEqual(['.gitlab-ci.yml', 'dir/one.yml', 'dir/two.yml']);
  });

  it('deduplicates files matched by multiple patterns', () => {
    syncSpy.mockReturnValue(['shared.yml']);

    const result = resolveFileGlobs(['shared.yml', '*.yml']);

    expect(result).toEqual(['shared.yml']);
  });

  it('sorts results alphabetically', () => {
    syncSpy.mockReturnValue(['c.yml', 'a.yml']);

    const result = resolveFileGlobs(['*.yml']);

    expect(result).toEqual(['a.yml', 'c.yml']);
  });

  it('returns empty array when nothing matches', () => {
    syncSpy.mockReturnValue([]);

    const result = resolveFileGlobs(['no-match/**/*.yml']);

    expect(result).toEqual([]);
  });
});

describe('fetchSchemaStoreSchemas', () => {
  const { xhr } = jest.requireMock<{ xhr: jest.Mock }>('request-light');

  const catalogJson = JSON.stringify({
    schemas: [
      { name: 'GitLab CI', url: 'https://json.schemastore.org/gitlab-ci', fileMatch: ['.gitlab-ci.yml'] },
      { name: 'JSON only', url: 'https://example.com/json.json', fileMatch: ['*.json'] },
    ],
  });

  const cacheOpts: SchemaStoreCacheOptions = { cacheDir: '/tmp/test-cache', cacheTtlSeconds: 3600 };

  it('fetches from network and writes cache when no cache file exists', async () => {
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    xhr.mockResolvedValue({ responseText: catalogJson });

    const result = await fetchSchemaStoreSchemas(cacheOpts);

    expect(xhr).toHaveBeenCalled();
    expect(mkdirSpy).toHaveBeenCalledWith('/tmp/test-cache', { recursive: true });
    expect(writeSpy).toHaveBeenCalledWith('/tmp/test-cache/schemastore-catalog.json', catalogJson, 'utf-8');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].uri).toBe('https://json.schemastore.org/gitlab-ci');

    statSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('reads from cache when cache file is fresh', async () => {
    const freshMtime = Date.now() - 1000;
    const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: freshMtime } as fs.Stats);
    const readSpy = jest.spyOn(fs, 'readFileSync').mockReturnValue(catalogJson);

    const result = await fetchSchemaStoreSchemas(cacheOpts);

    expect(xhr).not.toHaveBeenCalled();
    expect(readSpy).toHaveBeenCalledWith('/tmp/test-cache/schemastore-catalog.json', 'utf-8');
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].uri).toBe('https://json.schemastore.org/gitlab-ci');

    statSpy.mockRestore();
    readSpy.mockRestore();
  });

  it('fetches from network when cache file is stale', async () => {
    const staleMtime = Date.now() - 4000 * 1000;
    const statSpy = jest.spyOn(fs, 'statSync').mockReturnValue({ mtimeMs: staleMtime } as fs.Stats);
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    xhr.mockResolvedValue({ responseText: catalogJson });

    const result = await fetchSchemaStoreSchemas(cacheOpts);

    expect(xhr).toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalled();
    expect(result[0].uri).toBe('https://json.schemastore.org/gitlab-ci');

    statSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('creates the cache directory if it does not exist', async () => {
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    xhr.mockResolvedValue({ responseText: catalogJson });

    await fetchSchemaStoreSchemas({ cacheDir: '/new/dir', cacheTtlSeconds: 60 });

    expect(mkdirSpy).toHaveBeenCalledWith('/new/dir', { recursive: true });

    statSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('filters out non-YAML schemas', async () => {
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    jest.spyOn(fs, 'writeFileSync').mockImplementation();
    xhr.mockResolvedValue({ responseText: catalogJson });

    const result = await fetchSchemaStoreSchemas(cacheOpts);

    const uris = result.map((s) => s.uri);
    expect(uris).toContain('https://json.schemastore.org/gitlab-ci');
    expect(uris).not.toContain('https://example.com/json.json');

    statSpy.mockRestore();
  });
});

describe('createLanguageService', () => {
  it('returns a language service with doValidation method', () => {
    const service = createLanguageService([], []);

    expect(service).toBeDefined();
    expect(typeof service.doValidation).toBe('function');
  });
});

describe('lintFiles', () => {
  it('returns results for each file', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('key: value\n');

    const service = createLanguageService([], []);
    const results = await lintFiles(service, ['/tmp/test.yaml']);

    expect(results).toHaveLength(1);
    expect(results[0].filePath).toBe('/tmp/test.yaml');
    expect(Array.isArray(results[0].diagnostics)).toBe(true);
  });

  it('returns diagnostics for invalid YAML', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('invalid: yaml: content: [broken\n');

    const service = createLanguageService([], []);
    const results = await lintFiles(service, ['/tmp/bad.yaml']);

    expect(results).toHaveLength(1);
    expect(results[0].diagnostics.length).toBeGreaterThan(0);
  });

  it('returns empty diagnostics for valid YAML', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('name: test\nversion: 1\n');

    const service = createLanguageService([], []);
    const results = await lintFiles(service, ['/tmp/good.yaml']);

    expect(results).toHaveLength(1);
    expect(results[0].diagnostics).toHaveLength(0);
  });
});
