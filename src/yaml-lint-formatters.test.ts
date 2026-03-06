import { createHash } from 'node:crypto';
import { DiagnosticSeverity, type Diagnostic } from 'yaml-language-server';

import type { LintFileResult } from './yaml-lint';
import { formatGitHubAnnotations, gitlabCodeQualityFormatter, getFormatter } from './yaml-lint-formatters';

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

describe('formatGitHubAnnotations', () => {
  it('returns empty string for no results', () => {
    expect(formatGitHubAnnotations([])).toBe('');
  });

  it('returns empty string when all files are clean', () => {
    const results: LintFileResult[] = [{ filePath: 'clean.yaml', diagnostics: [] }];

    expect(formatGitHubAnnotations(results)).toBe('');
  });

  it('maps Error severity to ::error', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Error, message: 'bad' })] },
    ];

    expect(formatGitHubAnnotations(results)).toContain('::error ');
  });

  it('maps Warning severity to ::warning', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Warning, message: 'warn' })] },
    ];

    expect(formatGitHubAnnotations(results)).toContain('::warning ');
  });

  it('maps Information severity to ::notice', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Information, message: 'info' })] },
    ];

    expect(formatGitHubAnnotations(results)).toContain('::notice ');
  });

  it('maps Hint severity to ::notice', () => {
    const results: LintFileResult[] = [
      { filePath: 'test.yaml', diagnostics: [makeDiag({ severity: DiagnosticSeverity.Hint, message: 'hint' })] },
    ];

    expect(formatGitHubAnnotations(results)).toContain('::notice ');
  });

  it('includes file, line, col, endLine, endColumn, and title parameters', () => {
    const results: LintFileResult[] = [
      {
        filePath: 'config.yaml',
        diagnostics: [makeDiag({ line: 4, character: 2, message: 'Unexpected key', source: 'yaml-schema' })],
      },
    ];

    const output = formatGitHubAnnotations(results);

    expect(output).toBe(
      '::error file=config.yaml,line=5,endLine=5,col=3,endColumn=4,title=yaml-schema::Unexpected key',
    );
  });

  it('defaults title to yaml-lint when source is undefined', () => {
    const results: LintFileResult[] = [{ filePath: 'test.yaml', diagnostics: [makeDiag({ source: undefined })] }];

    expect(formatGitHubAnnotations(results)).toContain('title=yaml-lint::');
  });

  it('handles multiple files and diagnostics', () => {
    const results: LintFileResult[] = [
      { filePath: 'a.yaml', diagnostics: [makeDiag({ message: 'err a' })] },
      {
        filePath: 'b.yaml',
        diagnostics: [
          makeDiag({ message: 'err b1', severity: DiagnosticSeverity.Warning }),
          makeDiag({ line: 1, message: 'err b2' }),
        ],
      },
    ];

    const lines = formatGitHubAnnotations(results).split('\n');

    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('file=a.yaml');
    expect(lines[0]).toContain('::err a');
    expect(lines[1]).toContain('::warning ');
    expect(lines[1]).toContain('file=b.yaml');
    expect(lines[2]).toContain('::error ');
    expect(lines[2]).toContain('file=b.yaml');
  });

  it('uses 1-based line and column numbers', () => {
    const results: LintFileResult[] = [{ filePath: 'test.yaml', diagnostics: [makeDiag({ line: 9, character: 3 })] }];

    const output = formatGitHubAnnotations(results);

    expect(output).toContain('line=10');
    expect(output).toContain('col=4');
  });
});

describe('getFormatter', () => {
  it('returns the gitlab-codequality formatter', () => {
    expect(getFormatter('gitlab-codequality')).toBe(gitlabCodeQualityFormatter);
  });

  it('throws for an unknown format name', () => {
    expect(() => getFormatter('unknown')).toThrow('Unknown format "unknown"');
  });
});
