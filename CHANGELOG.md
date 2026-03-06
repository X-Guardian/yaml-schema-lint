# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- YAML linting powered by `yaml-language-server` with full JSON Schema validation.
- Schema resolution from `.vscode/settings.json` (`yaml.schemas` property).
- Automatic schema detection from [SchemaStore](https://www.schemastore.org/) with file-based caching.
- Glob pattern support for input paths (including dotfiles).
- Colorized, columnar console output inspired by `yamllint`.
- GitLab Code Quality report output via `--format gitlab-code-quality` and `--output-file`.
- GitHub Actions annotation output via `--github-annotations`.
- Configurable cache directory (`--cache-dir`) and TTL (`--cache-ttl`).
- `--no-schema-store` flag to disable SchemaStore integration.
- `--debug` flag for verbose diagnostic output.
- CI workflow for lint and test with ESLint annotation support.
