# DSH 扩展管理器 · 架构文档

> 对象：需要维护/扩展 `dsh-extension-manager` 的开发者。
> 范围：Host 半（`src/host/**`）、Web client 半（`src/client/**`）、共享契约（`src/shared/**`），以及两者的数据/状态/安全边界。
> 说明：本文对应 **v0.1.0**（DSH 0.2.1-rc.2 基线）。功能与接口描述均来自本仓库源码；验收方法见 [testing.md](testing.md)。Git 安装 Bundle 更新与 `requiresConfirmation` 项的 Web UI 确认链路均已实现并验收；当前确实未提供的能力在 §14 如实列出。

- 用户与维护指南：[../README.zh.md](../README.zh.md)
- 英文简版：[../README.md](../README.md)

---

## 1. 设计目标与原则

1. **Host 是唯一的事实来源。** 所有文件系统读取、网络访问、包操作都在 Host 进程内完成；Web client 只渲染 Host 返回的记录并调用受控 JSON API。client 不推导“真实状态”。
2. **三层真实性分离。** 插件区分「安装的 Bundle（包）」「Bundle 声明的 Loader 行」「运行时实际加载状态」；技能区分「物理副本（清单 A）」与「运行时可见技能（清单 B）」。同一概念的三层不合并成一个真假难辨的字段。
3. **失败必须可见，不能被折叠成成功。** 检查失败/网络失败/未知分别有独立状态；更新安装以读回校验为准，不以退出码为准；清单读取不完整时页面显著标注并列出失败来源。
4. **不信任客户端输入。** 写操作只接受 inventory id，路径由 Host 侧解析；workspace 参数必须命中已注册工作区/当前 cwd/DSH home 内的目录；下载内容按哈希校验后才落盘。
5. **可恢复。** 破坏性更新一律先做可校验的备份；失败/崩溃后能从备份自动或人工恢复；事务状态持久化，Host 重启后能对账。
6. **可测试的边界。** 网络与归档下载在执行器中是可注入端口（`NpmNetwork` / `ArchiveDownloadPort`）；检查与解析的纯函数被导出并用 Node 原生测试覆盖。

## 2. 模块图

