# V3 interface refresh

> Local build 0.4.0. Not published.

## Surface

- Header: title, intro, Plugins/Skills segmented control, scan metadata and a quiet 诊断 entry. Settings shell untouched.
- Three stat cards: real installed/updatable/abnormal values, soft semantic backgrounds, distinct stat glyphs, clickable filter states.
- Toolbar: existing V2 measured single-row behavior, 42 px controls, natural button widths, active filter dot, filter panel collapsed by default.
- Check results: completed tasks render a compact one-line summary; “查看详情” expands the existing item report. Running/failed/cancelled and done-with-failed-items/network-failure retain accurate status and error text; a partial check is shown as warning/“部分失败”, never as all-success. Per-scope task slots and close/expand state remain isolated.
- List: three layers — identity/status/detail arrow; one-line description; real local installation directory with copy control. Source/toolchain information remains in details.
- Icons: verified `BundleInfo.meta.icon` data URLs are used as `<img>`; otherwise local white puzzle (Plugin) or folded document (Skill) on the shared light-blue plate. No network icon lookup, no name guessing, invalid images fall back.
- Paths: plugins use `paths.installDir`; skills use their install directory (or the verified parent of a flat SKILL.md); virtual resources have no path. Copy feedback is “已复制路径” or “复制失败”; the copied value is the complete path, never the shortened label.

## Local verification

- 129/130 tests, typecheck and build pass.
- Real browser: context real icon, default fallback icons, full path copy/clipboard readback, summary collapse/expand, filter dot, header diagnostics, group toggles.
- Responsive: 1200 px single toolbar; 760/600 layouts reflow without page horizontal overflow; 420 px uses stacked stats and local group scrolling.
