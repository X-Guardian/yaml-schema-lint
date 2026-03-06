export const CMD_OPTIONS = {
  settingsPath: '--settings-path',
  noSchemaStore: '--no-schema-store',
  cacheDir: '--cache-dir',
  cacheTtl: '--cache-ttl',
  githubAnnotations: '--github-annotations',
  debug: '--debug',
  format: '--format',
  outputFile: '--output-file',
} as const;

export const FAIL_EXIT_CODE = 1;

export const DEFAULT_SETTINGS_PATH = '.vscode/settings.json';

export const DEFAULT_CACHE_DIR = '.cache/yaml-schema-lint';

export const DEFAULT_CACHE_TTL_SECONDS = 86400;