```
┌──────────────────────────────── DSH Web GUI (browser) ────────────────────────────────┐
│  lib/client.js  (this package, bundled into the ModuleLoader closure)                  │
│                                                                                        │
│  src/client/index.tsx      register settings.section(id=extension-manager)             │
│  src/client/app.tsx        page container: scope tabs, load states, tasks, dialogs     │
│  src/client/model.ts       view model: filters/sort/groups/stat cells/labels           │
│  src/client/ui.tsx         shared widgets (notice/copy/status tag/...)                 │
│  src/client/api.ts         Transport: fetch JSON + marker header + poll task           │
│  src/client/workspaces.ts  typed view of the global useWorkspaces hook (Skills)        │
│  src/client/fixture.ts     preview-only transport (?emFixture=1)                       │
│  src/client/components/*   header/stats/toolbar/record-list/details/update/task/diag   │
└───────────────────────────────────────┬────────────────────────────────────────────────┘
                                        │ same-origin JSON, header x-dsh-extension-manager: 1
                                        ▼
┌──────────────────────────────── DSH Host process ──────────────────────────────────────┐
│  lib/index.js  (this package, one Cordis plugin row)                                    │
│                                                                                        │
│  src/host/index.ts        wiring: state + inventories + checkers + executor + routes    │
│  src/host/routes.ts       /api/dsh-extension-manager/*, admission & body validation     │
│  src/host/contracts.ts    HostServices / checkers / inventories / UpdateManager          │
│  src/host/env.ts          profileContext, registries, versions, spec classification     │
│  src/host/state.ts        state.json schema v1, atomic serialized writes                 │
│  src/host/logs.ts         JSON-lines log, 1 MiB rotation, secret masking                 │
│  src/host/tasks.ts        in-memory TaskRegistry                                        │
│                                                                                        │
│  src/host/inventory/plugins.ts     bundles ← rows ← runtime (3 layers) + other profiles │
│  src/host/inventory/skills.ts      physical list A + runtime list B + provenance         │
│  src/host/inventory/skillRoots.ts  root resolution, SKILL.md, git trees, lockfile        │
│  src/host/inventory/pluginMeta.ts  localized display metadata for known bundles          │
│                                                                                        │
│  src/host/updates/checker.ts       UpdateCheckService (single-flight + TTL cache)        │
│  src/host/updates/pluginUpdates.ts PluginUpdateChecker (npm/git/no-source)               │
│  src/host/updates/npmClient.ts     registry policy, packument/tarball, compat, semver    │
│  src/host/updates/gitClient.ts     git spec/lockfile/ls-remote                           │
│  src/host/updates/skillUpdates.ts  SkillUpdateChecker (GitHub trees/lock/git)            │
│  src/host/updates/executor.ts      plan + durable update transactions + recovery         │
│  src/host/updates/backup.ts        hash tree / copy / verify / restore / retry (Windows) │
│  src/host/updates/tarball.ts       minimal tar/gzip reader, safe extract, git tree hash  │
│                                                                                        │
│  src/shared/types.ts   transport-safe records (no Node/browser APIs)                     │
│  src/shared/api.ts     HTTP contract: prefix, marker header, endpoints, request/response │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

运行形态：`cordis.patch.yml` 把一个 Loader 行（id `extension-manager`）插入 Profile；`package.json.dsh.client` 声明 Web 平台与注入的 primitives/slots，`exports["./client"]` 指向 `lib/client.js`，由 `@deepseek-ai/dsh-client-modules` 提供给 Web 页面。

## 3. 模块职责与依赖方向

依赖方向固定为：`routes → checker/executor/inventories → env/state/logs`；`inventories/updates` 之间只通过显式导出协作，没有循环依赖。

| 模块 | 职责 | 关键导出 |
| --- | --- | --- |
| `src/host/index.ts` | Cordis 插件入口；组装 `ManagerState`、两个清单、两个检查器、`UpdateCheckService`、`UpdateExecutor`、路由；注册事件使缓存失效；启动时对账未完成事务 | `name`、`inject`、`apply(ctx)` |
| `src/host/contracts.ts` | Host 内部契约；所有并行实现模块的接口在这里收敛 | `HostServices`、`PluginInventory`、`SkillsInventory`、`PluginUpdateChecker`、`SkillUpdateChecker`、`UpdateManager`、`CheckBatchResult` |
| `src/host/env.ts` | profile 事实、registry、pnpm/git 版本、包目录解析、依赖 spec → `SourceInfo` 分类、环境快照 | `profileFacts`、`readEnvironment`、`classifyDependencySpec`、`resolvePackageDirectory`、`lockfilePath`、`SELF_PACKAGE_NAME` |
| `src/host/state.ts` | 持久化文档与串行原子写；检查缓存/技能来源/事务/历史/设置的读写 API | `ManagerState`、`managerPaths`、`CheckCacheEntry`、`STATE_VERSION=1` |
| `src/host/logs.ts` | 结构化日志、轮转、脱敏 | `ManagerLog`、`maskSecrets`、`errorText` |
| `src/host/tasks.ts` | 内存任务注册表（check/update/batch…）；页面轮询任务 | `TaskRegistry`（创建/启动/逐项完成/结束、保留 40 个） |
| `src/host/routes.ts` | HTTP 适配：认证/信任围栏、请求体校验、路由分派、错误码、诊断载荷 | `registerRoutes`、`buildDiagnostics`、`RouterDeps` |
| `src/host/inventory/plugins.ts` | 插件三清单：Bundle、Bundle 行、运行时行；其他 Profile 只读；统计与 reconciliation | `PluginInventoryImpl`、`packageNameOf`、`managementErrorText` |
| `src/host/inventory/skills.ts` | 技能双清单、覆盖关系、运行时关联、来源/本地修改、统计与 reconciliation；用户确认来源 | `SkillsInventoryImpl`（含 `associateSource`） |
| `src/host/inventory/skillRoots.ts` | 技能根解析（托管/非托管、rank）、SKILL.md frontmatter、目录/平铺技能发现、git tree/锁文件工具 | `resolveSkillRoots`、`SKILL_RANKS`、`EXTERNAL_SKILL_ROOTS`、`computeSkillFolderTreeSha`、`readSkillLockFile`、`parseGitHubRepository` |
| `src/host/inventory/pluginMeta.ts` | 已知插件的展示名/描述映射 | `PLUGIN_DISPLAY`、`localizedText` |
| `src/host/updates/checker.ts` | 检查编排：选择可检查记录、TTL 复用、单飞任务、调用两个检查器、写缓存与 `lastCheckAt` | `UpdateCheckService`、`CHECK_TTL_MS`、`isFresh` |
| `src/host/updates/pluginUpdates.ts` | 插件检查器：npm registry、git commit、本地/未知来源的诚实状态；并发 4 | `PluginUpdateCheckerImpl` |
| `src/host/updates/npmClient.ts` | registry 策略（私有源隔离）、代理感知 HTTP、packument/tarball、候选选择、DSH 兼容性、semver 规则 | `registryPolicy`、`fetchNpmDocument`、`downloadTarball`、`selectUpdateCandidate`、`evaluatePluginCompatibility` |
| `src/host/updates/gitClient.ts` | git spec/GitHub URL 解析、pnpm-lock resolution、`git ls-remote` 比较 | `parseGitSpec`、`parseGitHostUrl`、`parseLockfileGitResolution`、`resolveRemoteCommit` |
| `src/host/updates/skillUpdates.ts` | 技能检查器：GitHub trees API、锁文件、git；本地基线/本地修改/限流处理 | `SkillUpdateCheckerImpl` |
| `src/host/updates/executor.ts` | 更新计划（纯决策函数）+ 事务引擎（PREFLIGHT→…→VALIDATE/RECOVERY）+ 启动恢复 + 串行写队列 | `UpdateExecutor`、`UpdateTransaction`、`TRANSACTION_TRANSITIONS`、`planPluginEntry`、`planSkillEntry`、`withInstallLock` |
| `src/host/updates/backup.ts` | 目录哈希清单、复制/校验、备份/恢复、Windows 重试与只读处理、原子写 | `BackupManager`、`hashTree`、`compareTreeManifests`、`PROFILE_SNAPSHOT_FILES`、`retryFs` |
| `src/host/updates/tarball.ts` | 极简 tar/gzip 读取、路径穿越防护、内容哈希、GitHub 归档下载、git tree SHA 计算 | `readNpmTarball`、`readTarArchive`、`extractArchive`、`gitTreeHashForEntries`、`downloadGithubArchive` |
| `src/client/**` | DSH Settings 分区 UI（React + primitives/slots），所有数据经 `Transport` | 见 §4 |

## 4. Web client 结构

- `index.tsx`：`ctx.slots.inject('settings.section', ...)` 注册分区，`id: 'extension-manager'`、`order: 26`、label `扩展管理器`。页面不是独立应用，依赖 DSH 注入的 `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-slots` 等外部模块。
- `app.tsx`：页面容器。维护 Plugins/Skills 两份 `LoadState`（idle/loading/ready/error，ready 时保留上次数据并附 `staleError`）、每页独立的筛选/排序/折叠状态、活动任务（check/update）及其轮询、更新确认弹窗、详情/诊断弹窗、Toast、离线和“等待重启”提示。加载有请求序号防抖动；任务轮询用 `AbortController` 清理。
- `model.ts`：把 `shared/types` 记录转成视图模型：状态标签/颜色、筛选（搜索/来源/状态/范围）、排序（名称/更新优先/最近检查）、来源分组、统计单元与 tooltip 文案、`isSafeUpdate`、`checkBlockedReason`/`updateBlockedReason` 等“为什么不能点”的人话。
- `api.ts`：`Transport` 接口 + HTTP 实现。所有请求带 `x-dsh-extension-manager: 1`，同源 credentials；POST 带 JSON content-type；错误归一化为 `ApiError{kind: network|http|timeout|aborted|invalid}`；`waitForTask` 每 700ms 轮询 `GET /task/:id`，15 分钟上限。
- `workspaces.ts`：`ui-workspace` 注入的全局 `useWorkspaces` 钩子的结构化类型视图（不直接依赖 workspace controller 包），供 Skills 页的“工作区”选择器读取 `items/path/title` 并把选中的工作区路径作为 `workspace` 扫描参数。
- `fixture.ts`：`?emFixture=1` 时启用的本地预览 transport（带“预览数据”标记）；默认 transport 不会引用假数据。
- `components/`：`header`（标题/胶囊/扫描元信息）、`stats`（五项统计，部分可点筛选）、`toolbar`（搜索/来源/状态/范围或工作区/排序/刷新/诊断/检查全部/更新全部）、`record-list`（来源分组、行与行操作、复制路径、空态）、`details-dialog`（全部字段 + 历史）、`update-dialog`（计划分块：将自动更新/将更新、需要确认已跳过、已排除；风险与勾选确认；单项/重试模式可确认 `requiresConfirmation` 项）、`task-panel`（进度/失败重试）、`diagnostics-dialog`（环境/探测/限制/技能 Provider/技能根目录/清单完整性）。
- 样式：`styles.ts` 全部使用 `--dsw-*` 设计 token，带明暗主题与 `prefers-reduced-motion` 适配；不引入第三方 UI/状态库。

## 5. 共享契约与数据模型（`src/shared/types.ts`、`src/shared/api.ts`）

### 5.1 记录类型

| 类型 | 语义 |
| --- | --- |
| `PluginBundleRecord` | 一个安装的 Bundle（包）：版本、来源、运行时、是否官方/自身、可移除、路径、贡献的行、覆盖的内置行、本地修改、诊断、可执行动作 |
| `PluginRowRecord` | 无法归属到任何 Bundle 的运行时 Loader 行（Profile 补丁插入或纯运行时观察） |
| `SkillRecord` | 一个物理技能副本：name/description/version、来源、rootKey/rootRank、layout（directory/flat-file）、paths、provider、effective/shadowedBy/overriddenCopies、invocation、本地修改、诊断、动作 |
| `VirtualSkillRecord` | 运行时可见但扫描根中没有物理副本的技能（provider 提供） |
| `Reconciliation` | 清单完整性：逐来源 `complete/error/location`、计数、未能对账项、说明 |
| `TaskState` | 异步任务：kind/scope/status、items（pending/running/ok/failed/skipped）、message/error、plan |
| `UpdatePlan` / `UpdatePlanEntry` | 更新计划：`kind` 为 `plugins`/`skills`/`all` 之一；entries（eligible/requiresConfirmation/needsRestart/risk/excludedReason）与 excluded |
| `TransactionRecord` | 持久化事务：phase、steps 审计、backupDir、needsRestart、rolledBack、result/error |
| `HistoryEntry` | 更新历史条目（outcome/action/from/to/transactionId） |

### 5.2 枚举约定

- `UpdateStatus`（20 个）：`unchecked`、`checking`、`up-to-date`、`update-available`、`incompatible-update`、`prerelease-only`、`needs-source`、`local-modified`、`no-source`、`network-error`、`check-failed`、`downloading`、`installing`、`validating`、`pending-restart`、`updated`、`update-failed`、`recovery-required`。
  - 检查器实际产出的检查态：`up-to-date` / `update-available` / `incompatible-update` / `prerelease-only` / `needs-source` / `no-source` / `local-modified` / `network-error` / `check-failed`。
- `SourceKind`：`npm`、`github`、`git`、`local-link`、`local-path`、`tarball`、`official`、`bundled`、`skill-git`、`skill-lock`、`filesystem`、`profile-patch`、`unknown`。
- `SourceTrust`：`verified` / `needs-confirmation` / `unknown` / `local-custom` / `official` / `no-remote-update` / `read-only-other-profile`。
- `TransactionPhase`：`PREFLIGHT`、`BACKUP`、`DOWNLOAD`、`STAGE`、`INSTALL`、`VALIDATE`、`PENDING_RESTART`、`VERIFIED`、`FAILED`、`RECOVERY`、`RECOVERED`、`RECOVERY_REQUIRED`。

### 5.3 HTTP 契约常量（`src/shared/api.ts`）

`API_PREFIX = '/api/dsh-extension-manager'`；标记头 `x-dsh-extension-manager: 1`；`ENDPOINTS` 覆盖 health/environment/plugins/skills/task/tasks/refresh/check/update-plan/update/history/skill-source/diagnostics/shutdown。请求/响应 body 类型也在该文件导出（`CheckRequest`、`UpdateRequest`、`DiagnosticsResponse` 等），client 与 Host 共用。

## 6. 三清单层（Plugins）

`src/host/inventory/plugins.ts` 的输入与归并规则：

1. **Bundle 层（安装包）**：`ctx.pluginManager.listBundles()`。只保留已安装（`installed`）或 DSH 安装提供的条目（catalog-only 条目不算安装）。字段来自 BundleInfo：`version`、`enabled`、`source`（安装 spec）、`removable`、`readOnlyReason`、`error`、`rows`、`overrides`、`availability`。
   - 来源分类：`env.classifyDependencySpec` 把 profile 记录的 spec 映射为 npm / git / local-link / local-path / tarball / unknown；DSH 安装提供 → `official`。
   - 安装目录：`resolvePackageDirectory(facts, name)`（profile 优先，DSH 安装目录兜底）。
   - id：`plugin-bundle:<profile>:<packageName>`。
2. **Bundle 声明的 Loader 行**：`bundle.rows` 与 `listPlugins()` 的实时条目按 `entryId` join；得到 enabled/loaded/fiberPhase/只读原因/错误。
3. **运行时行**：`listPlugins()` 中无法归属任何 Bundle 的条目 → `PluginRowRecord`。若 entryId 命中当前 Profile `cordis.patch.yml` 的 id，来源为 `profile-patch`，否则 `unknown`（诊断 `row/runtime-only`）。id：`plugin-row:<profile>:<entryId>`。
4. **其他 Profile**：`$DSH_HOME/profiles/*/package.json` 只读汇总（依赖名、bundles 数、可读性），用于统计 `bundlesOtherProfiles` 与“同时声明”提示。
5. **Reconciliation 来源**：`plugin-manager/bundles`、`plugin-manager/plugins`、`profile/manifest`、`profile/<name>`；`complete` 还要求没有 `availability: missing` 的 Bundle。运行时无法归属的行进入 `unexplained`。

统计口径（`PluginStats`）：`bundlesInstalled`（当前 Profile、已安装）、`bundlesEnabled`、`bundlesOtherProfiles`、`bundlesOfficial`、`rowsTotal`、`rowsLoaded`、`rowsFailed`、`updatesAvailable`（缓存 status=update-available）、`abnormal`（有 error 诊断或 runtime.error）。

## 7. 双清单层（Skills）

`src/host/inventory/skills.ts` + `skillRoots.ts`：

**清单 B（运行时）先观察**：`ctx.skills` 的 snapshot（Host 全局层 + 最多 8 个 Agent 预设 scope）给出运行时技能名与路径；若某个 Agent 预设挂载了 Host Loader 配置里看不到的 `skill-filesystem`，它会作为“运行时观察到的技能根”补充进清单 A 的扫描根（有 note 说明）。

**清单 A（物理）**：`resolveSkillRoots` 产出根列表：

| rank | 根 | managed |
| --- | --- | --- |
| 100 | 当前工作区项目根 `.dsh/skills` | 是 |
| 200 | 当前工作区项目根 `.agents/skills` | 是 |
| 300 | 运行时 `skill-filesystem` 配置的 `customSkillDirs`（含运行时观察到的根） | 是 |
| 400 | `$DSH_HOME/skills` | 是 |
| 500 | `$AGENTS_HOME/skills`（默认 `~/.agents/skills`） | 是 |
| 600 | 随 DSH 提供的技能目录（配置/`DSH_BUNDLED_SKILL_DIR`） | 是 |
| — | 已注册的其他工作区的项目根 | 是（但当前工作区无该项目时通常不生效） |
| — | `~/.codex/skills`、`~/.claude/skills`、`~/.copilot/skills`、`~/.cursor/skills` | 否（只读展示） |

每个根用同一套规则发现技能：目录 bundle（`SKILL.md` + frontmatter）或平铺 `<name>.md`；解析 name/description/invocation 等字段；非法条目进入诊断并让该根 `complete=false`。

**覆盖关系**：同名技能按 rank 竞争（数值小者优先），受管副本优先于非受管副本；胜者 `effective=true`，其它副本记录 `shadowedBy`/`overriddenCopies`。运行时可用时使用“运行时实际观察到的映射”作为生效关系（`linkRuntimeCatalog`），否则退回静态 rank 推断，并在 reconciliation 中说明。

**Junction / 符号链接去重**：同一物理目录通过 Junction 或符号链接被多个根到达时，按 realpath 归并成一份记录（`aliasPaths`/`aliasRootKeys` 保留别名词法路径与来源根，`counts.aliasCopies` 记录折叠数量），不重复计数，也不把别名当成新的技能副本（验收中 physical 12→11）。

**清单 B**：`ctx.skills.snapshot({ cwd, scope })` 读取 Host 全局层与 live Agent scope 的并集；运行时可见但扫描根中没有物理副本的技能成为 `VirtualSkillRecord`（virtual=true），不伪造物理路径。

**来源（provenance）**（`buildSource`）：

1. `state.skillSources` 中用户确认的关联 → `skill-git`（trust=verified，URL/repo/ref/subdir/commit，`detail` 说明是否通过远端校验）；
2. `~/.agents/.skill-lock.json` 条目 → `skill-lock`（记录 `sourceUrl`、`ref`、`skillFolderHash`；本地 tree 与 `skillFolderHash` 一致时 trust=verified，否则 needs-confirmation）；
3. 技能目录位于本地 git 仓库（`git remote`/branch/commit + 相对 subdir）→ `skill-git`；
4. 否则 `filesystem`（无远端来源；非托管根说明 DSH 不会加载）。

**可检查/可更新**：`canCheck` 只在“来源是 GitHub + 根受管 + 有可用基线（锁文件哈希/已确认来源 tree）”时为 true；`canUpdate=canCheck` 且仍需检查结果含 `availableTree`、目录形态、无未确认本地修改。`canToggle` 恒为 false，并给出原因（DSH 无逐技能启停机制）。

**id**：记录 id 为 `<rootKey>:<name>`（同名冲突时追加 `#2`、`#3`…，例如 `user-agents:tavily-search`）；检查缓存与 `CheckCacheEntry.recordId` 统一加前缀 `skill:<record.id>`。虚拟技能使用同前缀的 `skill:` 记录 id。

