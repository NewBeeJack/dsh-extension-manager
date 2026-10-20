# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-10-20

Local V6 details-architecture update; **not published** to npm/GitHub.

### Changed

- Details dialogs for Plugins and Skills open with four visible areas only: basic info, project repository, installation location and update situation; all former technical sections, diagnostics, update history, contribution rows and same-name copy details sit behind a default-collapsed “高级信息与诊断”.
- Added a read-only repository resolver for GitHub/GitLab URLs, git+https/git SSH/github shorthand, package.json repository declarations, npm package-page fallback, credential/invalid-URL refusal, conflicting-source detection and commit-pinned monorepo subtree links.
- Installed plugin inventory now reads the package's own package.json `repository` field (display only); update source selection, transaction/backup logic and Skills scope rules are unchanged.
- Kept copyable full paths, update check/update buttons, diagnostics and update history; collapsed the redundant “open GitHub” footer action into the repository area.
- Tests: 115 passing (13 repository resolver tests).

## [0.2.0] — 2026-10-20

Local V5 optimization; **not published** to npm/GitHub.

### Changed

- Three primary stats (installed / updatable / abnormal) with a secondary “统计详情” disclosure; the compact toolbar now keeps search, filter, refresh, check-all and update-all on one row, with source/status/range/workspace/sort/diagnostics in a collapsible filter panel and a “当前匹配 N 项” readout.
- Cards are tighter three-line rows with one-line descriptions and metadata; all existing details/actions remain reachable.
- Added `UpdateCoordinator` (task admission, single-flight, cancellation request, structured task events, durable `tasks.json` journal). Plugin and skill executors, transaction phases, backups and recovery are unchanged; interrupted tasks are reported after a Host restart.
- Skills: same-name physical copies show a “同名副本 N” badge; details list candidate root/rank/provider/scope/real path/coverage; incomplete runtime catalogs show “当前作用域未验证”.
- Client inventory cache keyed by scope+workspace with stale-while-revalidate, epoch/abort guards, persisted search/filter/sort/collapsed state, and on-demand rendering above 100 visible rows. `/` focuses search and Escape closes filters/clears search within the page.
- Tests: 102 (4 coordinator tests added).

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
