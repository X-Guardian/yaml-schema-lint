/** CLI option flags and their corresponding argument names. */
export const CMD_OPTIONS = {
  settingsPath: '--settings-path',
  noSchemaStore: '--no-schema-store',
  cacheDir: '--cache-dir',
  cacheTtl: '--cache-ttl',
  githubAnnotations: '--github-annotations',
  debug: '--debug',
  format: '--format',
  outputFile: '--output-file',
  ignore: '--ignore',
  noFailOnNoFiles: '--no-fail-on-no-files',
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

/** File extensions recognised as YAML when matching schemas to files. */
export const YAML_FILE_EXTENSIONS = ['.yml', '.yaml'];

/** Filename used for the cached Schema Store catalog. */
export const CACHE_FILENAME = 'schemastore-catalog.json';

/** Valid formatter names accepted by the `--format` CLI option. */
export const FORMAT_CHOICES = ['gitlab-codequality'];
/** Type alias for a valid formatter name. */
export type FormatChoice = (typeof FORMAT_CHOICES)[number];
