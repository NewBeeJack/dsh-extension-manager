# DSH 扩展管理器（dsh-extension-manager）

统一查看、检查并安全更新本机 Plugins 与 Skills 的 DSH 原生插件。

- 页面入口：DSH Web GUI 的 **Settings → 扩展管理器**（内置设置分区，不是独立网页或独立端口）。
- 兼容基线：**DSH 0.2.1-rc.2**（Windows 环境实测，见 §11）。
- 当前版本：0.3.2（本地工具栏 V2 版；npm 上的 0.1.1 是上一版，本次未远程发布）。管理器自身不支持页面内自更新（见 §8.6）。
- 所有数据来自 Host 侧真实读取：`ctx.pluginManager.listBundles()` / `listPlugins()`、`ctx.skills.snapshot()`、`skill-filesystem` 运行时配置、profile 清单与 pnpm 锁文件、npm Registry、GitHub、`git ls-remote`。
- 更新通过持久化事务执行：备份 → 下载 → 暂存校验 → 安装 → 读回校验 → 需要时等待重启；失败自动回滚。

> 本文档对应 **v0.3.2**（DSH 0.2.1-rc.2 基线，V6 本地优化版）。功能描述全部取自本仓库源码；测试与验收方法见 [docs/testing.md](docs/testing.md)。Git 安装 Bundle 的更新与 `requiresConfirmation` 项的逐项确认链路均已实现并通过隔离验收；当前确实不提供的能力在 §9 如实列出。

**工具栏 V2（0.3.2）**：搜索、筛选、刷新列表、检查更新与条件显示的更新全部（N）按真实内容宽度决定单行；按钮自然宽度、统一 34px 高度、文字不换行；N 来自现有只读批量更新计划，完整检查成功前不显示。

**V6 详情页优化（0.3.0）**：Plugins/Skills 详情默认只保留基本信息、GitHub 仓库、安装位置、更新情况和默认折叠的高级信息；新增只读仓库解析（package.json/git/GitHub SSH/Monorepo 子目录，冲突不猜测）；其余 `npm test` 119 项、布局与真实 UI 验收见下文。

**V5 基础能力**：三项主统计（已安装/可更新/异常，详情可展开）；单行工具栏 + 折叠筛选面板；更紧凑三行卡片；统一 UpdateCoordinator（任务准入、取消、结构化任务日志、重启任务日志）；Skills 同名副本徽标/候选详情/作用域未验证提示；按 scope/workspace 的库存缓存、搜索/筛选/排序/折叠/滚动位置持久化与 100 行以上按需渲染。本次只在本地构建与安装，未发布到 npm/GitHub。

![扩展管理器 Plugins 页面](docs/screenshots/plugins.png)

---

## 目录

