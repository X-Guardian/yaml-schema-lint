/** https://nodejs.org/api/crypto.html */
import { createHash } from 'node:crypto';
/** https://www.npmjs.com/package/yaml-language-server */
import { DiagnosticSeverity, type Diagnostic } from 'yaml-language-server';

import type { FormatChoice } from './constants';
import type { LintFileResult, OutputFormatter } from './interfaces';

export type { OutputFormatter } from './interfaces';

/** A GitLab Code Quality report entry. */
interface GitLabCodeQualityEntry {
  description: string;
  check_name: string;
  fingerprint: string;
  severity: 'info' | 'minor' | 'major' | 'critical' | 'blocker';
  location: {
    path: string;
    lines: { begin: number };
  };
}

/**
 * Map a DiagnosticSeverity to its GitLab Code Quality equivalent.
 * @param severity The diagnostic severity
 * @returns The GitLab severity string
 */
function mapSeverity(severity: DiagnosticSeverity | undefined): GitLabCodeQualityEntry['severity'] {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'major';
    case DiagnosticSeverity.Warning:
      return 'minor';
    case DiagnosticSeverity.Information:
    case DiagnosticSeverity.Hint:
      return 'info';
    default:
      return 'info';
  }
}

/**
 * Generate a deterministic fingerprint for a diagnostic.
 * @param filePath The file path
 * @param line The 1-based line number
 * @param message The diagnostic message
 * @returns An MD5 hex digest
 */
function fingerprint(filePath: string, line: number, message: string): string {
  return createHash('md5')
    .update(`${filePath}:${String(line)}:${message}`)
    .digest('hex');
}

/**
 * Convert lint results to a GitLab Code Quality JSON report.
 * @see https://docs.gitlab.com/ci/testing/code_quality/#code-quality-report-format
 */
export const gitlabCodeQualityFormatter: OutputFormatter = {
  formatToString(results: LintFileResult[]): string {
    const entries: GitLabCodeQualityEntry[] = [];

    for (const { filePath, diagnostics } of results) {
      for (const diag of diagnostics) {
        const line = diag.range.start.line + 1;
        entries.push({
          description: diag.message,
          check_name: checkName(diag),
          fingerprint: fingerprint(filePath, line, diag.message),
          severity: mapSeverity(diag.severity),
          location: { path: filePath, lines: { begin: line } },
        });
      }
    }

    return JSON.stringify(entries, null, 2);
  },
};

/**
 * Derive a check_name from a diagnostic.
 * @param diag The diagnostic
 * @returns A check name string
 */
function checkName(diag: Diagnostic): string {
  return diag.source ?? 'yaml-lint';
}

/** JSON report severity strings. */
type JsonSeverity = 'error' | 'warning' | 'information' | 'hint';

/** A single diagnostic in the JSON report format. */
interface JsonDiagnosticEntry {
  message: string;
  severity: JsonSeverity;
  source: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** A per-file entry in the JSON report format. */
interface JsonFileEntry {
  filePath: string;
  diagnostics: JsonDiagnosticEntry[];
}

/**
 * Map a DiagnosticSeverity to a portable JSON string.
 * @param severity The diagnostic severity
 * @returns A lowercase severity string
 */
function jsonSeverity(severity: DiagnosticSeverity | undefined): JsonSeverity {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'information';
    case DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'warning';
  }
}

/**
 * Convert lint results to a portable JSON report.
 *
 * Uses 1-based line/column numbers and string severity values so
 * downstream consumers (e.g. a GitHub Action) don't need to know
 * about the yaml-language-server DiagnosticSeverity enum.
 */
export const jsonFormatter: OutputFormatter = {
  formatToString(results: LintFileResult[]): string {
    const entries: JsonFileEntry[] = results.map(({ filePath, diagnostics }) => ({
      filePath,
      diagnostics: diagnostics.map((diag) => ({
        message: diag.message,
        severity: jsonSeverity(diag.severity),
        source: diag.source ?? 'yaml-lint',
        range: {
          start: { line: diag.range.start.line + 1, character: diag.range.start.character + 1 },
          end: { line: diag.range.end.line + 1, character: diag.range.end.character + 1 },
        },
      })),
    }));

    return JSON.stringify(entries, null, 2);
  },
};

const FORMATTERS: Record<FormatChoice, OutputFormatter> = {
  'gitlab-codequality': gitlabCodeQualityFormatter,
  json: jsonFormatter,
};

/**
 * Look up a registered output formatter by name.
 * @param name The format name
 * @returns The matching OutputFormatter
 * @throws {Error} If the name is not registered
 */
export function getFormatter(name: string): OutputFormatter {
  if (name in FORMATTERS) {
    return FORMATTERS[name];
  }
  const valid = Object.keys(FORMATTERS).join(', ');
  throw new Error(`Unknown format "${name}". Valid formats: ${valid}`);
}
