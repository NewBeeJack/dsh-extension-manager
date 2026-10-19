# V5 local optimization record

> Local-only build (0.2.0). Nothing in this record was pushed to GitHub or published to npm.

## 1. UI density

- Plugins and Skills now show exactly three primary stats: **已安装 / 可更新 / 异常**. Enabled/loaded/effective/shadowed counts remain available through each cell's tooltip, the **统计详情** disclosure, status filters and record details.
- The toolbar keeps search, filter, refresh, check-all and update-all on one compact row. Source/status/range (or workspace)/sort and diagnostics moved into a collapsible filter panel, together with an explicit **当前匹配 N 项 · 共 M 条记录** readout. Active filter count is shown on the trigger; “清除筛选” is present.
- Cards remain the three-line structure (name/version/status/actions; one-line description; source/path/runtime), with reduced padding and a stable compact height. All previous actions and details fields are preserved.
- DSH built-in components remain excluded from the page (0.1.1 change), and the official Built-in plugins page is untouched.

## 2. Update infrastructure

- New `src/host/updates/coordinator.ts` is the single update/check entry: synchronous admission (duplicate update gets 409 `update-busy`), plan, task creation, phase metadata, abort signal, structured task lifecycle events, cancellation request and persistence.
- Existing `UpdateExecutor`, `UpdateCheckService`, plugin/skill runners, transaction phases, backups and recovery are unchanged; the coordinator delegates to them.
- `tasks.json` is a local task journal. On Host restart, queued/running tasks are restored as failed with an explicit “Host 已重启” message; completed tasks survive; unfinished transactions still go through the existing recovery path.
- `ManagerLog.event()` writes taskId/extensionType/action/phase/status/message/errorCode at the top level (old log methods and event names unchanged). A `POST /task/:id/cancel` endpoint records cancellation requests; pre-install phases can abort, post-install cancellation is settled by actual validation.
- New tests: coordinator admission, duplicate guard, journal restore/interruption, cancel lookup (102 tests total).

## 3. Skills scope/conflicts

- Same-name managed physical copies show a **同名副本 N** badge (unmanaged roots are excluded from the count).
- Details list competing copies with rootKey, rank, provider, scope, real install path and effective/coverage state. Copies in unmanaged roots are shown separately as **同名但不竞争**, with an explanation that DSH does not treat them as competitors and the manager never modifies them.
- When the runtime catalog is incomplete, rows show **当前作用域未验证** and the details dialog reports the verification state; no runtime result is fabricated.
- DSH loading/priority rules and all skill files remain untouched. Virtual provider-registered skills remain listed and are not counted as installed physical copies.

## 4. Cache, performance, shortcuts

- Client inventory cache is keyed by `plugins` / `skills:<workspace>` (never by name), keeps a small LRU, and uses per-key epoch + AbortController so an older request cannot overwrite a newer one. A cached snapshot renders immediately; stale data is revalidated, and a finished check/update forces a fresh inventory read.
- Search/filter/sort/collapsed state and the page scroll offset are persisted in `localStorage` (validated on read, debounced on write); scope and Skills workspace are restored on remount.
- Lists switch to windowed rendering at 100 visible rows. Small lists keep normal document flow; rows are fixed-height and group headers are preserved. Focus inside a row is scrolled into view, and the footer reports “已启用按需渲染”.
- `/` focuses the manager search (ignored while typing or with a modal open); Escape closes the filter panel, clears the search or blurs the search field. No global hotkeys were added.

## 5. Measured list performance (local demo, Edge headless)

Preview fixture `?emFixture=1&emRows=N`; fresh browser per row count.

| Inventory rows | Mounted `.em-row` | DOM nodes | Manager open | Search |
| --- | --- | --- | --- | --- |
| 21 | 21 | ~1.4k | 252 ms | 4 ms |
| 61 | 61 | ~2.5k | 237 ms | 6 ms |
| 211 | 8 | ~1.0k | 246 ms | 6 ms |
| 511 | 8 | ~1.0k | 232 ms | 8 ms |
| 1011 | 8 | ~1.0k | 236 ms | 8 ms |

The full data set remains in memory; search/filter/count and bulk update still cover every record. Numbers are a single-machine snapshot, not a cross-machine guarantee.

## 6. Regression evidence

- `npm test`: 102/102 passing; `tsc --noEmit` clean; `node scripts/build.mjs` succeeds.
- Isolated acceptance `run-all.mjs`: prepare / localmod / git update+rollback / batch+concurrency / interrupted-install recovery / stale-skill prepare / skill update — **7/7 PASS** (coordinator path exercised).
- Dialog-layout regression: **19/19 PASS** across six viewport sizes plus dark mode, including diagnostics/details and update plan/loading/error.
- Real profile: installed 0.2.0 from a local tarball; health returns `ok`; Plugins shows 7/7 profiles, three stats and no DSH built-in group; Skills shows 25 physical copies with a same-name badge and correct non-competing details; layout verified in the running Web UI.
