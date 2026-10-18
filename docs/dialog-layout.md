# Dialog 布局规范与验收记录

> 适用范围：Extension Manager 自有弹窗（更新确认、更新计划/进度/失败、诊断信息、扩展详情）。
> 基线版本：DSH 0.2.1-rc.2，`dsh-extension-manager@0.1.0`。
> 本文记录布局契约、修复根因与可重复的量化验收方法。

## 1. 布局契约

Extension Manager 的弹窗分两种外壳，但遵循同一套度量：

| 区域 | 规则 |
| --- | --- |
| Dialog Container | 宽度 `min(620px, 100%)`；`max-height: 100%`（贴合 DSH `Modal` 根节点预留的 24px 安全框），不写固定高度；`overflow: hidden` 保证圆角完整。 |
| Header | 使用 DSH primitive 的 header 节奏（`22px` 上内边距 + 标题行与 28px 关闭按钮垂直居中产生的 `2px` 偏移），标题文字到卡片上边缘实测 **24px**；左右内边距沿用 primitive（`24px` 内容列）。 |
| Body | 唯一滚动容器（`flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain`）；短内容自然撑开，长内容内部滚动，最后一行滚动到底后完整可见。 |
| Footer | 正常文档流、`flex: none`；与 Body 之间由 dialog `gap: 20px` 提供唯一间距（不叠加 margin / padding-top）；底部内边距 **24px**，从按钮实际可见底边量到卡片下边缘。横向 `justify-content: flex-end`，按钮间距沿用 primitive 的 `8px`。 |

两种实现：

- **`.em-dialogShell`**（更新确认/诊断）：套在 DSH `Modal` 的 chrome 上，补充上述 gap、footer 底部留白与滚动约束。
- **`.em-detailDialog`**（扩展详情，headless）：自绘 header/body/footer，但 `header` 上内边距 24px、`footer` 底部内边距 24px、body 单滚动、`max-height: 100%`，与共享契约对齐。

## 2. 修复根因

1. `.em-modalWide` 为了加宽，把 DSH `Modal` primitive 自带的 `padding: 0 0 24px` 和 `gap: 20px` 一起清零，导致 Footer 贴底（B=0）、Body 与 Footer 无间距（0）。该问题同时影响更新确认与诊断信息两个弹窗。
2. 扩展详情使用 headless 自绘外壳，其 header `padding-top: 18px`、footer `padding-bottom: 16px`、`max-height: calc(100vh - 96px)`，与共享契约不一致（T=18、B=16）。
3. 此前的修复只给更新确认弹窗加了单独 class，诊断弹窗仍是旧样式；本次改为共享 `.em-dialogShell` 契约，并同步 headless 详情外壳的度量。

## 3. 修复前后实测（真实浏览器 `getBoundingClientRect` / `computedStyle`）

T = 卡片上边缘 → 标题首个可见文字上边缘；B = 最下方操作按钮可见底边 → 卡片下边缘。

| 弹窗 | 修复前 T / B | 修复后 T / B | 结论 |
| --- | --- | --- | --- |
| 更新确认（批量/单条/加载/失败） | 24 / **0** | 24 / **24** | 对称 |
| 诊断信息 | 24 / **0** | 24 / **24** | 对称 |
| 扩展详情（headless） | **18 / 16** | **24 / 24** | 对称 |

其他实测：

- Footer 与 Body 间距：`20px`（dialog gap，只出现一次）。
- 长内容：Body `scrollHeight > clientHeight`，Footer 固定可见；滚动到底后最后一行（诊断 `checksCached=…`、详情最后一条更新历史）完整可见，无遮挡。
- 卡片始终在视口安全框内：`top ≥ 0`、`bottom ≤ innerHeight`，水平方向不溢出。
- 无双重滚动条；内容区只有一个滚动容器。

## 4. 自动化布局回归

脚本：`scripts/dev/verify-dialog-layout.mjs`（CDP，无需 Playwright）

```powershell
node scripts/dev/verify-dialog-layout.mjs `
  --url "http://127.0.0.1:<port>/?token=..." `
  --cookie "scripts/dev/cookie.json" `
  --out "..\_test\layout-report" `
  --sizes "1920x1080,1536x864,1366x768,1093x614,911x512,683x384"
```

覆盖：

- 诊断信息、扩展详情：6 个视口尺寸全部测量；
- 更新计划：完整、加载中（网络延迟 3000ms）、失败（拦截 `update-plan`）三种状态；
- 深色模式：`prefers-color-scheme: dark` 下重测诊断弹窗；
- 每个长内容弹窗滚动到底并断言最后一行完整可见；
- 断言：`T`、`B` 均落在 24±4；`|T−B| ≤ 4`；Footer 不越界；Body 不与 Footer 重叠；卡片不越出视口；无双重滚动。

最近一次（隔离验收环境，真实 Host 数据 + 预览 fixture 补充更新弹窗状态）：

```
19/19 checks passed
```

视口尺寸同时是浏览器缩放 100%–200% 的布局代理（缩放表现为 CSS 视口变小）：
1920×1080、1536×864、1366×768、1093×614、911×512、683×384。

本地正式安装环境同样执行通过：

```
19/19 checks passed
```

真实数据覆盖：诊断信息（6 个视口 + 深色 + 滚动到底）、扩展详情（6 个视口 + 滚动到底）；更新计划在没有可更新项时使用 `?emFixture=1` 预览数据覆盖完整/加载/失败三状态。

界面截图见 `docs/screenshots/`；运行报告由脚本写入 `--out` 指定目录，不随仓库提交。
