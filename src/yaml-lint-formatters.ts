import { createHash } from 'node:crypto';
import { DiagnosticSeverity, type Diagnostic } from 'yaml-language-server';

import type { LintFileResult } from './yaml-lint';

/** A formatter that converts lint results to a string suitable for writing to a file. */
export interface OutputFormatter {
  /** @param results The lint results to format */
  formatToString(results: LintFileResult[]): string;
}

export const FORMAT_CHOICES = ['gitlab-codequality'] as const;
export type FormatChoice = (typeof FORMAT_CHOICES)[number];

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

/**
 * Map a DiagnosticSeverity to its GitHub Actions annotation command.
 * @param severity The diagnostic severity
 * @returns The annotation command string ("error", "warning", or "notice")
 */
function ghAnnotationLevel(severity: DiagnosticSeverity | undefined): 'error' | 'warning' | 'notice' {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
    case DiagnosticSeverity.Hint:
      return 'notice';
    default:
      return 'notice';
  }
}

/**
 * Format lint results as GitHub Actions workflow annotation commands.
 *
 * Each diagnostic becomes a `::error`, `::warning`, or `::notice` line
 * that GitHub Actions renders as an inline annotation on the PR diff.
 * @param results The lint results to format
 * @returns A multi-line string of annotation commands, or empty string if no diagnostics
 * @see https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions
 */
export function formatGitHubAnnotations(results: LintFileResult[]): string {
  const lines: string[] = [];

  for (const { filePath, diagnostics } of results) {
    for (const diag of diagnostics) {
      const level = ghAnnotationLevel(diag.severity);
      const line = diag.range.start.line + 1;
      const col = diag.range.start.character + 1;
      const endLine = diag.range.end.line + 1;
      const endColumn = diag.range.end.character + 1;
      const title = diag.source ?? 'yaml-lint';

      lines.push(
        `::${level} file=${filePath},line=${String(line)},endLine=${String(endLine)},col=${String(col)},endColumn=${String(endColumn)},title=${title}::${diag.message}`,
      );
    }
  }

  return lines.join('\n');
}

const FORMATTERS: Record<FormatChoice, OutputFormatter> = {
  'gitlab-codequality': gitlabCodeQualityFormatter,
};

/**
 * Look up a registered output formatter by name.
 * @param name The format name
 * @returns The matching OutputFormatter
 * @throws {Error} If the name is not registered
 */
export function getFormatter(name: string): OutputFormatter {
  if (name in FORMATTERS) {
    return FORMATTERS[name as FormatChoice];
  }
  const valid = Object.keys(FORMATTERS).join(', ');
  throw new Error(`Unknown format "${name}". Valid formats: ${valid}`);
}