**Reconciliation 来源**：`skill-lock`（锁文件）、`skill-provider-config`（运行时配置来源）、`skill-runtime`（清单 B）、每个根的 `skill-root:<key>`、`skill-git-repositories`。`complete` 要求运行时清单可用且完整、锁文件读取无错、所有根读取完整。

## 8. 检查子系统（checkers）

### 8.1 编排（`updates/checker.ts`）

```
POST /check ─► UpdateCheckService.start
   ├─ 取 inventory（plugins/skills，scope/ids 过滤，只留 actions.canCheck）
   ├─ 未要求 refresh 且缓存 < CHECK_TTL_MS(5min) → 记为 skipped（不重新访问上游）
   ├─ 创建 TaskState（items = 待检查记录）
   ├─ 单飞：已有 running 任务 → 直接返回该任务（前端轮询同一个）
   └─ 后台 run()：pluginChecker.check → skillChecker.check → state.setChecks(outcomes)
        → patchSettings(lastCheckAt) → invalidate inventories → task.finish + 中文摘要
```

- 单飞靠 `UpdateCheckService.running`（一个 Host 进程一个活动检查任务）。
- 每个检查器的 `check()` 返回 `CheckBatchResult{outcomes, skipped, transportErrors, message}`，`outcome.cache` 以 `plugin:<id>` / `skill:<id>` 为键写入 `state.checks`。
- `onItem(record.id, running|ok|failed, message)` 实时更新任务行；client 每 700ms 轮询任务。

