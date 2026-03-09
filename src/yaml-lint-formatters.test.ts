/** https://nodejs.org/api/crypto.html */
import { createHash } from 'node:crypto';
/** https://www.npmjs.com/package/yaml-language-server */
import { DiagnosticSeverity, type Diagnostic } from 'yaml-language-server';

import type { LintFileResult } from './yaml-lint';
import { gitlabCodeQualityFormatter, jsonFormatter, getFormatter } from './yaml-lint-formatters';

/** Parsed GitLab Code Quality report entry for test assertions. */
interface ParsedEntry {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: string;
  location: { path: string; lines: { begin: number } };
}

/**
 * Parse a JSON string into an array of GitLab Code Quality entries.
 * @param json - Raw JSON string to parse
 * @returns Parsed code quality entries
 */
function parseEntries(json: string): ParsedEntry[] {
  return JSON.parse(json) as ParsedEntry[];
}

/**
 * Create a test Diagnostic object with optional overrides.
 * @param overrides Optional diagnostic field overrides
 * @returns A Diagnostic object
 */
function makeDiag(
  overrides: Partial<{
    line: number;
    character: number;
    message: string;
    severity: DiagnosticSeverity;
    source: string;
  }> = {},
): Diagnostic {
  return {
    range: {
      start: { line: overrides.line ?? 0, character: overrides.character ?? 0 },
      end: { line: overrides.line ?? 0, character: (overrides.character ?? 0) + 1 },
    },
    message: overrides.message ?? 'test error',
    severity: overrides.severity ?? DiagnosticSeverity.Error,
    source: overrides.source,
  };
}

describe('gitlabCodeQualityFormatter', () => {
  it('returns an empty JSON array for no results', () => {
    const output = gitlabCodeQualityFormatter.formatToString([]);

    expect(parseEntries(output)).toEqual([]);
  });

  it('returns an empty JSON array when all files are clean', () => {
    const results: LintFileResult[] = [{ filePath: 'clean.yaml', diagnostics: [] }];

    const output = gitlabCodeQualityFormatter.formatToString(results);

    expect(parseEntries(output)).toEqual([]);
  });

  it('maps Error severity to major', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Error })] },
    ];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries[0].severity).toBe('major');
  });

  it('maps Warning severity to minor', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Warning })] },
    ];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries[0].severity).toBe('minor');
  });

  it('maps Information severity to info', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Information })] },
    ];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries[0].severity).toBe('info');
  });

  it('maps Hint severity to info', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Hint })] },
    ];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries[0].severity).toBe('info');
  });

  it('produces valid entry structure', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'config.yaml',
        diagnostics: [
          makeDiag({
            line: 4,
            character: 2,
            message: 'Unexpected key',
            severity: DiagnosticSeverity.Error,
            source: 'yaml-schema',
          }),
        ],
      },
    ];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      description: 'Unexpected key',
      check_name: 'yaml-schema',
      fingerprint: createHash('md5').update('config.yaml:5:Unexpected key').digest('hex'),
      severity: 'major',
      location: { path: 'config.yaml', lines: { begin: 5 } },
    });
  });

  it('defaults check_name to yaml-lint when source is undefined', () => {
    const results: LintFileResult[] = [{ filePath: 'test.yaml', diagnostics: [makeDiag({ source: undefined })] }];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries[0].check_name).toBe('yaml-lint');
  });

  it('generates unique fingerprints for different diagnostics', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'test.yaml',
        diagnostics: [makeDiag({ line: 0, message: 'first error' }), makeDiag({ line: 1, message: 'second error' })],
      },
    ];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries[0].fingerprint).not.toBe(entries[1].fingerprint);
  });

  it('collects diagnostics from multiple files', () => {
    const results: LintFileResult[] = [
      { filePath: 'a.yaml', diagnostics: [makeDiag({ message: 'err a' })] },
      { filePath: 'b.yaml', diagnostics: [makeDiag({ message: 'err b1' }), makeDiag({ line: 1, message: 'err b2' })] },
    ];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries).toHaveLength(3);
    expect(entries[0].location.path).toBe('a.yaml');
    expect(entries[1].location.path).toBe('b.yaml');
    expect(entries[2].location.path).toBe('b.yaml');
  });

  it('uses 1-based line numbers', () => {
    const results: LintFileResult[] = [{ filePath: 'test.yaml', diagnostics: [makeDiag({ line: 9 })] }];

    const entries = parseEntries(gitlabCodeQualityFormatter.formatToString(results));

    expect(entries[0].location.lines.begin).toBe(10);
  });
});

