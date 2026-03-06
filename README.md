# yaml-schema-lint

Lint YAML files against JSON schemas using the [yaml-language-server](https://www.npmjs.com/package/yaml-language-server) programmatic API. Validates syntax and schema compliance, with schemas loaded from `.vscode/settings.json` and [schemastore.org](https://www.schemastore.org/).

## Installation

```bash
npm install -g yaml-schema-lint
```

Or as a dev dependency:

```bash
npm install -D yaml-schema-lint
```

## Usage

```bash
yaml-schema-lint [options] <patterns...>
```

### Arguments

| Argument | Description |
|---|---|
| `<patterns...>` | One or more YAML file paths or glob patterns. Quote globs to prevent shell expansion (e.g. `'**/*.yml'`). |

### Options

| Option | Default | Description |
|---|---|---|
| `--settings-path <path>` | `.vscode/settings.json` | Path to a JSON settings file containing `yaml.schemas` and `yaml.customTags`. |
| `--no-schema-store` | _(enabled)_ | Disable fetching schemas from schemastore.org. |
| `--cache-dir <path>` | `.cache/yaml-schema-lint` | Directory for caching the Schema Store catalog. |
| `--cache-ttl <seconds>` | `86400` (24h) | How long the cached Schema Store catalog is considered fresh. |
| `--format <name>` | `gitlab-codequality` | Output file format when `--output-file` is used. |
| `--output-file <path>` | _(none)_ | Write an additional report file in the chosen format. |
| `--github-annotations` | `false` | Print GitHub Actions annotation commands to stdout. |
| `--debug` | `false` | Enable debug logging. |

## Examples

Lint all YAML files in the repository:

```bash
yaml-schema-lint '**/*.yml' '**/*.yaml'
```

Lint with a custom settings file and debug output:

```bash
yaml-schema-lint --settings-path custom/settings.json --debug '**/*.yml'
```

Generate a GitLab Code Quality report alongside console output:

```bash
yaml-schema-lint '**/*.yml' --output-file gl-codequality.json
```

Skip Schema Store and use only local schema associations:

```bash
yaml-schema-lint --no-schema-store '**/*.yml'
```

Emit GitHub Actions annotations (for inline PR comments):

```bash
yaml-schema-lint --github-annotations '**/*.yml'
```

Use a custom cache directory with a 1-hour TTL:

```bash
yaml-schema-lint --cache-dir /tmp/yaml-cache --cache-ttl 3600 '**/*.yml'
```

## Schema resolution

Schemas are resolved from three sources, in order of priority:

1. **`.vscode/settings.json`** -- The `yaml.schemas` property maps schema URIs to file glob patterns. Custom YAML tags can be defined via `yaml.customTags`.

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

By default, human-readable diagnostics are printed to the console with colorized severity:

```
config.yaml
  5:3   error    Unexpected property   (yaml-schema)
  12:7  warning  Missing "stage"       (yaml-schema)
```

A summary line always follows:

```
Results: 5 file(s) linted, 1 error(s), 1 warning(s)
  3 file(s) passed with no issues
```

### GitHub Actions annotations

When `--github-annotations` is enabled, [workflow commands](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions) are printed to stdout **instead of** the per-diagnostic console lines (the summary line is still printed). This avoids duplication since GitHub Actions renders the annotations in the job log, as inline PR diff comments, and as a summary above the log view.

```
::error file=.gitlab-ci.yml,line=5,endLine=5,col=3,endColumn=10,title=yaml-schema::Property job_name is not allowed.
::warning file=config.yaml,line=12,endLine=12,col=7,endColumn=15,title=yaml-schema::Missing required property "stage"
```

Severity mapping:

| yaml-language-server | GitHub annotation |
|---|---|
| Error | `::error` |
| Warning | `::warning` |
| Information | `::notice` |
| Hint | `::notice` |

Note: GitHub limits annotations to 10 warnings + 10 errors per step and 50 per job. The tool emits all annotations; GitHub truncates at the limit.

### Report files

When `--output-file` is provided, an additional report file is written in the format selected by `--format`. The console output still runs.

#### `gitlab-codequality`

Produces a JSON array conforming to the [GitLab Code Quality report format](https://docs.gitlab.com/ci/testing/code_quality/#code-quality-report-format):

```json
[
  {
    "description": "Property job_name is not allowed.",
    "check_name": "yaml-schema",
    "fingerprint": "a1b2c3...",
    "severity": "major",
    "location": {
      "path": ".gitlab-ci.yml",
      "lines": { "begin": 5 }
    }
  }
]
```

Severity mapping:

| yaml-language-server | GitLab Code Quality |
|---|---|
| Error | `major` |
| Warning | `minor` |
| Information | `info` |
| Hint | `info` |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All files passed (warnings are allowed). |
| `1` | At least one error was found, or a fatal error occurred. |

## CI integration

### GitLab CI

```yaml
yaml-lint:
  stage: validate
  script:
    - npx yaml-schema-lint '**/*.yml' --output-file gl-codequality.json
  artifacts:
    reports:
      codequality: gl-codequality.json
```

### GitHub Actions

```yaml
- name: Lint YAML
  run: npx yaml-schema-lint --github-annotations '**/*.yml'
```

## License

MIT