### 8.2 插件检查（`updates/pluginUpdates.ts`）

按 `record.source.kind` 分派：

| 来源 | 行为 | 典型状态 |
| --- | --- | --- |
| `npm` | 查 packument → 选候选 → 兼容性 | `up-to-date` / `update-available` / `incompatible-update` / `prerelease-only` / `network-error` / `check-failed` |
| `git` / `github` | 取已安装 commit（Bundle → version → profile lockfile）→ `git ls-remote` 比较 | `up-to-date` / `update-available`(availableCommit) / `no-source` / `needs-source` / `network-error` / `check-failed` |
| `local-link` / `local-path` | 不查询远端（由开发者负责） | `no-source` |
| `tarball` | 无法核对上游 | `needs-source` |
| `official` / `installation` / `self` | 随 DSH 更新 / 管理器不得自更新 | `no-source` |
| `unknown` | 来源不明确 | `needs-source` |

- 并发上限 4；每个网络查询 12s 超时；AbortSignal 透传（取消 → `check-failed`，绝不 `up-to-date`）。
- 未要求 refresh 且 `state.checks` 中存在 5 分钟内的“结论型”状态时直接复用。
- 缓存条目字段：`recordId/status/currentVersion/availableVersion/availableCommit/channel/compatibility/compatibilityRequirements/checkedAt/detail`。

### 8.3 npm 关键规则（`updates/npmClient.ts`）