/** Parsed JSON report entry for test assertions. */
interface JsonFileEntry {
  filePath: string;
  diagnostics: {
    message: string;
    severity: string;
    source: string;
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }[];
}

/**
 * Parse a JSON report string into an array of file entries.
 * @param json Raw JSON string
 * @returns Parsed file entries
 */
function parseJsonReport(json: string): JsonFileEntry[] {
  return JSON.parse(json) as JsonFileEntry[];
}

describe('jsonFormatter', () => {
  it('returns an empty JSON array for no results', () => {
    expect(parseJsonReport(jsonFormatter.formatToString([]))).toEqual([]);
  });

  it('includes clean files with empty diagnostics', () => {
    const results: LintFileResult[] = [{ filePath: 'clean.yaml', diagnostics: [] }];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries).toHaveLength(1);
    expect(entries[0].filePath).toBe('clean.yaml');
    expect(entries[0].diagnostics).toEqual([]);
  });

  it('maps Error severity to "error"', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Error })] },
    ];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries[0].diagnostics[0].severity).toBe('error');
  });

  it('maps Warning severity to "warning"', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Warning })] },
    ];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries[0].diagnostics[0].severity).toBe('warning');
  });

  it('maps Information severity to "information"', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Information })] },
    ];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries[0].diagnostics[0].severity).toBe('information');
  });

  it('maps Hint severity to "hint"', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Hint })] },
    ];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries[0].diagnostics[0].severity).toBe('hint');
  });

  it('produces valid entry structure with 1-based positions', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'config.yaml',
        diagnostics: [
          makeDiag({
            line: 4,
            character: 2,
            message: 'Unexpected key',
            severity: DiagnosticSeverity.Error,
            source: 'yaml-schema',
          }),
        ],
      },
    ];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      filePath: 'config.yaml',
      diagnostics: [
        {
          message: 'Unexpected key',
          severity: 'error',
          source: 'yaml-schema',
          range: {
            start: { line: 5, character: 3 },
            end: { line: 5, character: 4 },
          },
        },
      ],
    });
  });

  it('defaults source to "yaml-lint" when source is undefined', () => {
    const results: LintFileResult[] = [{ filePath: 'test.yaml', diagnostics: [makeDiag({ source: undefined })] }];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries[0].diagnostics[0].source).toBe('yaml-lint');
  });

  it('collects diagnostics from multiple files', () => {
    const results: LintFileResult[] = [
      { filePath: 'a.yaml', diagnostics: [makeDiag({ message: 'err a' })] },
      { filePath: 'b.yaml', diagnostics: [makeDiag({ message: 'err b1' }), makeDiag({ line: 1, message: 'err b2' })] },
    ];

    const entries = parseJsonReport(jsonFormatter.formatToString(results));

    expect(entries).toHaveLength(2);
    expect(entries[0].filePath).toBe('a.yaml');
    expect(entries[0].diagnostics).toHaveLength(1);
    expect(entries[1].filePath).toBe('b.yaml');
    expect(entries[1].diagnostics).toHaveLength(2);
  });
});

describe('getFormatter', () => {
  it('returns the gitlab-codequality formatter', () => {
    expect(getFormatter('gitlab-codequality')).toBe(gitlabCodeQualityFormatter);
  });

  it('returns the json formatter', () => {
    expect(getFormatter('json')).toBe(jsonFormatter);
  });

  it('throws for an unknown format name', () => {
    expect(() => getFormatter('unknown')).toThrow('Unknown format "unknown"');
  });
});
