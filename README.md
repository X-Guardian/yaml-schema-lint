# yaml-schema-lint

[![npm][npm-badge]][npm-listing]

Lint YAML files against JSON schemas using the [yaml-language-server](https://www.npmjs.com/package/yaml-language-server) programmatic API.
Validates syntax and schema compliance, with schemas loaded from a settings file and [schemastore.org](https://www.schemastore.org/).

## Installation

```bash
npm install --global yaml-schema-lint
```

## Usage

```bash
yaml-schema-lint [options] <patterns...>
```

### Arguments

| Argument        | Description                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| `<patterns...>` | One or more YAML file paths or glob patterns. Quote globs to prevent shell expansion (e.g. `'**/*.yml'`). |

### Options

| Option                   | Default                   | Description                                                                     |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------- |
| `--settings-path <path>` | `.vscode/settings.json`   | Path to a JSON settings file containing `yaml.schemas` and `yaml.customTags`.   |
| `--no-schema-store`      | _(enabled)_               | Disable fetching schemas from schemastore.org.                                  |
| `--cache-dir <path>`     | `.cache/yaml-schema-lint` | Directory for caching the Schema Store catalog.                                 |
| `--cache-ttl <seconds>`  | `86400` (24h)             | How long the cached Schema Store catalog is considered fresh.                   |
| `--format <name>`        | `gitlab-codequality`      | Output file format when `--output-file` is used (`gitlab-codequality`, `json`). |
| `--output-file <path>`   | _(none)_                  | Write an additional report file in the chosen format.                           |
| `--ignore <patterns...>` | `**/node_modules/**`      | Glob patterns to exclude from file matching.                                    |
| `--no-fail-on-warnings`  | _(disabled)_              | Do not exit with an error when only warnings are found.                         |
| `--no-fail-on-no-files`  | _(disabled)_              | Exit successfully when no files match the patterns.                             |
| `--debug`                | `false`                   | Enable debug logging.                                                           |

## Examples

```bash
yaml-schema-lint '**/*.yml' '**/*.yaml'
yaml-schema-lint --settings-path custom/settings.json '**/*.yml'
yaml-schema-lint --no-schema-store '**/*.yml'
yaml-schema-lint '**/*.yml' --output-file gl-codequality.json
```

## Schema resolution

Schemas are resolved from three sources, in order of priority:

1. **Settings file** -- The `yaml.schemas` property maps schema URIs to file glob patterns. Custom YAML tags can be defined via `yaml.customTags`.

   ```json
   {
     "yaml.schemas": {
       "https://json.schemastore.org/gitlab-ci": [".gitlab-ci.yml", "gitlab/*.yml"]
     },
     "yaml.customTags": ["!reference sequence"]
   }
   ```

2. **Schema Store** -- YAML-relevant schemas are automatically fetched from [schemastore.org](https://www.schemastore.org/) and matched against file names. The catalog is cached locally (default: `.cache/yaml-schema-lint/schemastore-catalog.json`) with a configurable TTL. Disable with `--no-schema-store`.

3. **Modeline comments** -- Inline schema declarations in YAML files are supported natively by the language server:

   ```yaml
   # yaml-language-server: $schema=https://json.schemastore.org/github-workflow.json
   name: CI
   on: push
   ```

## Output

By default, human-readable diagnostics are printed to the console with colorized severity and summary:

```text
config.yaml
  5:3   error    Unexpected property   (yaml-schema)
  12:7  warning  Missing "stage"       (yaml-schema)

Results: 5 file(s) linted, 1 error(s), 1 warning(s)
  3 file(s) passed with no issues
```

### Report files

When `--output-file` is provided, an additional report file is written in the format selected by `--format`. The console output still runs.

#### `gitlab-codequality`

Produces a JSON array conforming to the [GitLab Code Quality report format](https://docs.gitlab.com/ci/testing/code_quality/#code-quality-report-format)

Severity mapping:

| yaml-language-server | GitLab Code Quality |
| -------------------- | ------------------- |
| Error                | `major`             |
| Warning              | `minor`             |
| Information          | `info`              |
| Hint                 | `info`              |

#### `json`

Produces a JSON array of per-file results with 1-based line/column numbers and string severity values. This format is consumed by the [GitHub Action](https://github.com/X-Guardian/yaml-schema-lint-action) to create Check Runs.

Severity mapping:

| yaml-language-server | JSON          |
| -------------------- | ------------- |
| Error                | `error`       |
| Warning              | `warning`     |
| Information          | `information` |
| Hint                 | `hint`        |

## Exit codes

| Code | Meaning                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | All files passed with no errors or warnings, or `--no-fail-on-warnings` is set and no errors were found, or no files matched with `--no-fail-on-no-files`. |
| `1`  | At least one error or warning was found (default), no files matched (default), or a fatal error occurred.                                                  |

## CI integration

### GitLab CI

```yaml
yaml-lint:
  stage: validate
  image: node:24-slim
  script:
    - npx yaml-schema-lint '**/*.yml' --format gitlab-codequality --output-file gl-codequality.json
  artifacts:
    reports:
      codequality: gl-codequality.json
```

### GitHub Actions

The [yaml-schema-lint-action](https://github.com/X-Guardian/yaml-schema-lint-action) runs yaml-schema-lint and creates a GitHub Check with inline annotations and a markdown summary:

```yaml
yaml-lint:
  runs-on: ubuntu-latest
  permissions:
    contents: read
    checks: write
    pull-requests: read
  steps:
    - uses: actions/checkout@v4

    - uses: X-Guardian/yaml-schema-lint-action@v1
      with:
        patterns: "'**/*.yml' '**/*.yaml'"
```

See the [action README](https://github.com/X-Guardian/yaml-schema-lint-action) for all available inputs.

## License

MIT

[npm-badge]: https://img.shields.io/npm/v/yaml-schema-lint.svg
[npm-listing]: https://www.npmjs.com/package/yaml-schema-lint