- **registry 策略**：复刻 `@deepseek-ai/dsh-plugin-manager` 的 registryPlan——配置的首选 + fallbacks；`null` 表示 pnpm 自身配置；pnpm 自身 registry 只有在已知为公共源时才进入候选；私有/未知 registry 单独询问，**绝不回退公共源**；仅 `registry.npmjs.org` 与 `registry.npmmirror.com` 视为公共镜像并允许互回退。
- **传输**：无代理用全局 `fetch`；有 `HTTPS_PROXY`/`HTTP_PROXY` 时惰性加载 undici `ProxyAgent` 作为 dispatcher；`NO_PROXY`（含 `*`、域名后缀、端口）可跳过代理。
- **候选选择**：`dist-tags` 中解析稳定/预发布版本，始终只提议升级；稳定版更新优先；当前是稳定版且只有更新的预发布 → `prerelease-only`；当前是预发布时可沿预发布通道更新。
- **兼容性**：与 app-boot 的 `evaluatePluginCompatibility` 同语义：`engines.dsh` 存在则单独决定（忽略 peers）；否则检查所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peers；`workspace:^|~|*` 视为当前运行版本；范围匹配 `includePrerelease: true`；空/非法范围视为不满足；畸形字段/缺失 manifest → `unknown`（不当作兼容）。

### 8.4 git 关键规则（`updates/gitClient.ts`）

- 支持 spec：`github:/gitlab:/bitbucket:` 简写、`git+https/ssh`、`git://`、`git@host:owner/repo`、`https://host/owner/repo(/tree/<ref>/<subdir>)`、`owner/repo` 简写、`#<ref>`、`#semver:<range>`、`#path:<subdir>`。
- 已安装 commit：Bundle 信息 → `version.currentCommit` → Profile `pnpm-lock.yaml` resolution（v6 `/pkg@github.com/…/<sha>` 与 v9 `resolution:{commit,repo,type}`）；锁文件按 package name 匹配，带 mtime 缓存。
- 远端：`git ls-remote`（`GIT_TERMINAL_PROMPT=0` 防凭据交互），分支/tag 优先规则、annotated tag 取 peeled commit；`#semver:<range>` 列出 tags 后取满足范围的最高版本。
- 网络/超时/git 缺失/ref 不存在分别映射为 `network-error` / `check-failed`，不吞错。

### 8.5 技能检查（`updates/skillUpdates.ts`）

- 基线（expected tree）：用户确认来源的 baseline.tree → 锁文件 `skillFolderHash` → 本地 git 无法提供 tree 时视为无基线。
- 本地：`computeSkillFolderTreeSha`（git 对象算法，文本按 LF 规范化，最多 4000 文件）算当前 tree；同时用 git 工作区状态/锁文件哈希/基线判断本地修改。
- 远端：GitHub trees API（每个 repo+ref 一次递归树，按 subdir 取子树）→ `treeSha`；`local-modified` 优先于 `update-available`；无基线 → `check-failed`。
- 每次请求 12s、并发 4；403/429 且 `x-ratelimit-remaining: 0` → 明确限流文案（提示 `GITHUB_TOKEN`/`GH_TOKEN`），本次结果不会显示为“最新”；404 → 远端不存在；其余 HTTP 错误 → `check-failed`。
- **GitHub token 安全兜底**：`GITHUB_TOKEN`/`GH_TOKEN` 优先；未设置时进程内**惰性**执行一次 `gh auth token`（8s 超时）读取已登录 CLI 的 token，成功则用于提高限额，失败则静默回退匿名。token 只保存在内存，绝不写日志、不持久化、不出现在错误文本中。

## 9. 更新事务状态机（`updates/executor.ts`）

### 9.1 状态与迁移

`TRANSACTION_TRANSITIONS`（代码中为唯一权威）：

| 当前阶段 | 允许进入 |
| --- | --- |
| `PREFLIGHT` | `BACKUP` · `FAILED` · `RECOVERED` |
| `BACKUP` | `DOWNLOAD` · `FAILED` · `RECOVERED` |
| `DOWNLOAD` | `STAGE` · `FAILED` · `RECOVERED` |
| `STAGE` | `INSTALL` · `FAILED` · `RECOVERED` |
| `INSTALL` | `VALIDATE` · `FAILED` |
| `VALIDATE` | `PENDING_RESTART` · `VERIFIED` · `FAILED` |
| `PENDING_RESTART` | `VERIFIED` · `FAILED` · `RECOVERY` |
| `FAILED` | `RECOVERY` · `RECOVERED` |
| `RECOVERY` | `RECOVERED` · `RECOVERY_REQUIRED` |
| `VERIFIED` / `RECOVERED` / `RECOVERY_REQUIRED` | 终态 |

```
        ┌──────────┐   ┌────────┐   ┌──────────┐   ┌───────┐   ┌─────────┐   ┌────────┐
        │ PREFLIGHT│──►│ BACKUP │──►│ DOWNLOAD │──►│ STAGE │──►│ INSTALL │──►│VALIDATE│
        └────┬─────┘   └───┬────┘   └────┬─────┘   └───┬───┘   └────┬────┘   └───┬────┘
             │             │             │             │            │            │
             └─────────────┴─────────────┴─────────────┘            │      ┌─────┴──────────┐
                         失败进入 FAILED ◄──────────────────────────┘      │ PENDING_RESTART│
                              │                                            │     VERIFIED   │
                              ▼                                            └────────────────┘
                           RECOVERY ──成功──► RECOVERED
                              │
                              └──失败──► RECOVERY_REQUIRED（保留备份，人工处理）
```

- 每次阶段迁移与审计行都会立即 `putTransaction` 持久化；进程崩溃后事务停在非终态，由 `recover()` 对账。
- 事务记录包含 `steps[{at,phase,message,detail}]`、`backupDir`、`needsRestart`、`rolledBack`、`result`、`error`。

### 9.2 计划（plan，纯决策函数）

- `UpdateExecutor.plan(scope, ids?, workspace?)`：读两个 inventory + 检查缓存，逐记录调用 `planPluginEntry` / `planSkillEntry`；未指定 id 时“没有候选更新”的记录不进计划，显式指定时给出 `excludedReason`。`UpdatePlan.kind` 支持 `'plugins' | 'skills' | 'all'`（`all` 时每条 entry 自带 `kind`）。
- 计划条目语义（与执行器/路由一致）：
  - 硬排除 → 进 `excluded`，`eligible=false` + `excludedReason`；
  - 可自动执行 → 进 `entries`，`eligible=true`、`requiresConfirmation=false`；
  - **需要用户确认**（npm 本地被修改/本地状态无法比较、仅预发布、兼容性未知、Git 安装、技能本地修改）→ 进 `entries`，`eligible=false` + `requiresConfirmation=true`，并带 `risk`。
