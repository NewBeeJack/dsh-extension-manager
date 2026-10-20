# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.4] — 2026-10-21

Update-check skipped-item reporting; **not published** to npm/GitHub.

- Added `TaskSkippedItem` and optional `TaskState.skipped`; check tasks now snapshot the stable id, display name and original reason for every normal skip.
- Preserved the snapshot through task creation, lifecycle, journal restore and Host API; old tasks without the field remain valid.
- TaskPanel now shows a separate “跳过（N）” section in expanded check details with real reasons; no empty group is rendered when there are no skips.
- Accurate all-skipped summary; 130 tests, typecheck and build pass.

## [0.4.3] — 2026-10-21

V3.1b targeted visual corrections; **not published** to npm/GitHub.

- Deepened the three semantic stat-card tints and their borders, icons and primary numbers; the tiny icon plate remains removed.
- Moved the shared list icon further down to align its visible top edge with the rendered CJK glyph top, not only the title line box; verified by screenshot pixel scans.
- CSS-only product change; 126 tests, typecheck and build pass.

## [0.4.2] — 2026-10-21

V3.1 small visual corrections; **not published** to npm/GitHub.

- Removed the extra icon background plate from all three statistic cards; the semantic card background is now the only background behind each stat glyph.
- Added a 2px top compensation to the shared list icon container so its top edge aligns with the first title text line (20px line inside a 24px title row) in both Plugins and Skills.
- No logic, data, icon-source, path-copy or update behavior changed. 126 tests, typecheck and build pass.

## [0.4.1] — 2026-10-20

Final acceptance hardening; **not published** to npm/GitHub.

- Reject ambiguous `resolvedPath` fallback for list installation directories. The list now trusts only `paths.installDir`, or the verified parent of `manifestPath`; virtual/runtime records remain path-unknown.
- Moved icon data-URL validation into a testable module; added path/icon regression tests (126 total).
- T21 isolated Host plan now measured at 5.13s and validated end-to-end through the V3 UI including cancel; previous 40s timeout was not reproducible and no timeout code was changed.
- Added controlled verification for partial/overall check failure, V3 async switching, clipboard failure and icon load failure.

## [0.4.0] — 2026-10-20

Local V3 interface refresh; **not published** to npm/GitHub.

- Rebuilt the content surface with soft semantic stat cards, real extension icons from DSH bundle metadata, local puzzle/document fallback icons, wider three-layer list cards and full local install-directory copy.
- Kept the existing V2 single-row toolbar, check/update plan confirmation and per-scope check-result state; compacted completed checks to a one-line summary with details toggle.
- Moved diagnostics out of the filter panel into the header secondary area; filter panel remains collapsed by default with an active-filter indicator.
- Added explicit install-path copy feedback, unknown/virtual path states and preserved all source/technical information in details.
- Tests: 119 passing; real-profile UI checks for icons, paths, summary, filters, groups and check isolation.

## [0.3.2] — 2026-10-20

V2.1 local defect fixes; **not published** to npm/GitHub.

- Scoped task result panels: Plugins and Skills keep independent active tasks, completion/progress panels, detail expansion and dismissed state. Results are written to the task's own scope; stale task responses cannot overwrite a newer slot; completion toasts and errors follow the owning page.
- Group collapse: removed the filter-driven `forceOpen` override that made header buttons appear inert whenever a search/filter was active. Groups now toggle with search, source/status/range filters and sorting, independently per scope and stable key.
- Main list rows: removed per-row update/check/copy actions and interactive name; each row now has exactly one “查看详情” arrow. Details pages keep check/update actions; underlying single-update APIs and batch flow are unchanged.
- Tests: 119 passing; real-profile UI checks cover async tab switching, both scopes' panels, close/expand isolation, npm/source-unknown groups and row action audit.

## [0.3.1] — 2026-10-20

Toolbar V2 local layout/build; **not published** to npm/GitHub.

- Search, filter and the white-outline `刷新列表` / `检查更新` actions plus the conditional black `更新全部（N）` now share one measured toolbar row when the real content width fits; below that the right action group wraps as a unit and scrolls only when it cannot fit.
- Buttons use natural content widths, a common 34 px height and non-wrapping labels; update-all count comes from the existing read-only batch plan (`eligible && !requiresConfirmation`), not from filtered records.
- Update-all stays hidden until the current scope's check finishes fully successfully; failed/partial/network-failed/plan-failed checks keep it hidden with a precise notice. Per-scope result signatures are invalidated when the inventory identity or update eligibility changes.
- Tests: 119 passing (4 toolbar/check-state tests).

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
