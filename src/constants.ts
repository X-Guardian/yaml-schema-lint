/** CLI option flags and their corresponding argument names. */
export const CMD_OPTIONS = {
  settingsPath: '--settings-path',
  noSchemaStore: '--no-schema-store',
  cacheDir: '--cache-dir',
  cacheTtl: '--cache-ttl',

  debug: '--debug',
  format: '--format',
  outputFile: '--output-file',
  ignore: '--ignore',
  noFailOnNoFiles: '--no-fail-on-no-files',
  noFailOnWarnings: '--no-fail-on-warnings',
} as const;

/** Process exit code indicating a lint error or fatal failure. */
export const FAIL_EXIT_CODE = 1;

/** Default path to the VS Code settings file containing yaml.schemas. */
export const DEFAULT_SETTINGS_PATH = '.vscode/settings.json';

/** Default directory for caching the Schema Store catalog. */
export const DEFAULT_CACHE_DIR = '.cache/yaml-schema-lint';

/** Default Schema Store catalog cache TTL in seconds (24 hours). */
export const DEFAULT_CACHE_TTL_SECONDS = 86400;

/** Glob patterns excluded from file matching by default. */
export const DEFAULT_IGNORE_PATTERNS = ['**/node_modules/**'];

/** URL of the Schema Store JSON catalog. */
export const SCHEMA_STORE_CATALOG_URL = 'https://www.schemastore.org/api/json/catalog.json';

/** HTTP request headers sent with every schema and catalog fetch. */
export const SCHEMA_FETCH_HEADERS = { 'Accept-Encoding': 'gzip, deflate' };

/** HTTP statuses that indicate a temporary condition, where the same request may succeed shortly afterwards. */
export const RETRYABLE_HTTP_STATUSES = [429, 502, 503, 504];

/** Additional attempts made after the first schema or catalog fetch fails. */
export const SCHEMA_FETCH_MAX_RETRIES = 3;

/** Base delay for exponential backoff between fetch attempts, in milliseconds. */
export const SCHEMA_FETCH_BASE_DELAY_MS = 500;

/** Upper bound for a single delay between fetch attempts, in milliseconds. Also caps a server's `Retry-After`. */
export const SCHEMA_FETCH_MAX_DELAY_MS = 5000;

/**
 * Lowest diagnostic code the yaml-language-server uses for schema resolution failures (its
 * `ErrorCode.SchemaResolveError`), such as a schema that could not be fetched or a `$ref` that could not be
 * resolved. Codes at or above this value mean the file was not checked, rather than that it failed a check.
 */
export const SCHEMA_RESOLVE_ERROR_CODE = 0x10000;

/** File extensions recognised as YAML when matching schemas to files. */
export const YAML_FILE_EXTENSIONS = ['.yml', '.yaml'];

/** Filename used for the cached Schema Store catalog. */
export const CACHE_FILENAME = 'schemastore-catalog.json';

/** Valid formatter names accepted by the `--format` CLI option. */
export const FORMAT_CHOICES = ['gitlab-codequality', 'json'];
/** Type alias for a valid formatter name. */
export type FormatChoice = (typeof FORMAT_CHOICES)[number];