- 批量客户端（Web UI 的“更新全部”）只自动选择 `eligible && !requiresConfirmation` 的项；**单项计划**（`plan.entries.length===1`）中的 `requiresConfirmation` 项在用户确认后可由 `/update` 放行。

**插件计划排除规则**：管理器自身、`actions.canUpdate=false`、非 npm/Git 来源、检查状态不是候选（未检查/已最新/不兼容/来源不足）、兼容性 incompatible、缺少目标版本/Git commit、无法构造 Git 目标 spec。

**Git 安装计划**：`source.kind='git'` 且检查结果有 `availableCommit` → `targetVersion` 为短 commit、`eligible=false` + `requiresConfirmation=true`、risk 说明“按远端 commit 重新安装、安装脚本副作用无法完全回滚、更新前备份”。（已实现，隔离环境真实仓库更新与失败回滚均验收通过。）

**计划阶段的本地修改比较**：npm 候选在 plan 时按“当前版本 registry tarball vs 安装目录”逐文件哈希比较以识别本地修改；结果按 `PLAN_MODIFICATION_CACHE_TTL_MS = 60s`（最多 64 项）缓存，单次查询超时 8s，避免重复下载拖慢计划。

**技能计划排除规则**：非目录形态、`actions.canUpdate=false`、候选状态不符、缺少 `availableTree`、本地修改未确认（此时 `requiresConfirmation=true` 而非排除）。

### 9.3 插件更新执行（每项一个事务）

`preflight.mode` 由来源决定：npm 走完整下载/解包路径；Git 走“按 commit 重装 + lockfile 校验”路径。

**npm 模式：**

1. **PREFLIGHT**（不改动现场）
   - 拒绝：管理器自身、不可更新、非 npm、`npm:` 别名安装、缓存缺失/非候选/不兼容、目标版本非升级、存在未完成事务冲突、安装目录缺失/是符号链接/不可写、Profile 不可写、磁盘空间不足（2×目录 + 64 MiB）。
   - 重新查询 registry 确认目标版本仍存在，重新评估兼容性；下载 **当前版本** 的 registry tarball，逐文件 SHA-256 与安装目录比较，识别本地修改（忽略 `.DS_Store`/`Thumbs.db`/`desktop.ini`）。
   - 要求本地状态 clean，或用户已确认 `overwriteLocalModifications`。
2. **BACKUP**：`BackupManager.backupPlugin` 复制安装目录 + Profile 快照文件（`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.patch.yml`、`compatibility.json`），`verify()` 重新哈希并与清单对比，不通过则中止。
3. **DOWNLOAD**：下载目标 tarball（60s、≤192 MiB），解析 npm tarball，校验完整性。
4. **STAGE**：解包到 `staging/<txid>`，校验落地文件与 bundle 声明（不再触碰安装目录）。
5. **INSTALL**：`removeBundle(name)` → `installBundle(`${name}@${target}`, { saveExact: true, enabled: 原启用状态, registry })`。无 HMR 且 `removeBundle` 报 `stop-profile` 时退化为直接覆盖安装并记录“需要重启”。
6. **VALIDATE**：`listBundles()` 读回，比较版本、启用状态、availability=profile、无 error；任何不一致都视为失败并进入恢复。

**Git 模式（已实现，隔离环境验收通过）：**

1. **PREFLIGHT**：同上的通用检查；`buildGitTargetSpec(record, availableCommit)` 必须能构造 `origin#<commit>` 形式的安装 spec；Git 没有发布基线，本地修改视为 `unknown`，因此未传 `overwriteLocalModifications: true` 会 blocked；兼容性仍为 `unknown`（检查器不评估远端 `package.json`）。
2. **BACKUP**：与 npm 相同（安装目录 + Profile 快照）。
3. **DOWNLOAD / STAGE**：仅记录阶段（不预下载、不解包，由 pnpm 在安装时按 commit 拉取）。
4. **INSTALL**：`removeBundle` → `installBundle(<git origin#commit>, { saveExact, enabled, registry })`；安装脚本副作用无法由备份完全回滚，风险在计划里已标注。
5. **VALIDATE**：读回 `listBundles()` 校验启用状态，并读 `pnpm-lock.yaml` 确认实际提交与目标 commit 一致。

**两种模式共同的结果处理**：`application==='restart-required'` → `PENDING_RESTART`（记录 restartReason，页面提示等待重启）；否则 `VERIFIED`。写入更新历史、清理 staging；失败进入 `RECOVERY`（从备份恢复安装目录与 Profile 清单，Git 无法回滚安装脚本副作用）。

### 9.4 技能更新执行（每项一个事务）

1. **PREFLIGHT**：目录形态、可更新、技能目录在其发现根内（`resolveInside`）、来源可解析为 GitHub、来源已验证（association.verified 或 trust=verified）、子目录合法、缓存含 `availableTree`、无未完成事务、无符号链接、本地修改已确认、磁盘空间足够。
2. **BACKUP**：备份技能目录 → `backups/<txid>/skill` 并校验。
3. **DOWNLOAD**：下载 GitHub codeload 归档（60s、≤192 MiB），写入 staging。
4. **STAGE**：解包并复算技能子目录 git tree SHA，必须等于检查得到的 `availableTree`。
5. **INSTALL**：把旧目录移动到 `backups/<txid>/skill-old`，再移入新目录；移入失败立即移回。
6. **VALIDATE**：校验目标目录内容/来源；成功后删除备份侧旧目录、清检查缓存、推进用户确认来源的 baseline tree/commit（避免重复提示）。
7. 失败：从备份恢复（或把 `skill-old` 移回）；无法恢复 → `RECOVERY_REQUIRED` 并保留备份路径。

### 9.5 恢复（recover）

Host 启动时 `index.ts` 调用 `void updates.recover()`（不阻塞启动）：取 `state.openTransactions()`（非终态），逐个在全局写锁内：