1. [它做什么 / 不做什么](#1-它做什么--不做什么)
2. [环境要求](#2-环境要求)
3. [安装与卸载](#3-安装与卸载)
4. [打开页面](#4-打开页面)
5. [使用说明](#5-使用说明)
6. [检查与更新的具体规则](#6-检查与更新的具体规则)
7. [数据、日志与备份](#7-数据日志与备份)
8. [维护与二次开发](#8-维护与二次开发)
9. [已知限制](#9-已知限制)
10. [故障排查](#10-故障排查)
11. [实测记录](#11-实测记录)

---

## 1. 它做什么 / 不做什么

**能做：**

- **Plugins 页**：列出当前 Profile 安装的插件包（Bundle）、它们贡献的 Loader 插件行、运行时加载状态；同时展示其他可读 Profile 与 DSH 安装提供的组件（只读）。
- **Skills 页**：列出物理技能副本（清单 A）与运行时可见技能（清单 B），计算同名覆盖关系、未托管根目录、调用策略、来源与本地修改状态。
- **检查更新**：npm 来源查 registry（按配置的 registry 顺序、私有源不回退公共源）、Git 来源用 `git ls-remote` 比较 commit、Skills 用 GitHub trees API / `~/.agents/.skill-lock.json` 比较目录 tree；npm 候选版本会按 app-boot 语义校验 `engines.dsh` / `@deepseek-ai/dsh*` peer 依赖与当前 DSH 版本的兼容性。
- **安全更新**：可自动完成的项支持批量更新；需要确认的项（本地修改/无法比较、仅预发布、兼容性未知、Git 安装）必须逐项确认；执行前备份安装目录与 Profile 清单文件，失败自动回滚；安装后读回 `listBundles()`/锁文件校验结果，而不是相信退出码。
- **诊断**：展示 DSH 版本、Profile/数据目录、registry、代理、pnpm/git 版本、目录可写探测、清单完整性审计（逐个来源的读取是否完整）、当前限制列表。

**不做（有意为之）：**

- 不修改“其他 Profile”的任何内容；只读展示。
- 不提供伪造的技能启停开关（DSH 没有官方逐技能启停机制）。
- 不展示也不管理随 DSH 安装提供的组件；它们由 DSH 左侧导航的 **Built-in plugins** 页面管理，并随 DSH 发行版更新。
- 不在页面内自更新管理器自身；也不重启 DSH。
- 不把网络失败、检查失败显示成“已是最新”。
- 不修改客户端传入的任意路径：所有写操作按记录 id 在 Host 侧解析路径。

## 2. 环境要求

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH | 0.2.1-rc.2（开发与实测基线） | 依赖该版本提供的 `ctx.pluginManager`、`ctx.skills`、`ctx.webServer`、`profileContext`、`ctx.connection.admit` 等接口 |
| Node.js | `>=22.19.0` | 与 DSH 本体一致（Node 24 已验证） |
| 包管理器 | pnpm（DSH CLI 的 `dsh plugin` 会转发给 pnpm） | 插件安装/卸载由 DSH 插件管理器完成 |
| git | 可选，但 Git 来源需要 | Git 来源插件的远端 commit 比较使用 `git ls-remote`；Git 安装更新由 pnpm 按 commit 拉取，同样依赖 git |
| 网络 | 访问 npm Registry / GitHub | 代理环境可通过 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 生效；Skills 检查可设置 `GITHUB_TOKEN` 或 `GH_TOKEN` 提高 GitHub API 限额 |

## 3. 安装与卸载

### 3.1 构建

项目根目录下：

```bash
npm install            # 安装开发依赖（esbuild / typescript / DSH 0.2.1-rc.2 类型包等）
node scripts/build.mjs # 生成 lib/index.js（Host，ESM 打包）与 lib/client.js（Web client bundle）
# 或：npm run build；类型检查：npm run typecheck；两者合一：npm run verify
```

Host 半被打包成自包含 ESM（`yaml`、`semver`、`undici` 等 CJS 依赖随包内联，构建脚本用 `createRequire` banner 提供动态 require）；client 半被包装成 DSH ModuleLoader 需要的 `window.__ModuleLoader__.load({ id, factory })` 闭包。

### 3.2 打包

```bash
npm pack     # 产出 dsh-extension-manager-0.3.2.tgz
```

标准安装包：运行 `npm pack` 生成 `dsh-extension-manager-0.3.2.tgz`；`package.json` 的 `files` 字段声明了 `lib`、`cordis.patch.yml`、`README.md`、`README.zh.md`、`LICENSE`、`docs/architecture.md`、`docs/dialog-layout.md`。仓库已包含 MIT `LICENSE`（完整许可文本）。

### 3.3 安装到 Profile

以 `web` Profile 为例（`<绝对路径>` 换成你自己的路径）：

```bash
# 方式 A（推荐）：从 npm Registry 按名称安装
dsh plugin --profile web add dsh-extension-manager
# 锁定版本：dsh plugin --profile web add dsh-extension-manager@0.3.2

# 方式 B：从打包产物安装
dsh plugin --profile web add "<绝对路径>/dsh-extension-manager-0.3.2.tgz"

# 方式 C：开发调试用 link 安装
dsh plugin --profile web add "link:<项目绝对路径>"
```

`dsh plugin` 只是把参数转发给 pnpm，它 **不会** 自动把包选为 DSH Bundle。安装后还需要把 `dsh-extension-manager` 加入该 Profile 的 bundle 列表——编辑 `$DSH_HOME/profiles/web/package.json`：

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": [
        // …已有 bundle…
        "dsh-extension-manager"
      ]
    }
  }
}
```

（也可以使用 DSH 插件管理界面提供的 bundle 启用能力。）

随后重启 DSH（或让 HMR 重载该插件行）即可生效。

### 3.4 卸载

```bash
dsh plugin --profile web remove dsh-extension-manager
```

并从 `$DSH_HOME/profiles/web/package.json` 的 `dsh.profile.bundles` 中删除 `dsh-extension-manager`。

**数据目录默认保留**：`$DSH_HOME/extension-manager/`（检查缓存、更新历史、备份、日志）。若确认不再需要，手动删除该目录即可；卸载不会自动删除它。

## 4. 打开页面

1. 启动 DSH Web（例如 `dsh web`），在浏览器打开它输出的地址（默认 `http://127.0.0.1:3080`）。
2. 打开 **Settings（设置）**，左侧分区选择 **扩展管理器**。

页面是 DSH Web GUI 的一个内置 Settings 分区（`settings.section`，id `extension-manager`），数据全部经同源 JSON API `/api/dsh-extension-manager` 获取；不存在独立网页、独立端口或外部资源。

> 开发/验收用的预览：URL 追加 `?emFixture=1` 会加载本地示例数据用于视觉与交互预览，页面会持续显示「预览数据」标记，默认访问路径绝不使用假数据。

## 5. 使用说明

页面顶部是标题与简介；下方是 **Plugins / Skills 胶囊切换**（默认 Plugins；两页的搜索、筛选、排序、分组折叠状态互相独立并保留）、统计栏与工具栏。

### 5.1 统计栏（各 5 项，口径来自 Host 聚合）

Plugins：

| 指标 | 口径 | 可点击筛选 |
| --- | --- | --- |
| 已安装 | 当前 Profile 声明的第三方插件包（含未启用）；tooltip 另给其他 Profile 数量 | 否 |
| 已启用 | 配置中已选中、随 DSH 加载的插件包 | 是（已启用） |
| 运行中 | 运行时已加载的插件行 / 插件行总数（tooltip 给出失败数） | 是（运行中） |
| 可更新 | 检查后存在可用且与当前 DSH 兼容的更新 | 是（可更新） |
| 异常 | 加载失败、安装缺失、检查失败或带错误诊断的记录 | 是（异常） |

Skills：

| 指标 | 口径 |
| --- | --- |
| 物理副本 | 扫描到的技能目录/文件总数（tooltip 给出未托管数量） |
| 运行时生效 | 运行时技能目录中可见的技能数；物理副本中生效的数量在 tooltip 中 |
| 已覆盖 | 被同名、更高优先级副本覆盖而未生效的物理副本 |
| 可更新 | 检查后存在可用且兼容的远程更新 |
| 异常 | 解析失败、检查失败或带错误诊断的技能 |

其中的按钮类指标点击后会切换对应状态筛选（再次点击取消）。

### 5.2 工具栏

- **搜索**：名称、包名/模块名、来源、路径的本地过滤（不区分大小写）。
- **来源**：按来源分组过滤（只列出当前记录集中出现的来源）。
- **状态**：Plugins 为「全部状态 / 已启用 / 未启用 / 运行中 / 加载失败 / 可更新 / 异常」；Skills 为「全部状态 / 运行时生效 / 已覆盖 / 未托管 / 可更新 / 异常」。
- **范围（Plugins；Skills 在未提供工作区选择器时回退显示）**：「全部范围 / 当前 Profile / 其他 Profile / DSH 安装 / 运行时插件行」（Skills 在回退时为「全部根目录 / 各技能根 / 仅未托管根」）。
- **工作区（Skills）**：当 DSH 暴露了已注册工作区时，可选择「默认（Host 工作目录）」或某个已注册工作区；切换后按该工作区的项目根重新扫描 Skills（`workspace` 参数经 Host 校验，只接受已注册工作区/当前 cwd/DSH home 内的目录）。
- **排序**：「名称 / 更新优先 / 最近检查」。
- **刷新清单**：重新扫描当前页数据（`GET /plugins?refresh=1` 或 `GET /skills?refresh=1`），不触发远端更新检查。
- **诊断**：打开诊断弹窗（环境、探测结果、清单完整性、技能根目录）。
- **检查全部更新**：对当前页所有具备可信来源的记录发起检查（后台任务，任务面板显示进度）。
- **更新全部（N）**：只针对“可安全自动更新”的项生成更新计划；没有可安全更新的项时按钮禁用，并在提示行说明原因。

搜索/筛选生效时，来源分组会被强制展开，避免匹配项藏在折叠分组里。

### 5.3 列表

记录按 **来源分组**（可折叠）展示，示例分组：`npm 安装`、`Git / GitHub 安装`、`本地链接（link）`、`本地路径`、`Profile 本地补丁`、`离线安装包`、`技能锁文件`、`文件系统扫描`、`来源未知`。分组头显示数量与可更新数量。DSH 内置组件不在本页展示。

每行包含：

- 名称（点击打开详情）、版本、状态标签（更新状态；tooltip 为具体原因）、未启用标签；
- 右侧操作：`更新`（仅存在更新候选时出现；不可执行时禁用并给出原因）、`检查更新`（单条）、`查看详情`；
- 描述行（过长时 tooltip）；
- 元信息行：来源标签 · 路径（省略显示，tooltip 显示完整路径，带 **复制路径** 按钮）· 运行时说明（如「运行中」「未托管根目录」「被同名副本覆盖」）· 最近检查时间。

列表底部显示记录总数与筛选后数量。

### 5.4 详情弹窗

按记录类型展示其契约字段（只展示真实存在的字段，不臆造）：

- **概览**：类型、技术名称、管理范围、Profile、版本（含可用版本）、状态、说明。
- **更新**：更新状态、可用版本、发布通道、兼容性、兼容要求（逐条 `key: range`）、最后检查、当前/可用 commit 或技能树、检查能力与更新能力（附不能执行的原因）、是否需要确认。
- **来源**：来源类型、可信度、来源标签、包名、安装 spec、仓库、registry、分支/标签、提交、子目录、来源说明；https URL 可点击，并可 **复制来源 URL**。
- **运行时**：已安装/已启用/已加载、Loader 阶段、是否等待重启、更新后是否通过校验、目录观察是否完整、运行时错误。
- **路径**：安装目录、清单文件（`package.json` / `SKILL.md`）、真实解析路径（link/工作区）、根目录——每条都可复制。
- **本地修改**：unknown / clean / modified，修改文件列表与说明（由更新流程在预检时重新核对）。
- **插件包**：可用位置、官方插件、可移除、只读原因、同时声明的 Profile、是否管理器自身；贡献的插件行列表（entryId、模块、启用/加载状态、只读原因、错误）；覆盖的内置行。
- **插件行**（独立行记录）：entryId、模块、说明、是否覆盖内置行、只读原因、行错误。
- **技能**：rootKey、根优先级 rank、物理形态、Provider、是否运行时生效、被哪个副本覆盖、覆盖了哪些副本、调用策略、简介。
- **诊断**：结构化诊断（level/code/message/detail）。
- **更新历史**：该记录相关的最近更新历史（结果、动作、版本变化、事务 id）。
- 底部按钮：`诊断`、`打开 GitHub`（来源 URL 为 https 时）、`检查更新`、`更新`（有候选时）。

### 5.5 检查更新

1. 点击工具栏 `检查全部更新` 或某行的 `检查更新`；Host 立即创建 `check` 任务并返回，页面轮询 `GET /task/:id` 显示进度（700ms 间隔，最长 15 分钟）。
2. 任务结束后列表自动刷新，Toast 显示结论，例如「已检查 8 项，1 项有更新」。
3. 5 分钟内的检查结果会被直接复用（任务摘要会显示“N 项跳过”）；点工具栏刷新只会重扫清单，不会强制重新访问上游。
4. 离线时页面顶部显示「网络不可用」；网络失败、限流、超时不会显示为“已是最新”，而是 `network-error` / `check-failed` 并说明原因。

任务面板中可展开每项明细；失败项会列出原因。

### 5.6 更新（单条 / 批量）

1. 点击某行 `更新`，或工具栏 `更新全部（N）`。
2. Host 先 **只生成计划、不改动任何东西**（`POST /update-plan`），弹窗展示：
   - **将更新 N 项**（批量模式下只含可安全自动完成的项）；
   - **需要逐项确认，已跳过 N 项**（批量模式下被跳过的、带确认要求的项）；
   - **已排除 N 项**（附排除原因，例如“管理器自身不参与自动更新”“新版本与当前 DSH 不兼容”）；
   - 每项的风险说明（备份/回滚、需要重启、覆盖本地修改、预发布、兼容性未知等）。
3. 勾选确认与执行（已实现并在隔离环境验证）：
   - 弹窗分为三块：`将自动更新 N 项`（批量）/`将更新 N 项`（单项/重试）；`需要确认，已跳过 N 项（可逐项更新）`（仅批量模式）；`已排除 N 项`（附原因，例如“管理器自身不参与自动更新”“新版本与当前 DSH 不兼容”）。
   - **单项/重试模式**：`eligible` 或 `requiresConfirmation` 的项都会进入待更新列表；涉及本地修改或风险时必须勾选确认框（文案随风险变化：「我已了解上述风险，确认继续这次更新。」或「…并同意在需要时覆盖本地修改后继续。」），提交时按需携带 `overwriteLocalModifications: true`。
   - **批量模式**：只自动执行可安全更新的项（`eligible && !requiresConfirmation`）；`requiresConfirmation` 项列出但跳过，可关闭弹窗后在列表里逐项更新。
   - Host 侧 `/update`：`confirmed: true` 是硬门槛；**单项计划**中的 `requiresConfirmation` 项可执行（执行器 PREFLIGHT 再复核，本地修改仍要求 `overwriteLocalModifications: true`）；**批量**只执行 `eligible` 项，带 `overwriteLocalModifications: true` 时才放行确认项；同一时间只允许一个更新任务（并发第二个请求返回 `409 update-busy`）。
4. Host 创建更新任务并逐项执行（每个项一个持久化事务），任务面板显示每项进度与结果；完成后列表刷新，需要重启的项会在页面顶部提示「有 N 项更新等待重启后生效」。
5. 失败项的详情在任务面板中给出，可点 `重试失败项（N）` 重新走“生成计划 → 确认 → 执行”；已自动回滚的项会说明回滚结果，备份目录保留供人工恢复。
6. 每次成功/失败/回滚都会写入更新历史（详情弹窗与 `GET /history` 可读）。

### 5.7 诊断弹窗

- **环境**：DSH 版本、Host PID、平台、Node、pnpm、git、HMR、Profile 名/目录、DSH Home、安装锚点、管理器版本/自身包名/自身更新支持、Registry 与备用 Registry、网络代理、状态/日志/最新日志/备份目录（均可复制）。
- **探测结果**：状态目录、日志目录、备份目录的实际写入探测。
- **限制**：Host 当前声明的限制列表（随代码维护）。
- **技能 Provider**：key、是否受管、根目录。
- **技能根目录（Skills 清单）**：每个技能根的 label/key、rank、是否受管、是否读取完整、数量、路径与错误（需先加载过 Skills 页）。
- **清单完整性**：分别对 Plugins / Skills 展示每个来源的 id、贡献类型、数量、是否完整、位置或错误；不完整时列出失败来源；另有未能对账的记录与说明、计数摘要。

### 5.8 Skills 页面要点

- **双清单**：清单 A（物理副本）来自文件系统扫描；清单 B（运行时技能）来自 `ctx.skills` 的运行时快照（必要时还会观察 Agent 预设挂载的 `skill-filesystem`）。
- **覆盖关系**：同名技能按根的 rank 竞争（项目 `.dsh/skills` < 项目 `.agents/skills` < 自定义根 < `~/.dsh/skills` < `~/.agents/skills` < 随 DSH 提供的技能目录；数值越小优先级越高），受管副本优先于非受管副本。被覆盖的副本会标注「已覆盖」与覆盖它的路径。
- **未托管根**：`~/.codex/skills`、`~/.claude/skills`、`~/.copilot/skills`、`~/.cursor/skills` 等目录会被列出并标注“DSH 未托管”；管理器只展示，不会修改其内容。
- **别名去重**：同一物理目录通过 Junction / 符号链接被多个根到达时，按 realpath 合并为一份并保留别名词法路径（详情可见 alias 路径），不会重复计数（验收中 physical 12→11）。
- **来源**：`~/.agents/.skill-lock.json`（skills CLI 记录）、用户确认的 GitHub 来源、本地 git 仓库（含 remote/subdir/commit）、或“本地文件系统（无远端来源）”。
- **可检查条件**：来源为 GitHub 且位于 DSH 托管根（锁文件哈希/已确认来源/本地 git 均可）；否则显示“需要来源”或“无远程来源”。
- **可更新条件**：目录形态（非单文件）、来源已验证、检查结果包含远端目录树哈希、无未确认的本地修改。
- **更新方式**：只替换该技能目录，不会覆盖所在仓库的其他文件；下载 GitHub 归档后必须复算出与检查结果一致的 git tree SHA 才允许替换。

### 5.9 复制路径与更新历史

- 列表中每行路径、详情弹窗中每条路径/URL、诊断弹窗中各目录都带复制按钮（复制成功有对勾反馈）。
- 更新历史按记录名过滤展示，显示结果标签、动作、`from → to`、消息、事务 id；数据来自 `GET /history`（持久化在 `state.json`，最多保留最新 500 条）。

## 6. 检查与更新的具体规则

### 6.1 npm 插件检查

- 依次询问配置的 registry：`ctx.pluginManager.registries()` 给出首选 registry、`fallbackRegistries` 与 pnpm 自身解析出的 `resolved`。**私有 registry 只问它自己，绝不回退公共源**；只有 `registry.npmjs.org` 与 `registry.npmmirror.com` 这两个公共镜像之间允许互为回退。
- 读取 npm packument（corgi 精简格式，含 `dist-tags`、各版本 `engines`/`peerDependencies`/`dist`）。
- 候选选择：`dist-tags.latest`（稳定版）与 `next/beta/rc/alpha…`（预发布）与当前版本按 semver 比较；**只提示升级，不提示降级**。
  - 有更新的稳定版 → `update-available`（`channel: stable`）；
  - 稳定版没有更新，但存在更新的预发布版，且当前是稳定版 → `prerelease-only`（不会进入安全批量更新）；
  - 当前本身是预发布版时，更新的预发布版同样按 `update-available` 处理；
  - 已是最新 → `up-to-date`。
- 目标版本的 `engines.dsh`（存在则单独决定）或 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer 依赖，会按 app-boot 的兼容性语义与当前 DSH 运行版本比较（预发布参与范围匹配；`workspace:^|~|*` 表示运行版本）：
  - 满足 → `compatible`；不满足 → `incompatible-update` 并给出 `compatibilityRequirements`；
  - 上游缺少/畸形 manifest → `compatibility: unknown`（不会当成兼容）。
- 每次查询超时 12s；单批并发最多 4；结果写回检查缓存（`state.json` 的 `checks`，TTL 5 分钟）。

### 6.2 Git 插件检查

- 已安装 commit 的来源优先级：Bundle 信息 → `version.currentCommit` → Profile 的 `pnpm-lock.yaml` resolution（支持 pnpm lock v6/v9 布局）。
- 远端 ref 由安装 spec 解析（`github:`、`git+https/ssh`、`git://`、`git@host:owner/repo`、GitHub `/tree/<ref>[/subdir]` 等；`#semver:<range>` 会解析为满足范围的最高 tag）。
- 用 `git ls-remote` 比较远端 commit（12s 超时、可中止、禁止凭据交互）；`update-available` 时返回 `availableCommit`，相同则 `up-to-date`。
- 缺少已安装 commit（Bundle 与锁文件都没有）→ `needs-source`；本机无 git / 远端不可达 / ref 不存在 → `check-failed` / `network-error`。
- Git 安装的 **DSH 兼容性为 `unknown`**（不会拉取远端 `package.json` 评估），详情里会提示更新前人工核对；Git 来源的更新规则见 §6.4（单项确认、批量默认跳过）。

### 6.3 Skills 检查

- 三种来源：`skills` CLI 锁文件（`skillFolderHash`）、用户确认过的 GitHub 来源、本地 git 仓库（`git remote` + 相对 subdir）。
- 本地侧用与 git 相同的对象算法计算技能目录 tree SHA；远端侧通过 GitHub trees API 读取该目录的 tree SHA（一次仓库级递归树，天然忽略 monorepo 其它目录的变化）。
- 状态：
  - 远端 tree 与本地基线不同 → `update-available`（`availableTree`，channel `commit`）；
  - 一致 → `up-to-date`；
  - 本地内容与基线不同 → `local-modified`（更新需要显式确认覆盖）；
  - 无基线（既无锁文件哈希也不在 git 仓库）→ `check-failed`；
  - 网络失败 → `network-error`（不会显示为最新）；
  - GitHub 匿名 API 限流（403/429 且 `x-ratelimit-remaining: 0`）→ 明确提示限流与恢复时间；设置 `GITHUB_TOKEN` / `GH_TOKEN` 可提高限额。
- 每次请求 12s 超时，单批并发最多 4。

### 6.4 更新执行规则（插件）

每个项是一个持久化事务：`PREFLIGHT → BACKUP → DOWNLOAD → STAGE → INSTALL → VALIDATE → PENDING_RESTART / VERIFIED`，任一步失败进入 `FAILED → RECOVERY → RECOVERED / RECOVERY_REQUIRED`。规则与要点：

- 硬排除（不进 entries，直接给 `excludedReason`）：管理器自身、DSH 保护/随装组件、不可更新/不可卸载、本地 link/路径/tarball 来源、检查结果不是候选/不兼容、缺少目标版本或 Git commit。
- 别名安装（`npm:` spec）不在计划阶段排除，而是在 **PREFLIGHT 阶段拒绝**（“该插件以别名方式安装，不支持自动更新”），此时未产生任何修改，事务以 blocked/失败记录后清理。
- **npm 来源**：满足全部预检即可批量自动更新。预检包括：检查缓存仍有效（目标版本存在、非降级）、与当前 DSH 兼容、安装目录存在且可写（拒绝符号链接目录）、Profile 可写、磁盘空间足够（≥ 2× 目录大小 + 64 MiB）、重新确认 registry 中存在目标版本、与 **当前版本的 registry tarball** 逐文件 SHA-256 比较识别本地修改（该比较结果按 60 秒缓存，避免重复下载）。
- **Git 来源（已实现，单项确认更新）**：计划给 `availableCommit` 时进入 entries，但标记 `eligible: false` + `requiresConfirmation: true`（批量默认跳过），`targetVersion` 为短 commit，risk 说明“按远端 commit 重新安装、安装脚本副作用无法完全回滚、更新前备份”。执行时 `INSTALL` 用 `origin#<commit>` 构造 git spec 先卸载再安装；`DOWNLOAD/STAGE` 不预下载/不解包；`VALIDATE` 读回 `listBundles()` 并核对 `pnpm-lock.yaml` 中的 commit 与目标一致；`BACKUP/RECOVERY` 与 npm 相同。Git 没有发布基线，预检把本地修改视为 `unknown`，因此 **执行该项需要 `overwriteLocalModifications: true`**（页面上即“确认覆盖”）。真实仓库的更新成功与失败回滚已在隔离环境验收通过（见 [docs/testing.md](docs/testing.md)）。
- 需要用户确认的项（npm 本地被修改/无法比较、仅预发布、兼容性未知、Git 安装、技能本地修改）统一 `eligible: false` + `requiresConfirmation: true`；**单项计划**可在 `confirmed: true` 后执行（PREFLIGHT 复核），**批量**只执行 `eligible` 项，批量带 `overwriteLocalModifications: true` 时才放行确认项。
- 备份：安装目录 + Profile 的 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`compatibility.json` 快照，写入 `backups/<txid>/` 并在破坏性操作前重新校验哈希；失败时从备份恢复（Git 来源的回滚只覆盖安装目录/清单，无法回滚安装脚本对外部环境的副作用）。
- 安装：先 `pluginManager.removeBundle(name)`，再 `pluginManager.installBundle(<spec>, { saveExact: true, enabled: 原启用状态, registry })`；npm 用 `${name}@${target}`，Git 用 `origin#<commit>` 形式的 spec。没有 HMR 的环境若无法卸载运行中的包，会改为直接覆盖安装并如实标记需要重启。
- 校验：读回 `listBundles()` 比对版本、启用状态、安装位置与错误（Git 额外核对 lockfile commit）——退出码 0 不算成功。
- 取消语义：安装开始前的取消会放弃事务且不修改现场；安装已开始后的取消会被标记“太晚”，但会继续完成校验，避免留下半替换状态。
- 写操作全局串行（进程级队列），同一时间只允许一个更新任务。

### 6.5 更新执行规则（Skills）

- 只替换单个技能目录；先备份到 `backups/<txid>/skill` 并校验。
- 下载 GitHub 归档（codeload）→ 本地解包 → 复算技能子目录的 git tree SHA，必须与检查得到的 `availableTree` 一致才继续。
- 替换：先把旧目录移动到备份侧，再移入新目录；失败立即移回；校验通过后删除备份侧的旧目录并推进用户确认来源的基线（避免下次重复提示同一更新）。
- 平铺单文件技能、来源未验证、目录含符号链接、目录不在其发现根内、未确认的本地修改都会被拒绝。

## 7. 数据、日志与备份

管理器自己的数据目录：`$DSH_HOME/extension-manager/`。

```
extension-manager/
├─ state.json          # 持久化状态（schema version 1），写入原子替换，保留上一版 state.json.bak
├─ logs/
│  └─ manager.log      # JSON Lines；单文件 1 MiB 上限，轮转保留 .1/.2/.3
├─ backups/
│  └─ <transactionId>/ # 每个更新事务的备份（成功/失败都保留）
│     ├─ manifest.json #   schema/事务/kind/源路径/文件树哈希/Profile 快照哈希
│     ├─ package/      #   插件安装目录快照（plugin）
│     ├─ profile/      #   Profile 清单文件快照（plugin）
│     ├─ skill/        #   技能目录快照（skill）
│     └─ skill-old/    #   替换期间暂存的旧技能目录（仅技能更新期间）
└─ staging/
   └─ <transactionId>/ # 下载与解包暂存；事务结束或 Host 启动时清理
```

`state.json`（`version: 1`）字段：

| 字段 | 内容 |
| --- | --- |
| `checks` | 检查缓存，键为 `plugin:<recordId>` / `skill:<recordId>`；含 status、currentVersion、availableVersion/availableCommit/availableTree、channel、compatibility、compatibilityRequirements、checkedAt、detail |
| `skillSources` | 用户确认的技能 → 仓库关联（url/ref/subdir/baseline/verified/detail） |
| `transactions` | 持久化事务（phase、steps 审计行、backupDir、result、error、needsRestart、rolledBack 等） |
| `history` | 更新历史（最新 500 条） |
| `settings` | `includePrerelease`、`lastCheckAt`、`dismissed` 等设置 |

日志为每行一个 JSON 文档（`ts/level/event/detail`），写入前会脱敏（GitHub token、`npm_` token、Bearer、URL 中 userinfo、token/apiKey/password/secret 字段）。日志写入失败不会打断任何操作。

备份与恢复：

- 自动恢复：失败时从已校验的备份恢复安装目录与 Profile 文件，恢复后重新哈希校验；成功则事务标记 `RECOVERED`（`rolledBack: true`），失败则 `RECOVERY_REQUIRED` 并保留备份路径。
- 启动恢复：Host 启动时（`index.ts` 中 `updates.recover()`）扫描所有非终态事务：
  - `PREFLIGHT/BACKUP/DOWNLOAD/STAGE` 中断 → 未触碰实际安装，标记 `RECOVERED`（“未产生修改”）；
  - `INSTALL/VALIDATE/FAILED/RECOVERY` 中断 → 从备份恢复并校验；
  - `PENDING_RESTART` → 重新读回版本/启用状态，正确则 `VERIFIED`，否则恢复。
- 手工恢复：先停止 DSH；把 `backups/<txid>/package`（或 `skill`）内容复制回记录中的安装目录，并（插件）把 `backups/<txid>/profile/` 下的文件复制回 Profile 目录；再用 `manifest.json` 中的哈希核对。或者直接用 `dsh plugin --profile web add ...` 重新安装目标版本。
- **备份保留策略**：Host 每次启动（`recover()` 之后）以及可手动调用的 `UpdateExecutor.maintain()` 会清理备份：**保留最近 20 个事务的备份**；属于未完成事务（`openTransactions()`）的备份**永不删除**；删除操作写入日志（`updates.backup-pruned`）；失败事务的备份保留。同时清理 `staging/` 下 **24 小时**前的残留目录（`updates.staging-cleaned`）。长期运行时仍建议偶尔人工检查备份目录占用。

## 8. 维护与二次开发

### 8.1 模块结构

```
src/
├─ host/                     # Host 半（Node，运行在 DSH Host 进程）
│  ├─ index.ts               # Cordis 插件入口：组装 state/inventories/checkers/executor/routes，启动恢复
│  ├─ contracts.ts           # HostServices / PluginInventory / SkillsInventory / checkers / UpdateManager 契约
│  ├─ env.ts                 # profileContext、registry、pnpm/git 版本、路径与依赖 spec 分类
│  ├─ state.ts               # state.json 持久化（schema v1、原子写、串行 flush）
│  ├─ logs.ts                # JSON Lines 日志、1 MiB 轮转、脱敏
│  ├─ tasks.ts               # 内存任务注册表（保留 40 个）
│  ├─ routes.ts              # 同源 JSON HTTP API、认证/CSRF 边界、诊断载荷
│  ├─ inventory/plugins.ts   # Bundle / 插件行三层清单与 reconciliation
│  ├─ inventory/skills.ts    # 物理/运行时双清单、覆盖关系、来源、静态诊断
│  ├─ inventory/skillRoots.ts# 技能根解析、SKILL.md frontmatter、git tree/锁文件工具
│  ├─ inventory/pluginMeta.ts# 部分已知插件的展示名/描述
│  └─ updates/               # 检查与更新实现（见 docs/architecture.md）
└─ client/                   # Web client 半（React，运行在 DSH Web GUI 内）
   ├─ api.ts                 # 同源 JSON transport（标记头、超时、错误归一化、任务轮询）
   ├─ app.tsx                # 页面容器：双页状态、任务生命周期、弹窗与提示
   ├─ model.ts               # 视图模型：状态/筛选/排序/分组/统计文案
   ├─ ui.tsx                 # 通用小组件（提示条、复制按钮、状态标签…）
   ├─ styles.ts              # 使用 --dsw-* token 的样式
   ├─ workspaces.ts          # 全局 useWorkspaces 钩子的结构化类型视图（Skills 工作区选择器）
   ├─ fixture.ts             # 仅 ?emFixture=1 使用的预览数据
   └─ components/            # header/stats/toolbar/record-list/details/update/task/diagnostics
```

关键依赖 API（均来自 DSH 0.2.1-rc.2）：

| 接口 | 用途 |
| --- | --- |
| `profileContext` | 当前 Profile 事实：`name/dir/home/installAnchor/cwd/startedBundles` |
| `ctx.webServer.register({ kind: 'prefix', path, handler })` | 挂载 `/api/dsh-extension-manager` 前缀路由 |
| `ctx.pluginManager.listBundles()` / `listPlugins()` | Bundle 清单（版本/来源/启用/行/错误）与运行时插件行 |
| `ctx.pluginManager.registries()` | registry 首选/回退/pnpm 解析值 |
| `ctx.pluginManager.removeBundle(name)` / `installBundle(spec, { saveExact, enabled, registry })` | 插件更新安装 |
| `ctx.skills`（snapshot/list） | 运行时技能目录（清单 B） |
| `ctx.get('loader')` / `ctx.get('configEditor')` | 解析 `@deepseek-ai/dsh-skill-filesystem` 的 `customSkillDirs/bundledSkillDir/includeDefaultRoots` 等配置（可选，缺失时退回默认根） |
| `ctx.get('workspaceRegistry')` | 校验请求中的 workspace 是否已注册（可选） |
| `ctx.get('connection').admit({ headers })` | 与官方 `/api` 相同的浏览器信任围栏与签名 Cookie 认证 |
| `ctx.get('hmr') !== undefined` | 判断当前 Host 能否热应用 Profile 变更（影响“是否需要重启”） |
| `ctx.get('agents')` | 观察 Agent 预设挂载的额外技能根（可选） |
| 事件 `plugin-manager/changed`、`skills/change` | 使清单缓存失效 |

### 8.2 构建与发布

- `node scripts/build.mjs`：Host 输出 `lib/index.js`（esbuild，Node ESM，bundle，目标 node22）；client 输出 `lib/client.js`（esbuild CJS bundle + ModuleLoader 包装；React、cordis、`@deepseek-ai/dsh-client-ui-*` 为外部依赖，由运行时注入）。
- Host 打包时必须保留构建脚本中的 `createRequire` banner：`yaml` 与 `undici` 是被内联的 CJS 依赖，ESM 产物需要真实的 `require` 才能加载；去掉 banner 会导致 Host 插件加载时报 `Dynamic require of "process" is not supported`。
- 类型检查 `npm run typecheck`（`tsc --noEmit`，开启 `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess` 等严格选项）。
- 发布前 `npm pack`；打包内容应与 `package.json` 的 `files` 一致（`lib/`、`cordis.patch.yml`、README、LICENSE、架构与弹窗布局文档）。`npm pack` 后建议核对文件数/体积。

### 8.3 测试

```bash
npm test             # 等价于 node --test（package.json 的 test 脚本）
node --test          # 全部测试（node 原生 TS 运行，无需构建）
```

当前测试（`npm test`：119 个用例全部通过，约 1.5s）：

| 文件 | 覆盖 |
| --- | --- |
| `test/plugin-updates.test.ts` | registry 策略/公共源回退限制、packument 解析、候选选择、兼容性判定、代理/NO_PROXY、git spec/lockfile 解析、peeling 等 |
| `test/skills.test.ts` | SKILL.md frontmatter、技能根解析、git tree 哈希、锁文件解析、覆盖关系 |
| `test/updater.test.ts` | 事务状态机迁移、备份校验、tarball/归档解析、Windows 替换语义、失败回滚、崩溃恢复、串行队列 |

隔离验收环境（不触碰真实 `~/.dsh` 与 `~/.agents`）：

```bash
node scripts/test-env/setup.mjs                    # 创建 _test/env1/{dsh-home,agents-home,workspace} 夹具
node scripts/test-env/start.mjs --port 3099        # 以独立 DSH_HOME/DSH_AGENTS_HOME 启动 DSH Web（--no-open）
node scripts/test-env/run-all.mjs                  # 依次执行 npm/Git/Skills 更新、回滚、本地修改、并发、中断恢复等场景
node scripts/test-env/stop.mjs                     # 只结束记录的 pid 树
```

`scripts/test-env/` 内的场景脚本包括 `scenario-batch.mjs`（并发 + 批量）、`scenario-git-plugin.mjs`（Git 更新与失败回滚）、`scenario-skill-update.mjs`（技能更新）、`scenario-plugin-localmod.mjs`（本地修改/覆盖）、`scenario-interrupt.mjs`（更新中断后重启恢复），以及夹具准备脚本。默认夹具根目录为 `../_test/env1`，可用 `node scripts/test-env/setup.mjs <root>` 指定其他目录；`out/` 下记录 `server.log`、`server.pid`、`url.json`（带鉴权 token 的本机 URL）。

验收方法与结果摘要见 [docs/testing.md](docs/testing.md)。页面/API 联调与截图使用 `scripts/dev/shot.mjs` + `scripts/dev/mint-cookie.mjs`（自建 CDP 客户端，需要已 mint 的浏览器 cookie；本地 cookie 文件已被 `.gitignore` 忽略），截图输出在 `scripts/dev/out*`，仅用于开发验收，不随包发布。

开发时让正在运行的 Host 重载已重建的 `lib/index.js`：

```bash
node scripts/dev/reload-host.mjs [profile] [waitMs]
```

它会临时向该 Profile 的 `cordis.patch.yml` 追加注释触发重组合，等待后恢复原始字节（脚本自行还原）。

### 8.4 数据维护

- 想清空检查历史/更新历史：停止 DSH 后删除 `$DSH_HOME/extension-manager/state.json`（以及 `.bak`），下次启动会创建空文档。
- 想清理备份/暂存：确认没有未完成事务（诊断/更新历史里没有 `RECOVERY_REQUIRED`，或检查 `state.json` 的 `transactions`）后，手动删除 `backups/` 下的旧目录与 `staging/` 内容。
- 日志：`logs/manager.log` 及 `.1/.2/.3`；可安全删除旧的轮转文件（运行中不要删除正在写入的主文件）。

### 8.5 前端维护

- 页面只通过 `src/client/api.ts` 的 transport 访问 Host；`?emFixture=1` 时切换到 `fixture.ts` 的本地预览 transport，**默认路径不会加载任何假数据**。
- 组件不使用第三方 UI 依赖，只用 DSH 注入的 `@deepseek-ai/dsh-client-ui-primitives` / `ui-slots`；样式使用 `--dsw-*` 主题 token，支持明暗主题与 `prefers-reduced-motion`。
- 构建后 `lib/client.js` 会被运行中的 DSH Web 页面热替换；Host 半需要重启或按 §8.3 的 reload 脚本触发重组合。
- 弹窗布局统一遵循共享契约：`.em-dialogShell`（更新确认/诊断，套在 DSH Modal chrome 上）与 `.em-detailDialog`（详情，headless 自绘）都保证标题到上边缘约 24px、操作按钮到下边缘 24px、Body 单滚动、Footer 固定可见。规范、根因与量化验收见 [docs/dialog-layout.md](docs/dialog-layout.md)，自动化回归：`node scripts/dev/verify-dialog-layout.mjs --url <token-url> --cookie <cookie.json>`。

### 8.6 管理器自身更新策略

- 环境面板/诊断显示 `selfUpdateSupported: false`，原因：当前为本地构建安装，未配置可信上游发布源；管理器自身更新需要重新打包安装。
- 更新计划中 `dsh-extension-manager` 永远被排除（“管理器自身不参与自动更新”），检查更新也不会把它标为可更新（它当前是 `file:` 本地 tarball 安装，没有可核对的上游发布源）。
- 升级管理器：`npm install && node scripts/build.mjs && npm pack`，然后按 §3.3 重新安装（`dsh plugin --profile web add <tgz>`；link 安装则重新构建并按 §8.3 触发重载），最后重启 DSH。

## 9. 已知限制

以下是当前版本的真实边界（不是“TODO 待实现”，而是已确认的行为）：

1. 随 DSH 安装提供的组件不在本页展示、统计或更新，由 DSH 左侧导航的 **Built-in plugins** 页面管理，并随 DSH 发行版更新。
2. 其他 Profile 的插件只读展示（已用隔离环境的 `alt` Profile 验收：只读记录不可更新、同名物理安装不重复计数并带 `alsoInProfiles` 提示）。
3. Skills 没有逐技能启停（`canToggle: false` 并给出原因）；页面只展示真实状态。
4. 插件自动更新：npm Registry 来源可批量自动更新；Git 来源只支持**单项确认更新**（批量默认跳过，且需要确认覆盖本地修改）；本地 link / 本地路径 / tarball 来源需要手动更新。
5. Git 安装的 Bundle 更新以“按远端 commit 重新安装”执行，安装脚本对外部环境的副作用无法由备份完全回滚；因此必须逐项确认。
6. Git 安装插件的兼容性固定为 `unknown`（不评估远端 `package.json`）。
7. Skills 自动更新仅支持 GitHub 来源（锁文件/用户确认来源/本地 git remote）；非 GitHub git、平铺单文件技能、含符号链接的技能目录不支持自动更新。
8. 网络失败/超时/限流不会自动重试，也不会被当成“已是最新”；页面显示明确原因与重试入口。
9. 更新计划生成时会对 npm 候选下载当前版本 tarball 做本地修改比较，最坏多等数秒（比较结果缓存 60 秒）。
10. pnpm 构建脚本授权沿用 Profile 的设置，管理器不绕过 pnpm 的构建授权；因此失败的安装会回滚并提示原因。
11. 当前版本**不提供“取消正在进行的更新”按钮**（避免中断恢复歧义）；更新失败后可重试。
12. 官方 GitHub Release changelog 展示未实现；详情提供版本、来源与提交/tree 信息。
13. 管理器自身不支持页面内自更新（本地构建安装，无发布源）；也从不重启 DSH。
14. 备份保留最近 20 个事务（未完成事务的备份受保护），`staging/` 清理 24 小时前的残留。
15. 更新历史只记录 update / batch-update / skill-update；GitHub 来源关联（目前仅 Host API）不写历史。
16. 验收环境为 Windows；代码包含 POSIX 分支但未在 macOS/Linux 实测。

**当前未提供（内部接口整理事项，不影响使用）**

- `/shutdown` 端点常量存在于共享契约，但 Host 未注册路由（访问 404）；当前页面不需要它。
- `POST /refresh` 路由已实现，但前端刷新使用 `GET /plugins?refresh=1` / `GET /skills?refresh=1`，该端点暂无调用方。
- 技能的 GitHub 来源关联目前通过 Host API `POST /skill-source` 提供（校验 GitHub 地址、计算本地 tree 基线、核对远端目录并持久化），页面暂无“关联来源”表单入口。

## 10. 故障排查

| 现象 | 可能原因与处理 |
| --- | --- |
| Settings 里没有「扩展管理器」 | Host 插件未加载：确认 profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-extension-manager`、依赖 spec 正确；查看 DSH Host 日志中的 `[extension-manager]` 行；重建后重启或触发 reload |
| 页面提示 `authentication-required`（401） | 与官方 `/api` 相同的签名 Cookie 认证；在已登录的同一浏览器会话中打开 DSH Web |
| 页面提示 `forbidden-host`（403） | Host 头/来源不被信任（非本机访问）；使用 DSH 提供的本机 URL |
| 请求返回 415 / 403 `forbidden-mutation` | 写请求必须带 `content-type: application/json` 与 `x-dsh-extension-manager: 1` 标记头；这是跨站防护，浏览器页面会自动携带 |
| 检查结果大量 `network-error` | 网络不可达或代理配置问题；可在诊断中查看 Registry/代理；配置 `HTTPS_PROXY`/`NO_PROXY`；私有 registry 不会被回退到公共源 |
| `incompatible-update` | 目标版本声明了与当前 DSH 不兼容的 `engines.dsh`/peer 依赖；升级 DSH 或等待兼容版本，页面不会允许自动更新 |
| `prerelease-only` | 只有预发布版本有更新；默认不进入安全批量更新，需要逐项确认 |
| 更新按钮禁用 | 悬停可看原因：没有检查过、来源不支持自动更新、管理器自身、本地修改未确认等 |
| 更新失败并要求人工恢复 | 查看任务面板与更新历史，备份在 `$DSH_HOME/extension-manager/backups/<txid>/`，按 §7 手工恢复；日志 `logs/manager.log` |
| GitHub 检查提示限流 | 匿名 GitHub API 每小时 60 次；设置 `GITHUB_TOKEN`/`GH_TOKEN` 环境变量后重启 DSH |
| Skills 显示“未托管” | 该目录（如 `~/.codex/skills`）不属于 DSH 读取的根，管理器不会修改它 |
| 管理器自己出现在可更新列表 | 不应发生：管理器自身被排除；若出现请记录日志并反馈 |

## 11. 实测记录

**构建与测试（可重复）**

- `npm test`（= `node --test`）：119 个用例全部通过（约 1.5s）。
- `npx tsc --noEmit`：0 错误。
- `node scripts/build.mjs`：成功生成 `lib/index.js`（Host ESM bundle）与 `lib/client.js`（Web client bundle）；`import('./lib/index.js')` 可正常加载（`apply` 为函数）。
- 真实 registry 抽样：`dsh-context` 当前 `0.73.0` → `up-to-date`；`0.60.0` → `update-available`（与 DSH `0.2.1-rc.2` 兼容）；`@michengai/dsh-skills-manager 1.2.5` → `up-to-date`；`dsh-better-sidebar`、`@eddyskywalker/dsh-chatgpt-subscription` 旧版本 → `update-available`；伪造旧 DSH 版本时同一批包 → `incompatible-update` 并列出未满足的 `engines.dsh`/peer 依赖。
- 私有 registry（不可达地址 + 公共 fallback 配置）→ 仅尝试私有源并返回 `network-error`，未回退公共源。
- GitHub 隔离验证：`git ls-remote` 读取真实 commit；旧 commit → `update-available`，相同 → `up-to-date`；仅锁文件记录 commit 的安装能被识别；GitHub 网络中断时返回 `network-error`/超时而不会显示“已是最新”；匿名限额耗尽时可用 `GITHUB_TOKEN`/`GH_TOKEN`（或已登录的 `gh` CLI）兜底。
- 更新事务与端到端：`test/updater.test.ts` 覆盖事务状态机迁移、备份校验、归档解析、Windows 替换语义、失败回滚、崩溃恢复、串行队列；隔离环境真实执行了 npm 更新、**Git 更新与失败回滚**、Skills 更新、本地修改冲突/覆盖、批量更新、并发 409、中断恢复、Windows 文件占用回滚。

**实测（Windows，DSH 0.2.1-rc.2）**

- 正式安装：通过 `dsh plugin --profile web add <tgz>` 并启用 Bundle 后，Host 加载成功，`GET /api/dsh-extension-manager/health` 返回 ok。
- Plugins 清单：在具备多个第三方插件的真实 Profile 上验证 Bundle / Loader 行 / 运行时三层清单与完整对账；名称、来源、版本、安装位置均来自 Host 真实读取。
- Skills 清单：物理副本与运行时清单双视图、同名覆盖、未托管根、Junction 去重均验证（physical 12→11 去重）。
- 更新检测：npm Registry、`git ls-remote`、GitHub trees API 均以真实上游响应验证；网络失败/限流不会显示为“已是最新”。
- Web 页面：在 DSH Web GUI「Settings → 扩展管理器」完成 Plugins/Skills、详情、诊断、更新计划、明暗主题与多尺寸截图验收。
- 多 Profile：其他 Profile 以只读清单展示，`alsoInProfiles` 合并同名 Bundle。
- 具体数值随 Profile 与上游版本变化，不作为固定承诺。

**隔离环境验收（摘要，详见 [docs/testing.md](docs/testing.md)）**

- 反向验收 20 项全部通过：清单完整性、多 Profile、同名 Skills、Junction 去重、真实来源识别、兼容性、npm/Git/Skills 更新、本地修改确认、失败回滚、Windows 文件占用、中断恢复、并发/批量 409、UI 真实性。
- `node scripts/test-env/run-all.mjs` 的 7 个场景全部通过；`node scripts/dev/verify-dialog-layout.mjs` 的弹窗布局检查 19/19 通过。

## 12. 许可

本项目使用 MIT 许可，仓库根目录的 `LICENSE` 为完整许可文本。
