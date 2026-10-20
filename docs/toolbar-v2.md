# Toolbar V2

> Local build 0.3.1. Not published.

## Layout

`搜索框 → 筛选 → 刷新列表 → 检查更新 → 更新全部（N）` (the last is conditional).

The toolbar measures the real `.em-toolRow` content width with a ResizeObserver:

`search minimum + natural filter width + natural action-group width + 2 gaps <= row width`

If true, the row is pinned to one line and the search field absorbs the remaining width. If false, the right action group (`刷新列表` / `检查更新` / optional `更新全部（N）`) wraps as one unit below search+filter. If that group is narrower than its contents, the group scrolls horizontally; button text remains intact and never wraps.

Search uses `flex: 1 1 0` with a `min(150px, 100%)` floor; actions are `flex: 0 0 auto`, `width: auto`, `white-space: nowrap`. All four action buttons and the search control use a 34 px outer height.

## Batch update visibility

- Before a check: no update-all button.
- Concise `检查更新` starts the existing check task.
- After a fully successful check, the client re-reads the inventory and requests the existing read-only update plan. N = plan entries with `eligible && requiresConfirmation !== true`.
- `更新全部（N）` is shown only when N > 0. N is unaffected by search/filter because it is stored per scope from the full inventory/plan.
- N = 0 shows `检查完成，暂无可批量更新的项目。`
- Failed, partial, network-failed, cancelled or plan-generation-failed checks keep the button hidden and show a failure notice.
- Per-scope results are retained across tab switches but invalidated by a changed inventory signature (ids, versions, status, source spec/ref/commit, update eligibility/local-modification state).
- Clicking the black action opens the existing batch plan/confirmation. No update runs without confirmation.

## Verification

- 119 tests pass (formatter/check-completion helper tests included).
- Real/isolated browser: one line at 1200/1000/900 px viewport with 34 px search and buttons, heights 34 px, widths 66/90/90/118 for `筛选/刷新列表/检查更新/更新全部（2）`.
- 760/600 px: search+filter stay on the first row, action group wraps intact.
- 420 px: action group horizontally scrolls; page has no horizontal overflow; labels remain single-line.
- N=1, N=2 and N=0 verified in the isolated environment; N=12 label tested by formatter and measured at 125 px without clipping/wrapping.