- 插件：`PENDING_RESTART` → 读回版本/启用状态，正确则 `VERIFIED`，否则进入 `RECOVERY` 并尝试恢复；`INSTALL/VALIDATE/FAILED/RECOVERY` → 从备份恢复并校验；`PREFLIGHT/BACKUP/DOWNLOAD/STAGE` → 未触碰安装树，标记 `RECOVERED`（“未产生修改”）。
- 技能：替换前阶段直接 `RECOVERED`；替换中/后从备份或 `skill-old` 恢复。
- 恢复失败：`RECOVERY_REQUIRED`，事务记录 `result` 与备份路径，页面的更新历史会显示“需要恢复”。
- 清理与保留：`recover()` 结束时总会调用 `maintain()`（也可手动调用）：`BackupManager.pruneBackups({ keep: 20, protectedIds })` 保留最近 **20** 个事务的备份，属于未完成事务（`openTransactions()`）的备份永不删除，删除写 `updates.backup-pruned` 日志；`staging/` 下超过 **24 小时**的残留目录被删除（`updates.staging-cleaned`）。`maintain()` 在写锁内执行，不会打扰正在进行的更新；失败事务的备份保留。

## 10. HTTP API（`src/host/routes.ts`）

所有端点挂在 `/api/dsh-extension-manager` 下，JSON-only，不缓存（`cache-control: no-store`）。

**共同边界**

- 认证：`ctx.get('connection')` 存在时用 `connection.admit({ headers })`（与官方 `/api` 相同的浏览器信任围栏 + 签名 Cookie）；没有 connection 服务时退回 localhost/127.x/::1 Host 校验。失败 → 401 `authentication-required` 或 403 `forbidden-host`。
- 非 GET/HEAD 请求必须带 `x-dsh-extension-manager: 1`，否则 403 `forbidden-mutation`；请求体必须是 `application/json`（415 `content-type`），≤1 MiB（413），非空（400）。
- 错误统一为 `{ ok:false, error, code }`；未预期异常 500 `internal` 并写日志。

