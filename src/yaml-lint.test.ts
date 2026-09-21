/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://nodejs.org/api/path.html */
import path from 'node:path';
/** https://nodejs.org/api/url.html */
import { pathToFileURL } from 'node:url';
/** https://www.npmjs.com/package/yaml-language-server */
import { DiagnosticSeverity, SchemaPriority } from 'yaml-language-server';
/** https://www.npmjs.com/package/request-light */
import type { XHRResponse } from 'request-light';

import fg from 'fast-glob';
import { ManagedError } from './utils';
import {
  loadSchemaSettings,
  toFileUri,
  resolveFileGlobs,
  countDiagnostics,
  formatDiagnostics,
  fetchSchemaStoreSchemas,
  createLanguageService,
  isSchemaResolveError,
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
  getErrorStatusDescription: jest.fn((status: number) => `HTTP Error ${String(status)}`),
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

    const result = resolveFileGlobs(['a.yaml', 'b.yml'], []);

    expect(syncSpy).toHaveBeenCalledWith(['a.yaml', 'b.yml'], { dot: true, unique: true, ignore: [] });
    expect(result).toEqual(['a.yaml', 'b.yml']);
  });

  it('expands glob patterns including dotfiles', () => {
    syncSpy.mockReturnValue(['.gitlab-ci.yml', 'dir/one.yml', 'dir/two.yml']);

    const result = resolveFileGlobs(['**/*.yml'], []);

    expect(syncSpy).toHaveBeenCalledWith(['**/*.yml'], { dot: true, unique: true, ignore: [] });
    expect(result).toEqual(['.gitlab-ci.yml', 'dir/one.yml', 'dir/two.yml']);
  });

  it('passes ignore patterns to fast-glob', () => {
    syncSpy.mockReturnValue(['src/config.yml']);

    const result = resolveFileGlobs(['**/*.yml'], ['**/node_modules/**']);

    expect(syncSpy).toHaveBeenCalledWith(['**/*.yml'], {
      dot: true,
      unique: true,
      ignore: ['**/node_modules/**'],
    });
    expect(result).toEqual(['src/config.yml']);
  });

  it('deduplicates files matched by multiple patterns', () => {
    syncSpy.mockReturnValue(['shared.yml']);

    const result = resolveFileGlobs(['shared.yml', '*.yml'], []);

    expect(result).toEqual(['shared.yml']);
  });

  it('sorts results alphabetically', () => {
    syncSpy.mockReturnValue(['c.yml', 'a.yml']);

    const result = resolveFileGlobs(['*.yml'], []);

    expect(result).toEqual(['a.yml', 'c.yml']);
  });

  it('returns empty array when nothing matches', () => {
    syncSpy.mockReturnValue([]);

    const result = resolveFileGlobs(['no-match/**/*.yml'], []);

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
    expect(writeSpy).toHaveBeenCalledWith(
      path.join('/tmp/test-cache', 'schemastore-catalog.json'),
      catalogJson,
      'utf-8',
    );
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
    expect(readSpy).toHaveBeenCalledWith(path.join('/tmp/test-cache', 'schemastore-catalog.json'), 'utf-8');
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

  it('retries a transient catalog failure', async () => {
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const mkdirSpy = jest.spyOn(fs, 'mkdirSync').mockReturnValue(undefined);
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    const sleep = jest.fn(() => Promise.resolve());
    xhr
      .mockRejectedValueOnce({ status: 503, headers: { date: 'now' }, responseText: '', body: new Uint8Array() })
      .mockResolvedValueOnce({ responseText: catalogJson });

    const result = await fetchSchemaStoreSchemas(cacheOpts, { sleep });

    expect(xhr).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalled();
    expect(result[0].uri).toBe('https://json.schemastore.org/gitlab-ci');

    statSpy.mockRestore();
    mkdirSpy.mockRestore();
    writeSpy.mockRestore();
  });

  it('throws a ManagedError with the reason when the catalog cannot be fetched', async () => {
    const statSpy = jest.spyOn(fs, 'statSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    const writeSpy = jest.spyOn(fs, 'writeFileSync').mockImplementation();
    const sleep = jest.fn(() => Promise.resolve());
    const connectionFailure: XHRResponse = {
      status: 404,
      headers: {},
      responseText:
        'Unable to connect to https://www.schemastore.org/api/json/catalog.json through a proxy. Error: connect ECONNREFUSED 127.0.0.1:1',
      body: new Uint8Array(),
    };
    xhr.mockRejectedValue(connectionFailure);

    const promise = fetchSchemaStoreSchemas(cacheOpts, { sleep });

    await expect(promise).rejects.toBeInstanceOf(ManagedError);
    await expect(promise).rejects.toThrow(
      'Failed to fetch the Schema Store catalog from https://www.schemastore.org/api/json/catalog.json: ' +
        'Unable to connect to https://www.schemastore.org/api/json/catalog.json through a proxy. ' +
        'Error: connect ECONNREFUSED 127.0.0.1:1. Use --no-schema-store to skip it.',
    );
    expect(xhr).toHaveBeenCalledTimes(4);
    expect(writeSpy).not.toHaveBeenCalled();

    statSpy.mockRestore();
    writeSpy.mockRestore();
    xhr.mockReset();
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

describe('isSchemaResolveError', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

  it('is true for codes in the schema resolution range', () => {
    expect(isSchemaResolveError({ range, message: 'load', code: 0x10000 })).toBe(true);
    expect(isSchemaResolveError({ range, message: 'load', code: 0x10000 + 503 })).toBe(true);
  });

  it('is false for validation codes, string codes and missing codes', () => {
    expect(isSchemaResolveError({ range, message: 'not allowed', code: 513 })).toBe(false);
    expect(isSchemaResolveError({ range, message: 'custom', code: 'E123' })).toBe(false);
    expect(isSchemaResolveError({ range, message: 'syntax' })).toBe(false);
  });
});

describe('createLanguageService schema fetch retries', () => {
  const { xhr } = jest.requireMock<{ xhr: jest.Mock }>('request-light');

  const schemaUri = 'https://example.com/schema.json';
  const schemas = [{ uri: schemaUri, fileMatch: ['*.yaml'], priority: SchemaPriority.Settings }];
  const schemaResponse: XHRResponse = {
    status: 200,
    headers: { date: 'now' },
    responseText: JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    }),
    body: new Uint8Array(),
  };

  /**
   * Build the plain object request-light rejects with for an HTTP error response from a server.
   * @param status The HTTP status
   * @returns A rejection value shaped like request-light's XHRResponse
   */
  function httpFailure(status: number): XHRResponse {
    return { status, headers: { date: 'now' }, responseText: '', body: new Uint8Array() };
  }

  let sleep: jest.Mock<Promise<void>, []>;

  // The yaml-language-server caches parsed documents by URI and version, and lintFiles always creates version 0,
  // so every test here lints a distinct path to avoid picking up another test's parsed content.
  beforeEach(() => {
    xhr.mockReset();
    sleep = jest.fn(() => Promise.resolve());
    jest.spyOn(fs, 'readFileSync').mockReturnValue('name: test\n');
  });

  it('recovers from a transient 503 and validates the file', async () => {
    xhr.mockRejectedValueOnce(httpFailure(503)).mockResolvedValueOnce(schemaResponse);

    const service = createLanguageService(schemas, [], { sleep });
    const results = await lintFiles(service, ['/tmp/retry-recovers.yaml']);

    expect(results[0].diagnostics).toEqual([]);
    expect(xhr).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('validates against the schema fetched after a retry', async () => {
    jest.spyOn(fs, 'readFileSync').mockReturnValue('name: test\nextra: 1\n');
    xhr.mockRejectedValueOnce(httpFailure(503)).mockResolvedValueOnce(schemaResponse);

    const service = createLanguageService(schemas, [], { sleep });
    const results = await lintFiles(service, ['/tmp/retry-violation.yaml']);

    expect(results[0].diagnostics.map((d) => d.message)).toEqual(['Property extra is not allowed.']);
    // A genuine violation keeps the severity the language server gave it.
    expect(results[0].diagnostics[0].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('reports the reason when the retry budget is exhausted', async () => {
    xhr.mockRejectedValue(httpFailure(503));

    const service = createLanguageService(schemas, [], { sleep });
    const results = await lintFiles(service, ['/tmp/retry-exhausted.yaml']);

    expect(results[0].diagnostics.map((d) => d.message)).toEqual([
      `Unable to load schema from '${schemaUri}': HTTP 503 Service Unavailable.`,
    ]);
    // The language server reports this as a warning; the file was not checked, so it is promoted to an error.
    expect(results[0].diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
    expect(xhr).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it('does not retry a permanent 404', async () => {
    xhr.mockRejectedValue(httpFailure(404));

    const service = createLanguageService(schemas, [], { sleep });
    const results = await lintFiles(service, ['/tmp/retry-not-found.yaml']);

    expect(results[0].diagnostics.map((d) => d.message)).toEqual([
      `Unable to load schema from '${schemaUri}': HTTP 404 Not Found.`,
    ]);
    expect(results[0].diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
    expect(xhr).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reuses a failed schema load for later files instead of requesting again', async () => {
    xhr.mockRejectedValue(httpFailure(503));

    const service = createLanguageService(schemas, [], { sleep });
    const results = await lintFiles(service, ['/tmp/retry-cached-a.yaml', '/tmp/retry-cached-b.yaml']);

    expect(results).toHaveLength(2);
    expect(results[0].diagnostics).toHaveLength(1);
    expect(results[1].diagnostics).toHaveLength(1);
    // The language service caches the failed load, so the retry budget is spent once, inside the request service.
    expect(xhr).toHaveBeenCalledTimes(4);
  });
});
