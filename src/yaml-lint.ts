/** https://nodejs.org/api/fs.html */
import fs from 'node:fs';
/** https://nodejs.org/api/path.html */
import path from 'node:path';
/** https://nodejs.org/api/url.html */
import { URL as NodeURL, fileURLToPath, pathToFileURL } from 'node:url';
/** https://www.npmjs.com/package/colorette */
import * as colorette from 'colorette';
/** https://www.npmjs.com/package/fast-glob */
import * as fastGlob from 'fast-glob';
/** https://www.npmjs.com/package/vscode-languageserver-textdocument */
import { TextDocument } from 'vscode-languageserver-textdocument';
/** https://www.npmjs.com/package/yaml-language-server */
import {
  getLanguageService,
  type LanguageService,
  type LanguageSettings,
  type SchemasSettings,
  SchemaPriority,
  DiagnosticSeverity,
} from 'yaml-language-server';
/** https://www.npmjs.com/package/request-light */
import { xhr, getErrorStatusDescription, type XHRResponse } from 'request-light';

import { CACHE_FILENAME, SCHEMA_STORE_CATALOG_URL, YAML_FILE_EXTENSIONS } from './constants';
import type { LintFileResult, SchemaStoreCacheOptions, VscodeYamlSettings } from './interfaces';
import { consoleDebug } from './utils';

export type { LintFileResult, SchemaStoreCacheOptions, VscodeYamlSettings } from './interfaces';

/**
 * Parse a URI string and return its scheme in lowercase.
 * Handles both standard URIs and Windows paths (e.g. c:\...).
 * @param uri The URI string to parse
 * @returns The scheme in lowercase (e.g. "file", "https"), or empty string on failure
 */
