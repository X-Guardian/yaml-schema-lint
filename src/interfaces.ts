/** https://www.npmjs.com/package/yaml-language-server */
import type { Diagnostic, SchemasSettings } from 'yaml-language-server';

/** Diagnostics produced by linting a single YAML file. */
export interface LintFileResult {
  /** Absolute path to the linted file. */
  filePath: string;
  /** Diagnostics reported by the yaml-language-server for this file. */
  diagnostics: Diagnostic[];
}

/** Schema associations and custom tags parsed from a VS Code settings file. */
export interface VscodeYamlSettings {
  /** Schema-to-file-pattern mappings from `yaml.schemas`. */
  schemas: SchemasSettings[];
  /** Custom YAML tags from `yaml.customTags`. */
  customTags: string[];
}

/** Options controlling how the Schema Store catalog is cached on disk. */
export interface SchemaStoreCacheOptions {
  /** Directory where the cached catalog file is stored. */
  cacheDir: string;
  /** Maximum age of the cache file in seconds before a fresh fetch is performed. */
  cacheTtlSeconds: number;
}

/** Retry behaviour for http(s) schema and catalog fetches. */
export interface SchemaFetchRetryOptions {
  /** Additional attempts made after the first request fails. Zero disables retrying. */
  maxRetries: number;
  /** Base delay for exponential backoff, in milliseconds. */
  baseDelayMs: number;
  /** Upper bound for a single backoff delay, in milliseconds. */
  maxDelayMs: number;
  /** Base delay for exponential backoff after a rate-limited (429) response, in milliseconds. */
  rateLimitBaseDelayMs: number;
  /** Upper bound for a single backoff delay after a rate-limited (429) response, in milliseconds. */
  rateLimitMaxDelayMs: number;
  /**
   * Upper bound for the total time spent waiting between attempts, in milliseconds. A server's `Retry-After` is
   * honoured only while it fits in the remaining budget. Zero disables retrying.
   */
  maxTotalDelayMs: number;
  /** Waits for the given number of milliseconds. Injectable so tests do not sleep. */
  sleep: (ms: number) => Promise<void>;
}

/** A formatter that converts lint results to a string suitable for writing to a file. */
export interface OutputFormatter {
  /** @param results The lint results to format */
  formatToString(results: LintFileResult[]): string;
}