| Method | Path | 请求 | 响应 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/health` | — | `HealthResponse` | 存活探测（plugin/version/pid/now） |
| GET | `/environment` | — | `DiagnosticsResponse` | 与 `/diagnostics` 相同处理 |
| GET | `/diagnostics` | — | `DiagnosticsResponse` | 环境 + 目录探测 + 日志位置 |
| GET | `/plugins` | `?refresh=1` 可选 | `PluginInventoryPayload` | 插件清单（可强制重扫） |
| GET | `/skills` | `?refresh=1`、`?workspace=` 可选 | `SkillsInventoryPayload` | 技能清单；workspace 需已注册/当前 cwd/DSH home |
| GET | `/tasks` | — | `{ ok, tasks: TaskState[] }` | 最近任务（内存，最多 40） |
| GET | `/task/:id` | — | `{ ok, task?, pending?, error? }` | 不存在 → 404 `任务不存在或已过期` |
| GET | `/history` | — | `{ ok, entries: HistoryEntry[] }` | 最近 200 条更新历史 |
| POST | `/refresh` | `RefreshRequest` | `RefreshResponse` | 按 scope 重扫并返回 payload（**当前前端未使用**，UI 用 GET ?refresh=1） |
| POST | `/check` | `CheckRequest` | `{ ok, task }` | 创建后台检查任务；scope ∈ plugins/skills/all |
| POST | `/update-plan` | `UpdatePlanRequest` | `{ ok, plan }` | 只生成计划，不改动任何东西 |
| POST | `/update` | `UpdateRequest` | `{ ok, task, plan }` | `confirmed=true` 硬门槛；ids ≤100；同一时间只允许一个更新任务（同步 reservation，并发第二个请求返回 409 `update-busy`，验收中实测一个 200、一个 409）；后台执行。执行入选规则：`eligible=true` 的项，或 `requiresConfirmation=true` 且（`overwriteLocalModifications=true` 或本次计划只有 1 项）的项；其余跳过并写 `blocked` 历史。Web UI 的单项/重试确认弹窗已支持收集 `requiresConfirmation` 项与勾选确认。 |
| POST | `/skill-source` | `SkillSourceRequest` | `{ ok, record? }` | 技能→GitHub 来源关联；`skills.associateSource` 缺失时 501 |
| — | `/shutdown` | — | — | 未提供：`ENDPOINTS.shutdown` 常量存在，Host 未注册路由（访问 404） |

`/update` 的执行入选规则（Host 侧）：`entries` 中 `eligible=true` 的项，或 `requiresConfirmation=true` 且（用户传了 `overwriteLocalModifications` 或本次计划只有 1 项）的项；其余跳过并写 `blocked` 历史。没有可执行项 → 400 `no-eligible`。

## 11. 安全边界

1. **同源 + 浏览器信任围栏**：与官方 API 同一套 admission（Host/Origin 校验 + 签名 Cookie）；跨站页面拿不到合法 Cookie，也过不了 Host 校验。
2. **CSRF**：所有变更类请求要求自定义标记头 + JSON content-type——跨源页面无法在不触发 CORS 预检的情况下携带自定义头，而本服务从不回应 CORS 预检。
3. **输入最小化**：变更接口只接受 inventory id（server 侧解析为路径）、枚举 scope、布尔确认与已注册 workspace；**从不接受客户端提供的文件系统路径做写入**。
4. **路径安全**：技能替换前 `resolveInside(root, skillDir)` / 归档解包 `safeJoinInside`，拒绝路径穿越；拒绝符号链接目录/目录内部符号链接；安装目录必须真实存在、非符号链接、可写。
5. **内容校验**：npm tarball 按 SHA-256 与发布清单逐文件比较；GitHub 归档复算 git tree SHA 与检查结果一致才替换；备份复制后重哈希与 manifest 对比；恢复再次校验。
6. **操作可中断**：AbortSignal 贯穿检查/更新；安装阶段后的取消被标记“太晚”但仍完成校验，避免半替换。
7. **自保护**：`dsh-extension-manager` 永远不进入更新计划；DSH 管理组件/受保护 Bundle 由 `pluginManager` 的 `readOnlyReason`/`removable` 与计划规则排除；不重启 DSH。
8. **网络与凭据**：git 禁用终端凭据提示；代理仅通过环境变量；GitHub token 只从 `GITHUB_TOKEN`/`GH_TOKEN` 读取用于 API 请求；日志对 token/Bearer/URL userinfo/敏感字段脱敏。
9. **资源边界**：请求体 1 MiB；packument 32 MiB；tarball 下载 64 MiB（检查器）/192 MiB（执行器）；归档 192 MiB、256 MiB/200k 条目上限（tar 解析层）；并发 4；日志 1 MiB × 轮转。

## 12. 并发、单飞与缓存

| 机制 | 位置 | 行为 |
| --- | --- | --- |
| 检查单飞 | `UpdateCheckService.running` | 一个 Host 同时只跑一个检查任务；新请求直接返回运行中的任务 |
| 检查缓存 | `state.checks` + `CHECK_TTL_MS`(5 min) | 未要求 refresh 且缓存新鲜 → skipped，不访问上游 |
| 检查并发 | 两个 checker 各自 `CONCURRENCY = 4` | 限制同时网络请求数 |
| 写操作单飞 | `withInstallLock`（进程级 Promise 链） | 插件/技能更新同一时间只执行一个破坏性动作 |
| 更新任务单飞 | `routes.state.activeUpdateTask` + `UPDATE_STARTING` 预留 | 规划任何 await 之前同步占位，两个并发请求不会同时进入计划阶段；已有 queued/running 任务 → 409 `update-busy`（验收实测 200/409） |
| 计划串行 | `execute()` 逐项 for 循环 | 一个 plan 内逐项执行，失败项恢复后再继续下一项 |
| 状态写串行 | `ManagerState.flush` 队列 | 原子写（临时文件 + rename + `.bak`），并发写不交错 |
| 清单缓存 | `PluginInventoryImpl` / `SkillsInventoryImpl` 4s | 页面多次读取共享一次扫描；事件/更新后 invalidate |
| GitHub 缓存 | skill checker 单批 `defaultBranches` / `trees` | 同一 repo+ref 的递归树只请求一次 |
| 任务保留 | `TaskRegistry` 40 个 | 只保留内存中的最近任务（重启后丢失，事务与历史仍持久化） |
| 备份/暂存清理 | `UpdateExecutor.maintain()`（`recover()` 结束必调） | 保留最近 20 个事务备份；未完成事务的备份受保护；`staging/` 清理 24h 前残留；在写锁内执行 |

## 13. 可观测性

- **任务**：`TaskState.kind`（check/update/batch-update/refresh/source-associate/self-update）、items 状态、message/error、plan、transactionIds；页面任务面板可展开明细、重试失败项。
- **日志**：`$DSH_HOME/extension-manager/logs/manager.log`，JSON Line。常见事件：`host.start`、`host.ready`、`http.routes-registered`、`http.failed`、`check.completed`、`check.failed`、`skills.check.start`、`skills.check.completed`、`plugin-updates.checked`、`updates.*`、`backup.*`、`updates.recover.*`。日志带脱敏且失败不打断主流程。
- **诊断**：`/diagnostics` 返回环境事实、状态/日志/备份目录写探测、Host 声明的 limitations、技能 Provider 列表；页面把两个清单的 `Reconciliation` 逐来源展示（不完整时列出 id/label/error/location）。
- **清单完整性**：`Reconciliation.complete=false` 时页面顶部有醒目提示，并说明失败来源；`unexplained` 记录无法归因的运行时对象（例如没有 Bundle 归属的 Loader 行）。
- **更新历史**：`state.history`（最新 500 条）记录成功的更新（update/batch-update/skill-update）与失败/回滚/被阻止结果；`source-associate` 动作类型保留但当前来源关联不写历史。
- **验收**：20 项反向验收、隔离环境场景与弹窗布局回归见 [testing.md](testing.md)。

## 14. 可维护性与扩展点

- **契约先行**：`src/host/contracts.ts` 定义模块边界，`src/shared/types.ts` / `src/shared/api.ts` 定义跨进程数据结构；Host/Client 共享类型避免协议漂移。
- **纯函数优先**：候选选择、兼容性、registry 策略、git spec/lockfile 解析、计划决策（`planPluginEntry`/`planSkillEntry`）、状态迁移表都是可单测的纯函数；执行器的网络与归档下载是可注入端口，测试不需要真实 HTTP。
- **测试映射**：
  - `test/plugin-updates.test.ts` → registry 策略/候选/兼容性/spec/lockfile/代理；
  - `test/skills.test.ts` → frontmatter/根解析/git tree/锁文件/覆盖关系；
  - `test/updater.test.ts` → 事务状态机/备份/归档/Windows 替换/回滚/崩溃恢复/串行队列；
  - `node --test` 一次运行全部（98 用例，`npm test` 实测 98/98 通过）。
- **新增来源类型的步骤**：`SourceKind`/`SourceTrust`（shared）→ `env.classifyDependencySpec` 或 `skills.buildSource` 分类 → 检查器分派（`pluginUpdates`/`skillUpdates`）→ 客户端 `model.ts` 的 `SOURCE_KIND_LABELS`/`SOURCE_GROUPS`。
- **新增状态**：`UpdateStatus`（shared）→ 检查器产出 → `model.ts` 状态视图与筛选 → 计划/执行器规则（如可作为候选）。
- **新增接口**：`shared/api.ts` 加端点常量与 body 类型 → `routes.ts` 实现 → `client/api.ts` transport → 页面调用。
- **代码风格**：严格 TypeScript（`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`）；代码注释英文、用户可见文案中文；不用第三方运行时库（Host 仅 `semver`/`yaml`/`undici` + Node 内置）；client 只用 DSH primitives/slots。

### 当前未提供 / 已知边界（v0.1.0）

以下不是“待修复缺陷”，而是当前版本已确认的范围；其中内部接口整理项对用户无影响：

- 管理器自身不支持页面内自更新；也从不重启 DSH。
- 随 DSH 安装提供的组件只读，随 DSH 发行版更新；其他 Profile 只读（已用 `alt` Profile 验收，同名物理安装不重复计数）。
- Skills 无逐技能启停；自动更新仅支持 GitHub 来源与目录形态技能（拒绝平铺单文件与含符号链接目录）。
- Git 安装 Bundle 按 commit 重装，安装脚本副作用无法完全回滚；必须单项确认。
- 网络失败/限流不自动重试；不显示为“已最新”。
- 计划阶段 npm 本地修改比较最坏多等数秒（60 秒缓存）。
- pnpm 构建脚本授权沿用 Profile 设置，管理器不绕过。
- 当前版本没有“取消正在进行的更新”按钮；失败后可重试。
- 官方 GitHub Release changelog 展示未实现。
- 更新历史不记录 `source-associate`；技能来源关联目前仅 Host API `POST /skill-source`，页面入口未提供。
- 内部整理项：`/shutdown` 端点常量存在但未接路由；`POST /refresh` 已实现但前端未使用（UI 用 GET `?refresh=1`）。
- 验收环境为 Windows；POSIX 分支未实测。
- 文档与代码需随接口演进同步。