function getUriScheme(uri: string): string {
  if (/^[a-z]:[\\/]/i.test(uri)) {
    return 'file';
  }
  try {
    return new NodeURL(uri).protocol.replace(/:$/, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Schema request handler that fetches schema content from file:// or http(s):// URIs.
 * @param uri The schema URI to fetch
 * @returns The schema content as a string
 */
async function schemaRequestService(uri: string): Promise<string> {
  if (!uri) {
    return Promise.reject(new Error('No schema specified'));
  }

  const scheme = getUriScheme(uri);

  if (scheme === 'file') {
    const fsPath = /^[a-z]:[\\/]/i.test(uri) ? uri : fileURLToPath(uri);
    return fs.promises.readFile(fsPath, 'utf-8').catch(() => '');
  }

  if (scheme === 'http' || scheme === 'https') {
    const headers = { 'Accept-Encoding': 'gzip, deflate' };
    return xhr({ url: uri, followRedirects: 5, headers }).then(
      (response) => response.responseText,
      (error: unknown) => {
        const xhrError = error as XHRResponse;
        return Promise.reject(
          new Error(
            xhrError.responseText || getErrorStatusDescription(xhrError.status) || 'Unknown schema fetch error',
          ),
        );
      },
    );
  }

  return Promise.reject(new Error(`Unsupported schema URI scheme: ${scheme}`));
}

/** A workspace context for the yaml-language-server. */
const workspaceContext = {
  resolveRelativePath: (relativePath: string, resource: string): string => {
    return new URL(relativePath, resource).toString();
  },
};

interface SchemaStoreCatalogEntry {
  name?: string;
  description?: string;
  fileMatch?: string[];
  url?: string;
  versions?: Record<string, string>;
}

interface SchemaStoreCatalog {
  schemas: SchemaStoreCatalogEntry[];
}

/**
 * Fetch the raw Schema Store catalog from the network.
 * @returns The parsed catalog object
 */
async function fetchCatalogFromNetwork(): Promise<SchemaStoreCatalog> {
  const headers = { 'Accept-Encoding': 'gzip, deflate' };
  const response = await xhr({ url: SCHEMA_STORE_CATALOG_URL, followRedirects: 5, headers });
  return JSON.parse(response.responseText) as SchemaStoreCatalog;
}

/**
 * Check whether a cache file exists and is still within its TTL.
 * @param cachePath Absolute path to the cache file
 * @param ttlMs TTL in milliseconds
 * @returns True if the cache file is fresh
 */
function isCacheFresh(cachePath: string, ttlMs: number): boolean {
  try {
    const stat = fs.statSync(cachePath);
    return Date.now() - stat.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

/**
 * Extract YAML-relevant schema associations from a catalog.
 * @param catalog The Schema Store catalog
 * @returns Schema associations for YAML files
 */
function extractYamlSchemas(catalog: SchemaStoreCatalog): SchemasSettings[] {
  const schemas: SchemasSettings[] = [];

  for (const entry of catalog.schemas) {
    if (!entry.url || !entry.fileMatch) {
      continue;
    }

    for (const pattern of entry.fileMatch) {
      const isYamlMatch = YAML_FILE_EXTENSIONS.some((ext) => pattern.includes(ext));
      if (isYamlMatch) {
        schemas.push({
          uri: entry.url,
          fileMatch: [pattern],
          priority: SchemaPriority.SchemaStore,
          name: entry.name,
          description: entry.description,
          versions: entry.versions,
        });
      }
    }
  }

  return schemas;
}

/**
 * Fetch YAML-relevant schemas from the JSON Schema Store catalog,
 * using a local file cache to avoid repeated network requests.
 *
 * When the cache file exists and is within the TTL, the catalog is read
 * from disk. Otherwise it is fetched from the network and written to the
 * cache directory.
 * @param options Cache directory and TTL configuration
 * @returns Schema associations from the Schema Store
 */
export async function fetchSchemaStoreSchemas(options: SchemaStoreCacheOptions): Promise<SchemasSettings[]> {
  const cachePath = path.join(options.cacheDir, CACHE_FILENAME);
  const ttlMs = options.cacheTtlSeconds * 1000;

  if (isCacheFresh(cachePath, ttlMs)) {
    consoleDebug(`Using cached schema store catalog: ${cachePath}`);
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const catalog = JSON.parse(raw) as SchemaStoreCatalog;
    return extractYamlSchemas(catalog);
  }

  const catalog = await fetchCatalogFromNetwork();

  fs.mkdirSync(options.cacheDir, { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(catalog), 'utf-8');
  consoleDebug(`Fetched and cached schema store catalog: ${cachePath}`);

  return extractYamlSchemas(catalog);
}

/**
 * Create and configure a yaml-language-server LanguageService instance.
 * @param schemas Schema associations to configure
 * @param customTags Custom YAML tags to register
 * @returns A configured LanguageService
 */
export function createLanguageService(schemas: SchemasSettings[], customTags: string[]): LanguageService {
  const languageService = getLanguageService({
    schemaRequestService,
    workspaceContext,
  });

  const settings: LanguageSettings = {
    validate: true,
    hover: false,
    completion: false,
    format: false,
    schemas,
    customTags,
    yamlVersion: '1.2',
    flowMapping: 'allow',
    flowSequence: 'allow',
  };

  languageService.configure(settings);
  return languageService;
}

/**
 * Read .vscode/settings.json (or a custom settings path) and extract yaml.schemas
 * and yaml.customTags.
 * @param settingsPath Path to the settings JSON file
 * @returns Parsed schema associations and custom tags
 */
export function loadSchemaSettings(settingsPath: string): VscodeYamlSettings {
  const result: VscodeYamlSettings = { schemas: [], customTags: [] };

  if (!fs.existsSync(settingsPath)) {
    consoleDebug(`Settings file not found: ${settingsPath}`);
    return result;
  }

  const raw = fs.readFileSync(settingsPath, 'utf-8');
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    consoleDebug(`Failed to parse settings file: ${settingsPath}`);
    return result;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return result;
  }

  const record = parsed as Record<string, unknown>;
  const yamlSchemas = record['yaml.schemas'];
  if (yamlSchemas && typeof yamlSchemas === 'object' && !Array.isArray(yamlSchemas)) {
    for (const [uri, patterns] of Object.entries(yamlSchemas as Record<string, unknown>)) {
      const fileMatch = Array.isArray(patterns) ? (patterns as string[]) : [String(patterns)];
      result.schemas.push({
        uri,
        fileMatch,
        priority: SchemaPriority.Settings,
      });
    }
  }

  const customTags = record['yaml.customTags'];
  if (Array.isArray(customTags)) {
    result.customTags = customTags.filter((tag): tag is string => typeof tag === 'string');
  }

  return result;
}

/**
 * Convert a file path to a file:// URI suitable for TextDocument creation.
 * @param filePath The filesystem path to convert
 * @returns A file:// URI string
 */
export function toFileUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).toString();
}

/**
 * Resolve an array of file paths and/or glob patterns into a deduplicated,
 * sorted list of matching file paths.
 *
 * All entries are passed through fast-glob with `dot: true` so that dotfiles
 * (e.g. `.gitlab-ci.yml`) are always matched.
 * @param patterns File paths or glob patterns
 * @param ignore Glob patterns to exclude from matching
 * @returns Resolved, deduplicated file paths sorted alphabetically
 */
export function resolveFileGlobs(patterns: string[], ignore: string[]): string[] {
  return fastGlob.sync(patterns, { dot: true, unique: true, ignore }).sort();
}

/**
 * Lint a list of YAML files using the yaml-language-server.
 * @param languageService The configured LanguageService instance
 * @param filePaths Paths to the YAML files to lint
 * @returns An array of results, one per file, each containing any diagnostics found
 */
export async function lintFiles(languageService: LanguageService, filePaths: string[]): Promise<LintFileResult[]> {
  const results: LintFileResult[] = [];

  for (const filePath of filePaths) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const uri = toFileUri(filePath);
    const textDocument = TextDocument.create(uri, 'yaml', 0, content);

    consoleDebug(`Validating: ${filePath}`);
    const diagnostics = await languageService.doValidation(textDocument, false);
    results.push({ filePath, diagnostics });
  }

  return results;
}

/**
 * Plain severity label for a diagnostic.
 * @param severity The diagnostic severity value
 * @returns A human-readable severity string
 */
function severityLabel(severity: DiagnosticSeverity | undefined): string {
  switch (severity) {
    case DiagnosticSeverity.Error:
      return 'error';
    case DiagnosticSeverity.Warning:
      return 'warning';
    case DiagnosticSeverity.Information:
      return 'info';
    case DiagnosticSeverity.Hint:
      return 'hint';
    default:
      return 'unknown';
  }
}

/**
 * Colorize a severity label using colorette.
 * @param severity The diagnostic severity value
 * @returns A colorized severity string
 */
function colorizedSeverity(severity: DiagnosticSeverity | undefined): string {
  const label = severityLabel(severity);
  switch (severity) {
    case DiagnosticSeverity.Error:
      return colorette.red(label);
    case DiagnosticSeverity.Warning:
      return colorette.yellow(label);
    case DiagnosticSeverity.Information:
      return colorette.cyan(label);
    case DiagnosticSeverity.Hint:
      return colorette.gray(label);
    default:
      return label;
  }
}

/**
 * Count errors and warnings without printing anything.
 * @param results The lint results to count
 * @returns The total number of errors and warnings found
 */
export function countDiagnostics(results: LintFileResult[]): { errorCount: number; warningCount: number } {
  let errorCount = 0;
  let warningCount = 0;

  for (const { diagnostics } of results) {
    for (const diag of diagnostics) {
      if (diag.severity === DiagnosticSeverity.Error) {
        errorCount++;
      } else if (diag.severity === DiagnosticSeverity.Warning) {
        warningCount++;
      }
    }
  }

  return { errorCount, warningCount };
}

/**
 * Format lint results for colorized console output.
 *
 * Groups diagnostics by file, prints a bold file-name header, then aligned
 * columns for location, severity (colorized), message, and source.
 * @param results The lint results to format
 * @returns The total number of errors and warnings found
 */
export function formatDiagnostics(results: LintFileResult[]): { errorCount: number; warningCount: number } {
  let errorCount = 0;
  let warningCount = 0;

  for (const { filePath, diagnostics } of results) {
    if (diagnostics.length === 0) {
      continue;
    }

    console.log(colorette.bold(colorette.underline(filePath)));

    const maxLocLen = diagnostics.reduce((max, d) => {
      const loc = `${String(d.range.start.line + 1)}:${String(d.range.start.character + 1)}`;
      return Math.max(max, loc.length);
    }, 0);

    const maxSevLen = diagnostics.reduce((max, d) => Math.max(max, severityLabel(d.severity).length), 0);

    for (const diag of diagnostics) {
      const loc = `${String(diag.range.start.line + 1)}:${String(diag.range.start.character + 1)}`;
      const sevPlain = severityLabel(diag.severity);
      const sevColor = colorizedSeverity(diag.severity);
      const source = diag.source ? colorette.dim(`(${diag.source})`) : '';

      const locPad = loc.padEnd(maxLocLen);
      const sevPad = sevColor + ' '.repeat(maxSevLen - sevPlain.length);

      console.log(`  ${locPad}  ${sevPad}  ${diag.message}  ${source}`);

      if (diag.severity === DiagnosticSeverity.Error) {
        errorCount++;
      } else if (diag.severity === DiagnosticSeverity.Warning) {
        warningCount++;
      }
    }
  }

  return { errorCount, warningCount };
}
