# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-10-19

### Changed

- The Plugins page no longer lists DSH-shipped components. DSH's own **Built-in plugins** page remains the place to manage them; no DSH plugin, configuration or file is changed.
- Page statistics, search/filter results, check-all and update plans now cover only the Extension Manager's managed scope (third-party/profile bundles and their runtime rows). DSH-shipped Loader rows are still claimed internally for reconciliation, so they cannot reappear as unattributed rows.
- The “已安装” stat tooltip no longer mentions the excluded DSH built-in count.

## [0.1.0] — 2026-10-18

Initial public release, targeting DSH 0.2.1-rc.2. Published on npm as [`dsh-extension-manager`](https://www.npmjs.com/package/dsh-extension-manager).

### Added

- Settings section **扩展管理器** with a Plugins / Skills segmented control, five-cell stats, search/filter/sort/collapse, workspace-aware Skills scanning, details dialogs and per-record update history.
- Host inventories from `ctx.pluginManager.listBundles()` / `listPlugins()`, the live `ctx.skills` registry, profile manifests and pnpm lockfiles; read-only views of other readable profiles.
- Update checks: npm registries (private-registry isolation, DSH compatibility), git installs via `git ls-remote`, Skills via GitHub trees API and `.skill-lock.json` folder hashes.
- Safe transactional updates: plan/confirm flow, hash-verified backups, staged installs, read-back validation, rollback and crash recovery; single-flight update guard; backup retention and staging cleanup.
- Diagnostics dialog with environment facts, writability probes, skill providers and per-source completeness audit.
- Unit tests (98), isolated acceptance environment with seven end-to-end scenarios, and an automated dialog-layout regression check.
- Light/dark themes and responsive layout using DSH design tokens.

### Known limitations

See [README.md](README.md#compatibility-and-limitations) and the detailed list in [README.zh.md](README.zh.md) §9.
