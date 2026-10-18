/**
 * Preview fixture for the Extension Manager page.
 *
 * Loaded only when the page URL carries `?emFixture=1`; the default path never
 * touches this module's data (the transport factory in api.ts picks the HTTP
 * transport otherwise). The page renders a persistent "预览数据" banner so a
 * screenshot can never be mistaken for real machine state.
 *
 * The fixture also simulates check/update tasks and mutates its sample records
 * so every UI state (checking, progress, pending-restart, failure) is
 * reachable without a Host.
 */
import type {
  CheckRequest,
  DiagnosticsResponse,
  HealthResponse,
  RefreshRequest,
  RefreshResponse,
  TaskResponse,
  UpdatePlanRequest,
  UpdateResponse,
} from '../shared/api'
import type {
  AnySkillRecord,
  Diagnostic,
  HistoryEntry,
  LocalModificationInfo,
  PluginBundleRecord,
  PluginInventoryPayload,
  PluginRowRecord,
  PluginRowSummary,
  PluginStats,
  Reconciliation,
  RecordActions,
  SkillsInventoryPayload,
  SkillStats,
  SourceInfo,
  TaskState,
  UpdatePlan,
  UpdatePlanEntry,
  UpdateStatus,
  VersionInfo,
} from '../shared/types'
import type { TaskPollOptions, Transport } from './api'
import { deriveSignals } from './model'

const PROFILE_DIR = 'C:\\Users\\demo\\.dsh\\profiles\\web'
const DSH_HOME = 'C:\\Users\\demo\\.dsh'
const WORKSPACE = 'C:\\Users\\demo\\projects\\dsh-workspace'
const STATE_DIR = `${DSH_HOME}\\extension-manager`
const SKILLS_ROOT = `${DSH_HOME}\\skills`

const KEYWORDS = {
  self: 'dsh-extension-manager',
  official: '@deepseek-ai/dsh-plugin-manager',
  webserver: '@deepseek-ai/dsh-host-webserver',
  chat: '@deepseek-ai/dsh-client-ui-chat',
  skillsManager: '@michengai/dsh-skills-manager',
  session: '@linxin666/dsh-session-manager',
  memory: '@dsh-tools/memory',
  local: 'local-notes-plugin',
  faulty: '@faulty/registry-plugin',
  skillGit: 'write-refine-skills',
  skillLock: 'agent-reach',
  skillOfficial: 'pdf',
  project: 'my-project-helper',
  shadow: 'write-refine-skills',
  codex: 'code-review',
  custom: 'legacy-notes',
  broken: 'broken-skill',
  virtual: 'delegate',
} as const

/** ISO timestamp `minutesAgo` minutes in the past. */
function iso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

const CLEAN: LocalModificationInfo = { state: 'clean' }
const UNKNOWN_MODIFICATION: LocalModificationInfo = { state: 'unknown' }

const NO_REMOTE: RecordActions = {
  canCheck: false,
  canUpdate: false,
  updateBlockedReason: '本地安装没有可比较的远程来源，扩展管理器无法检查或更新',
}
const OFFICIAL_ONLY: RecordActions = {
  canCheck: true,
  canUpdate: false,
  updateBlockedReason: '官方插件随 DSH 版本发布，扩展管理器不会单独覆盖安装',
}
const UPDATABLE: RecordActions = { canCheck: true, canUpdate: true }

/** Runtime block defaults for an installed, enabled, loaded bundle. */
function loadedRuntime(extra: Partial<PluginBundleRecord['runtime']> = {}): PluginBundleRecord['runtime'] {
  return { installed: true, enabled: true, loaded: true, fiberPhase: 'active', ...extra }
}

/** One plugin row contributed by a bundle. */
function contributedRow(entryId: string, moduleName: string, displayName: string, overrides = false): PluginRowSummary {
  return {
    entryId,
    moduleName,
    displayName,
    enabled: true,
    loaded: true,
    fiberPhase: 'active',
    ...(overrides ? { overrides: true } : {}),
  }
}

const BUNDLE_ROWS: PluginRowSummary[] = [
  contributedRow('extension-manager', KEYWORDS.self, '扩展管理器'),
  contributedRow('plugin-manager', KEYWORDS.official, '插件管理器'),
  contributedRow('web-server', KEYWORDS.webserver, 'Host Web 服务'),
  contributedRow('ui-chat', KEYWORDS.chat, '聊天界面'),
  contributedRow('skills-manager', KEYWORDS.skillsManager, 'Skills 管理器'),
  contributedRow('session-manager', KEYWORDS.session, '会话管理器'),
  contributedRow('memory', KEYWORDS.memory, '长期记忆'),
  contributedRow('local-notes', KEYWORDS.local, '本地笔记'),
  contributedRow('registry-plugin', KEYWORDS.faulty, 'Registry 插件'),
]

/** Sample plugin bundles (all current-profile unless noted). */
function makeBundles(): PluginBundleRecord[] {
  return [
    {
      id: 'bundle:dsh-extension-manager',
      kind: 'plugin-bundle',
      name: KEYWORDS.self,
      displayName: '扩展管理器',
      description: '统一查看、检查并安全更新本机安装的 Plugins 与 Skills。',
      version: { current: '0.1.0', status: 'no-source', reason: '本地 link 安装，没有可比较的远程版本', lastCheckedAt: iso(12) },
      source: {
        kind: 'local-link',
        trust: 'local-custom',
        label: `本地链接 · ${WORKSPACE}`,
        spec: `link:${WORKSPACE}\\dsh-extension-manager`,
        packageName: KEYWORDS.self,
      },
      runtime: loadedRuntime(),
      scope: 'current-profile',
      profile: 'web',
      official: false,
      availability: 'profile',
      removable: true,
      self: true,
      paths: {
        installDir: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.self}`,
        manifestPath: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.self}\\package.json`,
        resolvedPath: `${WORKSPACE}\\dsh-extension-manager`,
      },
      rows: [BUNDLE_ROWS[0] as PluginRowSummary],
      overrides: [],
      localModification: CLEAN,
      diagnostics: [],
      actions: NO_REMOTE,
    },
    {
      id: `bundle:${KEYWORDS.official}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.official,
      displayName: '插件管理器',
      description: 'DSH 官方插件市场与安装、启用管理页面。',
      version: { current: '0.2.1-rc.2', status: 'up-to-date', lastCheckedAt: iso(12), channel: 'stable' },
      source: {
        kind: 'official',
        trust: 'official',
        label: 'DSH 官方内置',
        packageName: KEYWORDS.official,
        registry: 'https://registry.npmmirror.com',
      },
      runtime: loadedRuntime(),
      scope: 'current-profile',
      profile: 'web',
      official: true,
      availability: 'installation',
      removable: false,
      paths: {
        installDir: `C:\\Users\\123\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\${KEYWORDS.official}`,
        manifestPath: `C:\\Users\\123\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\${KEYWORDS.official}\\package.json`,
      },
      rows: [BUNDLE_ROWS[1] as PluginRowSummary],
      overrides: [],
      localModification: CLEAN,
      diagnostics: [],
      actions: OFFICIAL_ONLY,
    },
    {
      id: `bundle:${KEYWORDS.webserver}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.webserver,
      displayName: 'Host Web 服务',
      description: '为 Web GUI 提供同源 HTTP 服务与静态资源。',
      version: {
        current: '0.2.1-rc.2',
        available: '0.2.2',
        status: 'update-available',
        channel: 'stable',
        compatibility: 'compatible',
        lastCheckedAt: iso(12),
        reason: 'registry 上有更新的稳定版本，且兼容当前 DSH',
      },
      source: {
        kind: 'npm',
        trust: 'verified',
        label: 'npm registry',
        packageName: KEYWORDS.webserver,
        registry: 'https://registry.npmmirror.com',
        spec: `${KEYWORDS.webserver}@0.2.1-rc.2`,
      },
      runtime: loadedRuntime(),
      scope: 'current-profile',
      profile: 'web',
      official: false,
      availability: 'profile',
      removable: true,
      paths: {
        installDir: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.webserver}`,
        manifestPath: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.webserver}\\package.json`,
      },
      rows: [BUNDLE_ROWS[2] as PluginRowSummary],
      overrides: [],
      localModification: CLEAN,
      diagnostics: [],
      actions: UPDATABLE,
    },
    {
      id: `bundle:${KEYWORDS.chat}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.chat,
      displayName: '聊天界面',
      description: '会话消息、Markdown 渲染与输入框。',
      version: { current: '0.2.1-rc.2', status: 'up-to-date', lastCheckedAt: iso(12) },
      source: { kind: 'bundled', trust: 'official', label: '随 DSH 打包', packageName: KEYWORDS.chat },
      runtime: loadedRuntime(),
      scope: 'current-profile',
      profile: 'web',
      official: true,
      availability: 'installation',
      removable: false,
      paths: {
        installDir: `C:\\Users\\123\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\${KEYWORDS.chat}`,
        manifestPath: `C:\\Users\\123\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\${KEYWORDS.chat}\\package.json`,
      },
      rows: [BUNDLE_ROWS[3] as PluginRowSummary],
      overrides: [],
      localModification: CLEAN,
      diagnostics: [],
      actions: OFFICIAL_ONLY,
    },
    {
      id: `bundle:${KEYWORDS.skillsManager}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.skillsManager,
      displayName: 'Skills 管理器',
      description: '第三方技能管理页面（视觉参考来源）。',
      version: { current: '1.2.0', status: 'no-source', reason: '本地 link 安装，没有远程来源', lastCheckedAt: iso(30) },
      source: {
        kind: 'local-link',
        trust: 'local-custom',
        label: '本地链接 · dsh-skills-manager',
        spec: 'link:..\\dsh-skills-manager',
        packageName: KEYWORDS.skillsManager,
      },
      runtime: loadedRuntime(),
      scope: 'current-profile',
      profile: 'web',
      official: false,
      availability: 'profile',
      removable: true,
      paths: {
        installDir: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.skillsManager}`,
        manifestPath: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.skillsManager}\\package.json`,
        resolvedPath: 'C:\\Users\\123\\Desktop\\workspace\\dsh-skills-manager',
      },
      rows: [BUNDLE_ROWS[4] as PluginRowSummary],
      overrides: [],
      localModification: { state: 'modified', files: ['lib/client.js'], detail: '本地构建产物与来源不一致' },
      diagnostics: [
        { level: 'warning', code: 'local-modification', message: '检测到本地修改；更新前需要确认是否覆盖。' },
      ],
      actions: NO_REMOTE,
    },
    {
      id: `bundle:${KEYWORDS.session}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.session,
      displayName: '会话管理器',
      description: '会话归档、恢复与跨窗口同步。',
      version: {
        current: '1.4.0',
        available: '2.0.0',
        status: 'incompatible-update',
        channel: 'stable',
        compatibility: 'incompatible',
        compatibilityRequirements: { dsh: '^0.3.0', node: '>=22.0.0' },
        lastCheckedAt: iso(12),
        reason: '新版本要求 DSH ^0.3.0，当前运行版本不满足',
      },
      source: {
        kind: 'npm',
        trust: 'verified',
        label: 'npm registry',
        packageName: KEYWORDS.session,
        registry: 'https://registry.npmmirror.com',
      },
      runtime: loadedRuntime({ enabled: false, loaded: false, fiberPhase: 'pending' }),
      scope: 'current-profile',
      profile: 'web',
      official: false,
      availability: 'profile',
      removable: true,
      paths: {
        installDir: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.session}`,
        manifestPath: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.session}\\package.json`,
      },
      rows: [BUNDLE_ROWS[5] as PluginRowSummary],
      overrides: [],
      localModification: CLEAN,
      diagnostics: [
        {
          level: 'warning',
          code: 'runtime-requirement',
          message: '候选版本声明 dsh ^0.3.0，当前 0.2.1-rc.2 不满足，因此不提供自动更新。',
        },
      ],
      actions: {
        canCheck: true,
        canUpdate: false,
        updateBlockedReason: '新版本要求 DSH ^0.3.0，当前运行版本不满足',
      },
    },
    {
      id: `bundle:${KEYWORDS.memory}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.memory,
      displayName: '长期记忆',
      description: '跨会话的长期记忆与检索。',
      version: {
        current: '0.3.0',
        available: '0.3.1',
        status: 'update-available',
        channel: 'stable',
        compatibility: 'compatible',
        lastCheckedAt: iso(12),
        reason: 'GitHub 仓库有新提交，兼容当前 DSH',
      },
      source: {
        kind: 'github',
        trust: 'verified',
        label: 'GitHub · dsh-tools/memory',
        url: 'https://github.com/dsh-tools/memory',
        repo: 'dsh-tools/memory',
        ref: 'main',
        commit: '4f2c9a1d7e3b',
        packageName: KEYWORDS.memory,
      },
      runtime: loadedRuntime(),
      scope: 'current-profile',
      profile: 'web',
      official: false,
      availability: 'profile',
      removable: true,
      paths: {
        installDir: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.memory}`,
        manifestPath: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.memory}\\package.json`,
      },
      rows: [BUNDLE_ROWS[6] as PluginRowSummary],
      overrides: [],
      localModification: { state: 'modified', files: ['dist/index.js'], detail: '本地构建覆盖了随包发布的 dist 产物' },
      diagnostics: [
        { level: 'warning', code: 'local-modification', message: '检测到本地修改；更新会先备份再覆盖，需要明确确认。' },
      ],
      actions: { canCheck: true, canUpdate: true, requiresConfirmation: true },
    },
    {
      id: `bundle:${KEYWORDS.local}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.local,
      displayName: '本地笔记',
      description: '本地目录里的 Markdown 笔记插件。',
      version: { current: '0.0.3', status: 'needs-source', reason: '本地路径安装没有远程来源；如需更新请先关联来源' },
      source: {
        kind: 'local-path',
        trust: 'unknown',
        label: '本地路径 · D:\\dev\\local-notes-plugin',
        packageName: KEYWORDS.local,
      },
      runtime: loadedRuntime(),
      scope: 'current-profile',
      profile: 'web',
      official: false,
      availability: 'profile',
      removable: true,
      paths: {
        installDir: 'D:\\dev\\local-notes-plugin',
        manifestPath: 'D:\\dev\\local-notes-plugin\\package.json',
      },
      rows: [BUNDLE_ROWS[7] as PluginRowSummary],
      overrides: [],
      localModification: { state: 'unknown' },
      diagnostics: [
        { level: 'warning', code: 'missing-source', message: '没有记录远程来源，无法检查更新。' },
      ],
      actions: NO_REMOTE,
    },
    {
      id: `bundle:${KEYWORDS.faulty}`,
      kind: 'plugin-bundle',
      name: KEYWORDS.faulty,
      displayName: 'Registry 插件',
      description: '演示一次失败更新检查的插件包。',
      version: {
        current: '2.1.0',
        status: 'check-failed',
        lastCheckedAt: iso(12),
        reason: 'registry 请求超时（ETIMEDOUT），本次检查未得到结论',
      },
      source: {
        kind: 'npm',
        trust: 'needs-confirmation',
        label: 'npm registry',
        packageName: KEYWORDS.faulty,
        registry: 'https://registry.npmmirror.com',
        detail: 'registry 返回了非官方来源的签名，需要确认后才可更新',
      },
      runtime: loadedRuntime({ fiberPhase: 'active' }),
      scope: 'current-profile',
      profile: 'web',
      official: false,
      availability: 'profile',
      removable: true,
      paths: {
        installDir: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.faulty}`,
        manifestPath: `${PROFILE_DIR}\\node_modules\\${KEYWORDS.faulty}\\package.json`,
      },
      rows: [BUNDLE_ROWS[8] as PluginRowSummary],
      overrides: [],
      localModification: CLEAN,
      diagnostics: [
        { level: 'error', code: 'check-timeout', message: '检查更新失败：registry 请求超时。', detail: { url: 'https://registry.npmmirror.com/@faulty%2fregistry-plugin', timeoutMs: 15000 } },
      ],
      actions: {
        canCheck: true,
        canUpdate: false,
        updateBlockedReason: '上次检查失败，请重试检查后再更新',
      },
    },
  ]
}

/** Standalone plugin rows observed in the runtime (no bundle attribution). */
function makePluginRows(): PluginRowRecord[] {
  return [
    {
      id: 'plugin-row:cordis:plugin-loader',
      kind: 'plugin-row',
      name: 'cordis:plugin-loader',
      displayName: '插件加载器',
      description: 'Loader 内置的插件加载与依赖解析行。',
      version: { current: '0.2.1-rc.2', status: 'no-source', reason: 'Loader 内置行随 DSH 版本发布，不能单独更新' },
      source: { kind: 'official', trust: 'official', label: 'DSH 官方内置', packageName: 'cordis-plugin-loader' },
      runtime: { installed: true, enabled: true, loaded: true, fiberPhase: 'active' },
      scope: 'current-profile',
      profile: 'web',
      paths: {},
      row: {
        entryId: 'cordis:plugin-loader',
        moduleName: 'cordis-plugin-loader',
        displayName: '插件加载器',
        description: 'Loader 内置的插件加载与依赖解析行。',
        enabled: true,
        loaded: true,
        fiberPhase: 'active',
        readOnlyReason: '由 DSH 安装目录提供，只读',
      },
      localModification: UNKNOWN_MODIFICATION,
      diagnostics: [],
      actions: {
        canCheck: false,
        canUpdate: false,
        updateBlockedReason: 'Loader 内置行随 DSH 版本发布，不能单独更新',
      },
    },
    {
      id: 'plugin-row:preset:browser-tools',
      kind: 'plugin-row',
      name: 'preset:browser-tools',
      displayName: '浏览器工具（Preset）',
      description: '由 Agent preset 提供的浏览器操作工具行。',
      version: { current: '0.2.1-rc.2', status: 'up-to-date', lastCheckedAt: iso(12) },
      source: { kind: 'bundled', trust: 'official', label: '随 DSH 打包', packageName: '@deepseek-ai/dsh-tool-browser' },
      runtime: { installed: true, enabled: true, loaded: true, fiberPhase: 'active' },
      scope: 'current-profile',
      profile: 'web',
      paths: {},
      row: {
        entryId: 'preset:browser-tools',
        rowId: 'browser-tools',
        moduleName: '@deepseek-ai/dsh-tool-browser',
        displayName: '浏览器工具（Preset）',
        description: '由 Agent preset 提供的浏览器操作工具行。',
        enabled: true,
        loaded: true,
        fiberPhase: 'active',
        overrides: true,
        readOnlyReason: '由 Agent preset 提供，只读',
      },
      localModification: UNKNOWN_MODIFICATION,
      diagnostics: [],
      actions: {
        canCheck: false,
        canUpdate: false,
        updateBlockedReason: 'Preset 行由 Agent preset 管理，不能单独更新',
      },
    },
  ]
}

const MANAGED_ROOTS = new Set(['user-dsh', 'user-agents', 'project-dsh'])
const UNMANAGED_ROOTS = new Set(['custom:team-skills', 'codex'])

/** Sample skill roots. */
const SKILL_ROOTS: SkillsInventoryPayload['roots'] = [
  { key: 'project-dsh', label: '工作区 .dsh/skills', path: `${WORKSPACE}\\.dsh\\skills`, rank: 5, managed: true, exists: true, complete: true, count: 1 },
  { key: 'user-dsh', label: '用户 DSH 技能目录', path: SKILLS_ROOT, rank: 10, managed: true, exists: true, complete: true, count: 4 },
  { key: 'user-agents', label: '~/.agents/skills', path: 'C:\\Users\\123\\.agents\\skills', rank: 20, managed: true, exists: true, complete: true, count: 1 },
  { key: 'custom:team-skills', label: '团队技能目录', path: 'D:\\TeamSkills', rank: 30, managed: false, exists: true, complete: true, count: 1 },
  { key: 'codex', label: 'Codex 兼容目录', path: 'C:\\Users\\123\\.codex\\skills', rank: 40, managed: false, exists: true, complete: false, count: 1, error: '目录读取超时（预览示例）' },
]

/** One physical skill copy. */
function skillCopy(input: {
  id: string
  name: string
  displayName: string
  description: string
  version: VersionInfo
  source: SourceInfo
  rootKey: string
  rootRank: number
  effective: boolean
  installDir: string
  shadowedBy?: string
  overriddenCopies?: SkillRecordLike['overriddenCopies']
  diagnostics?: Diagnostic[]
  invocation?: { model: boolean; user: boolean }
  runtime?: AnySkillRecord['runtime']
  actions?: RecordActions
}): AnySkillRecord {
  return {
    id: input.id,
    kind: 'skill',
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    version: input.version,
    source: input.source,
    runtime: input.runtime ?? { installed: true, enabled: true, loaded: input.effective },
    scope: 'filesystem',
    rootKey: input.rootKey,
    rootRank: input.rootRank,
    layout: 'directory',
    paths: {
      installDir: input.installDir,
      manifestPath: `${input.installDir}\\SKILL.md`,
      rootDir: input.rootKey === 'project-dsh' ? `${WORKSPACE}\\.dsh\\skills` : input.rootKey === 'user-dsh' ? SKILLS_ROOT : input.rootKey === 'user-agents' ? 'C:\\Users\\123\\.agents\\skills' : input.rootKey === 'codex' ? 'C:\\Users\\123\\.codex\\skills' : 'D:\\TeamSkills',
    },
    effective: input.effective,
    ...(input.shadowedBy === undefined ? {} : { shadowedBy: input.shadowedBy }),
    ...(input.overriddenCopies === undefined ? {} : { overriddenCopies: input.overriddenCopies }),
    ...(input.invocation === undefined ? {} : { invocation: input.invocation }),
    provider: 'filesystem',
    localModification: CLEAN,
    diagnostics: input.diagnostics ?? [],
    actions: input.actions ?? NO_REMOTE,
  }
}

type SkillRecordLike = import('../shared/types').SkillRecord

/** Sample physical skill copies. */
function makeSkills(): AnySkillRecord[] {
  return [
    skillCopy({
      id: 'skill:project-dsh:my-project-helper',
      name: 'my-project-helper',
      displayName: '项目助手',
      description: '当前工作区专属的构建与验证流程说明。',
      version: { current: '0.1.0', status: 'needs-source', reason: '工作区技能没有远程来源' },
      source: { kind: 'filesystem', trust: 'unknown', label: '工作区 .dsh/skills' },
      rootKey: 'project-dsh',
      rootRank: 5,
      effective: true,
      installDir: `${WORKSPACE}\\.dsh\\skills\\my-project-helper`,
      invocation: { model: true, user: true },
    }),
    skillCopy({
      id: 'skill:user-dsh:write-refine-skills',
      name: KEYWORDS.skillGit,
      displayName: 'Write · Refine · Skills',
      description: '把零散想法写成清晰任务、精炼执行并沉淀为可复用技能的完整工作流。',
      version: {
        current: '1.8.0',
        currentTree: 'a1b2c3d4e5f60718',
        availableTree: '9f8e7d6c5b4a3210',
        available: '1.9.0',
        status: 'update-available',
        channel: 'tag',
        compatibility: 'compatible',
        lastCheckedAt: iso(12),
        reason: '上游仓库有新的标签 v1.9.0，技能树不同',
      },
      source: {
        kind: 'skill-git',
        trust: 'verified',
        label: 'GitHub · example/write-refine-skills',
        url: 'https://github.com/example/write-refine-skills',
        repo: 'example/write-refine-skills',
        ref: 'v1.8.0',
        commit: 'a1b2c3d4e5f60718',
        subdir: 'skills/write-refine-skills',
      },
      rootKey: 'user-dsh',
      rootRank: 10,
      effective: true,
      installDir: `${SKILLS_ROOT}\\${KEYWORDS.skillGit}`,
      invocation: { model: true, user: true },
      actions: UPDATABLE,
    }),
    skillCopy({
      id: 'skill:user-dsh:agent-reach',
      name: KEYWORDS.skillLock,
      displayName: 'Agent Reach',
      description: '通过 CLI 检索 15 个平台的内容并汇总引用。',
      version: { current: '2.2.0', status: 'up-to-date', lastCheckedAt: iso(12), channel: 'stable' },
      source: {
        kind: 'skill-lock',
        trust: 'verified',
        label: '技能锁文件 · agent-reach@2.2.0',
        url: 'https://github.com/example/agent-reach',
        repo: 'example/agent-reach',
        commit: '5c6d7e8f9a0b1c2d',
      },
      rootKey: 'user-dsh',
      rootRank: 10,
      effective: true,
      installDir: `${SKILLS_ROOT}\\${KEYWORDS.skillLock}`,
      invocation: { model: true, user: false },
    }),
    skillCopy({
      id: 'skill:user-dsh:pdf',
      name: KEYWORDS.skillOfficial,
      displayName: 'PDF 工具',
      description: '读取、编辑与生成 PDF 文档。',
      version: { current: '0.2.1-rc.2', status: 'up-to-date', lastCheckedAt: iso(12) },
      source: { kind: 'official', trust: 'official', label: '官方技能包', packageName: '@deepseek-ai/skill-pdf' },
      rootKey: 'user-dsh',
      rootRank: 10,
      effective: true,
      installDir: `${SKILLS_ROOT}\\${KEYWORDS.skillOfficial}`,
      invocation: { model: true, user: true },
    }),
    skillCopy({
      id: 'skill:user-agents:write-refine-skills',
      name: KEYWORDS.shadow,
      displayName: 'Write · Refine · Skills（旧副本）',
      description: '同一技能的旧副本，被用户 DSH 目录的同名副本覆盖。',
      version: { current: '1.6.0', currentTree: '1122334455667788', status: 'up-to-date', lastCheckedAt: iso(12) },
      source: { kind: 'skill-git', trust: 'verified', label: 'GitHub · 旧副本' },
      rootKey: 'user-agents',
      rootRank: 20,
      effective: false,
      installDir: 'C:\\Users\\123\\.agents\\skills\\write-refine-skills',
      shadowedBy: `${SKILLS_ROOT}\\${KEYWORDS.skillGit}`,
      overriddenCopies: [{ rootKey: 'user-dsh', path: `${SKILLS_ROOT}\\${KEYWORDS.skillGit}` }],
      runtime: { installed: true, enabled: true, loaded: false },
      diagnostics: [
        { level: 'info', code: 'shadowed-copy', message: '被优先级更高的同名副本覆盖，运行时不会使用这一份。' },
      ],
    }),
    skillCopy({
      id: 'skill:user-dsh:broken-skill',
      name: KEYWORDS.broken,
      displayName: '损坏的技能',
      description: '演示解析失败的技能目录（缺少 name 字段）。',
      version: { current: '0.0.0', status: 'check-failed', lastCheckedAt: iso(12), reason: 'SKILL.md frontmatter 解析失败' },
      source: { kind: 'filesystem', trust: 'unknown', label: '文件系统扫描' },
      rootKey: 'user-dsh',
      rootRank: 10,
      effective: false,
      installDir: `${SKILLS_ROOT}\\${KEYWORDS.broken}`,
      runtime: { installed: true, enabled: false, loaded: false, error: 'frontmatter 缺少 name 字段', catalogIncomplete: true },
      diagnostics: [
        { level: 'error', code: 'invalid-frontmatter', message: 'SKILL.md frontmatter 缺少 name 字段，技能未进入运行时目录。' },
      ],
    }),
    skillCopy({
      id: 'skill:codex:code-review',
      name: KEYWORDS.codex,
      displayName: '代码审查',
      description: 'Codex 兼容目录中的代码审查技能，当前 DSH 未启用该根目录。',
      version: { current: '1.0.0', status: 'no-source', reason: '未托管的根目录没有登记来源' },
      source: { kind: 'filesystem', trust: 'unknown', label: 'Codex 兼容目录' },
      rootKey: 'codex',
      rootRank: 40,
      effective: false,
      installDir: 'C:\\Users\\123\\.codex\\skills\\code-review',
      runtime: { installed: true, enabled: false, loaded: false },
      diagnostics: [
        { level: 'info', code: 'unmanaged-root', message: '该根目录未被运行中的 DSH 技能 Provider 扫描。' },
      ],
    }),
    skillCopy({
      id: 'skill:custom:team-skills:legacy-notes',
      name: KEYWORDS.custom,
      displayName: '团队笔记规范',
      description: '团队自定义技能目录中的笔记规范（未托管）。',
      version: { current: '0.4.2', status: 'needs-source', reason: '团队目录没有远程来源' },
      source: { kind: 'filesystem', trust: 'local-custom', label: '团队技能目录' },
      rootKey: 'custom:team-skills',
      rootRank: 30,
      effective: false,
      installDir: 'D:\\TeamSkills\\legacy-notes',
      runtime: { installed: true, enabled: false, loaded: false },
    }),
    {
      id: 'skill:virtual:delegate',
      kind: 'skill',
      name: KEYWORDS.virtual,
      displayName: 'Delegate（运行时技能）',
      description: '由 DSH 内置 Provider 提供的运行时技能，没有物理目录。',
      version: { current: '0.2.1-rc.2', status: 'no-source', reason: '运行时提供的技能随 DSH 版本发布' },
      source: { kind: 'bundled', trust: 'official', label: 'DSH 内置 Provider' },
      runtime: { installed: true, enabled: true, loaded: true },
      scope: 'filesystem',
      rootKey: 'builtin',
      layout: 'virtual',
      paths: {},
      provider: 'builtin',
      effective: true,
      invocation: { model: true, user: false },
      localModification: UNKNOWN_MODIFICATION,
      diagnostics: [],
      actions: {
        canCheck: false,
        canUpdate: false,
        updateBlockedReason: '运行时提供的技能随 DSH 版本发布，不能单独更新',
      },
    },
  ]
}

/** Reconciliation blocks for both preview inventories. */
function pluginReconciliation(): Reconciliation {
  return {
    complete: true,
    scannedAt: iso(0),
    durationMs: 184,
    sources: [
      { id: 'profile-manifests', label: 'Profile 声明', contributes: 'bundles', count: 9, complete: true, location: `${PROFILE_DIR}\\package.json` },
      { id: 'installation', label: 'DSH 安装目录', contributes: 'bundles', count: 3, complete: true, location: 'C:\\Users\\123\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh' },
      { id: 'loader-rows', label: 'Loader 运行时行', contributes: 'rows', count: 11, complete: true, location: '(runtime)' },
      { id: 'registry-check', label: 'npm registry', contributes: 'registry', count: 3, complete: true },
    ],
    counts: { bundles: 9, rows: 11, official: 3 },
    unexplained: [],
    notes: ['其他 Profile 中的 2 个插件包为只读参考。'],
  }
}

function skillReconciliation(): Reconciliation {
  return {
    complete: false,
    scannedAt: iso(0),
    durationMs: 96,
    sources: [
      { id: 'skill-fs', label: '文件系统技能扫描', contributes: 'skills-physical', count: 8, complete: true },
      { id: 'skill-runtime', label: '运行时技能目录', contributes: 'skills-runtime', count: 5, complete: true },
      { id: 'skill-codex', label: 'Codex 兼容目录', contributes: 'skills-physical', count: 1, complete: false, error: '目录读取超时（预览示例）', location: 'C:\\Users\\123\\.codex\\skills' },
      { id: 'skill-providers', label: 'Skill Provider 观察', contributes: 'provenance', count: 2, complete: true },
    ],
    counts: { physical: 8, runtime: 5, roots: 5 },
    unexplained: [
      { id: 'skill:runtime:ghost', name: 'ghost-skill', why: '运行时存在同名技能，但未找到对应物理目录' },
    ],
    notes: ['Codex 兼容根目录未启用，相关技能未进入运行时。'],
  }
}

/** Compute plugin statistics from the sample arrays so numbers always match rows. */
function pluginStatsOf(bundles: PluginBundleRecord[], rows: PluginRowRecord[]): PluginStats {
  const all: Array<PluginBundleRecord | PluginRowRecord> = [...bundles, ...rows]
  const contributed = bundles.flatMap(bundle => bundle.rows)
  const rowsLoaded = contributed.filter(row => row.loaded).length
    + rows.filter(row => row.runtime.loaded === true).length
  const rowsFailed = contributed.filter(row => row.fiberPhase === 'failed').length
    + rows.filter(row => row.row.fiberPhase === 'failed').length
  return {
    bundlesInstalled: bundles.filter(bundle => bundle.scope === 'current-profile').length,
    bundlesEnabled: bundles.filter(bundle => bundle.runtime.enabled === true).length,
    bundlesOtherProfiles: 2,
    bundlesOfficial: bundles.filter(bundle => bundle.official).length,
    rowsTotal: contributed.length + rows.length,
    rowsLoaded,
    rowsFailed,
    updatesAvailable: all.filter(record => {
      const signals = deriveSignals(record)
      return signals.updatable
    }).length,
    abnormal: all.filter(record => deriveSignals(record).abnormal).length,
  }
}

/** Compute skills statistics from the sample arrays. */
function skillStatsOf(records: AnySkillRecord[]): SkillStats {
  const physical = records.filter(record => record.layout !== 'virtual')
  const virtual = records.filter(record => record.layout === 'virtual')
  const runtimeVisible = physical.filter(record => record.effective && MANAGED_ROOTS.has(record.rootKey)).length + virtual.length
  return {
    physical: physical.length,
    runtime: runtimeVisible,
    effective: physical.filter(record => record.effective).length,
    shadowed: physical.filter(record => !record.effective && record.kind === 'skill' && record.shadowedBy !== undefined).length,
    notManaged: physical.filter(record => !MANAGED_ROOTS.has(record.rootKey)).length,
    updatesAvailable: records.filter(record => deriveSignals(record).updatable).length,
    abnormal: records.filter(record => deriveSignals(record).abnormal).length,
  }
}

interface FixtureState {
  bundles: PluginBundleRecord[]
  rows: PluginRowRecord[]
  skills: AnySkillRecord[]
  pluginsCheck: { lastRunAt?: string; running: boolean; taskId?: string }
  skillsCheck: { lastRunAt?: string; running: boolean; taskId?: string }
}

let state: FixtureState | undefined
const tasks = new Map<string, TaskState>()
let taskSeq = 0

/** Lazily create the sample inventory. */
function ensureState(): FixtureState {
  if (state === undefined) {
    state = {
      bundles: makeBundles(),
      rows: makePluginRows(),
      skills: makeSkills(),
      pluginsCheck: { running: false, lastRunAt: iso(12) },
      skillsCheck: { running: false, lastRunAt: iso(12) },
    }
  }
  return state
}

/** Fresh plugin payload object (base arrays are mutated by simulated tasks). */
function pluginsSnapshot(): PluginInventoryPayload {
  const current = ensureState()
  return {
    profile: { name: 'web', dir: PROFILE_DIR, dshHome: DSH_HOME, runtimeVersion: '0.2.1-rc.2' },
    profiles: [
      { name: 'web', dir: PROFILE_DIR, readable: true, current: true, bundles: current.bundles.length },
      { name: 'tui', dir: `${DSH_HOME}\\profiles\\tui`, readable: true, current: false, bundles: 2 },
    ],
    bundles: [...current.bundles],
    rows: [...current.rows],
    stats: pluginStatsOf(current.bundles, current.rows),
    reconciliation: pluginReconciliation(),
    check: { ...current.pluginsCheck },
  }
}

/** Fresh skills payload object. */
function skillsSnapshot(): SkillsInventoryPayload {
  const current = ensureState()
  return {
    workspace: { id: 'melsm-theory', name: 'melsm-theory', path: 'C:\\Users\\123\\Desktop\\workspace\\MELS M-theory' },
    roots: SKILL_ROOTS,
    physical: current.skills.filter((record): record is SkillRecordLike => record.layout !== 'virtual'),
    virtual: current.skills.filter((record): record is VirtualSkillRecordLike => record.layout === 'virtual'),
    stats: skillStatsOf(current.skills),
    reconciliation: skillReconciliation(),
    check: { ...current.skillsCheck },
  }
}

type VirtualSkillRecordLike = import('../shared/types').VirtualSkillRecord

/** Delay one microtask-like wait. */
async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/** Every preview record of one page. */
function recordsOfScope(scope: 'plugins' | 'skills'): Array<PluginBundleRecord | PluginRowRecord | AnySkillRecord> {
  const current = ensureState()
  return scope === 'plugins' ? [...current.bundles, ...current.rows] : [...current.skills]
}

/** Deterministic check result for one sample record. */
function checkOutcome(record: PluginBundleRecord | PluginRowRecord | AnySkillRecord): { status: UpdateStatus; reason: string; available?: string; availableTree?: string } {
  if (record.name === KEYWORDS.webserver) {
    return { status: 'update-available', reason: 'registry 上有更新的稳定版本，且兼容当前 DSH', available: '0.2.2' }
  }
  if (record.name === KEYWORDS.memory) {
    return { status: 'update-available', reason: 'GitHub 仓库有新提交，兼容当前 DSH', available: '0.3.1' }
  }
  if (record.name === KEYWORDS.session) {
    return { status: 'incompatible-update', reason: '新版本要求 DSH ^0.3.0，当前运行版本不满足', available: '2.0.0' }
  }
  if (record.name === KEYWORDS.faulty) {
    return { status: 'check-failed', reason: 'registry 请求超时（ETIMEDOUT），本次检查未得到结论' }
  }
  if (record.name === KEYWORDS.skillGit) {
    return { status: 'update-available', reason: '上游仓库有新的标签 v1.9.0，技能树不同', availableTree: '9f8e7d6c5b4a3210' }
  }
  if (record.name === KEYWORDS.broken) {
    return { status: 'check-failed', reason: 'SKILL.md frontmatter 解析失败' }
  }
  return { status: 'up-to-date', reason: '已与来源的最新版本一致' }
}

/** Create and self-advance one simulated task. */
function simulateTask(kind: TaskState['kind'], scope: 'plugins' | 'skills', ids: string[], onDone?: (task: TaskState) => void): TaskState {
  const records = recordsOfScope(scope)
  const targets = ids.length === 0
    ? records
    : records.filter(record => ids.includes(record.id))
  const task: TaskState = {
    id: `fixture-task-${String(++taskSeq)}`,
    kind,
    scope,
    status: 'queued',
    startedAt: new Date().toISOString(),
    total: targets.length,
    completed: 0,
    items: targets.map((record) => ({
      id: record.id,
      name: record.displayName !== '' ? record.displayName : record.name,
      status: 'pending',
    })),
  }
  tasks.set(task.id, task)
  let index = 0
  const step = (): void => {
    const item = task.items[index]
    const record = targets[index]
    if (item !== undefined) item.status = 'running'
    task.status = 'running'
    if (record !== undefined) {
      setTimeout(() => {
        if (item !== undefined) {
          item.status = kind === 'check' && record.name === KEYWORDS.faulty ? 'failed' : 'ok'
          if (kind === 'check') {
            const outcome = checkOutcome(record)
            record.version.status = outcome.status
            record.version.lastCheckedAt = new Date().toISOString()
            record.version.reason = outcome.reason
            item.message = outcome.reason
            if (outcome.available === undefined) delete record.version.available
            else record.version.available = outcome.available
            if (outcome.availableTree === undefined) delete record.version.availableTree
            else record.version.availableTree = outcome.availableTree
          } else {
            const nextVersion = record.version.available
            if (nextVersion !== undefined) record.version.current = nextVersion
            record.version.status = 'pending-restart'
            record.version.lastCheckedAt = new Date().toISOString()
            record.version.reason = '新版本已安装，重启 DSH 后生效'
            record.runtime.restartRequired = true
            if (nextVersion !== undefined) item.toVersion = nextVersion
            item.message = '已安装，等待重启'
          }
        }
        task.completed = index + 1
        index += 1
        if (index < task.items.length) {
          setTimeout(step, 220)
        } else {
          task.status = 'done'
          task.finishedAt = new Date().toISOString()
          task.message = kind === 'check'
            ? `检查完成：${String(task.items.filter(entry => entry.status === 'ok').length)} 项已检查`
            : `更新完成：${String(task.items.filter(entry => entry.status === 'ok').length)} 项已安装，重启 DSH 后生效`
          if (kind === 'check') {
            if (scope === 'plugins') ensureState().pluginsCheck = { running: false, lastRunAt: new Date().toISOString() }
            else ensureState().skillsCheck = { running: false, lastRunAt: new Date().toISOString() }
          }
          onDone?.(task)
        }
      }, 260)
    }
  }
  setTimeout(() => {
    if (task.items.length === 0) {
      task.status = 'done'
      task.finishedAt = new Date().toISOString()
      task.message = kind === 'check' ? '没有可检查的项目' : '没有可更新的项目'
      onDone?.(task)
      return
    }
    step()
  }, 120)
  return task
}

/** Build one plan entry from a record. */
function planEntryOf(record: PluginBundleRecord | PluginRowRecord | AnySkillRecord, eligible: boolean): UpdatePlanEntry {
  const signals = deriveSignals(record)
  const blocked = record.actions.updateBlockedReason
  const reason = eligible
    ? undefined
    : record.version.status === 'incompatible-update'
      ? record.version.reason ?? '新版本与当前 DSH 不兼容'
      : record.version.status !== 'update-available'
        ? blocked ?? '当前没有可安装的更新'
        : blocked ?? '不能由扩展管理器自动更新'
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    displayName: record.displayName !== '' ? record.displayName : record.name,
    ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
    ...(record.version.available === undefined ? {} : { targetVersion: record.version.available }),
    sourceLabel: record.source.label,
    eligible,
    ...(reason === undefined ? {} : { excludedReason: reason }),
    requiresConfirmation: record.actions.requiresConfirmation === true,
    needsRestart: record.kind !== 'skill',
    ...(eligible
      ? { risk: record.kind === 'skill' ? '会更新技能目录，运行时目录随后刷新' : '会下载并替换 Profile 中的插件包文件，安装后校验' }
      : {}),
  }
}

/** Build a plan for the requested ids (empty means every record). */
function buildPlan(scope: 'plugins' | 'skills', ids: string[] | undefined): UpdatePlan {
  const records = recordsOfScope(scope)
  const targets = ids === undefined || ids.length === 0 ? records : records.filter(record => ids.includes(record.id))
  const entries: UpdatePlanEntry[] = []
  const excluded: UpdatePlanEntry[] = []
  for (const record of targets) {
    const signals = deriveSignals(record)
    if (signals.updatable) entries.push(planEntryOf(record, true))
    else if (record.version.status === 'update-available' || record.version.status === 'incompatible-update' || record.version.status === 'check-failed') {
      excluded.push(planEntryOf(record, false))
    }
  }
  return { kind: scope, entries, excluded, createdAt: new Date().toISOString() }
}

/** Preview history entries. */
const HISTORY: HistoryEntry[] = [
  {
    id: 'history-1',
    at: iso(26),
    kind: 'plugin-bundle',
    name: KEYWORDS.memory,
    action: 'update',
    fromVersion: '0.2.9',
    toVersion: '0.3.0',
    outcome: 'success',
    message: '更新成功，安装后校验通过',
    transactionId: 'txn-fixture-1',
  },
  {
    id: 'history-2',
    at: iso(180),
    kind: 'skill',
    name: KEYWORDS.skillGit,
    action: 'skill-update',
    fromVersion: '1.7.0',
    toVersion: '1.8.0',
    outcome: 'success',
    message: '技能树已更新，运行时目录已刷新',
    transactionId: 'txn-fixture-2',
  },
  {
    id: 'history-3',
    at: iso(400),
    kind: 'plugin-bundle',
    name: KEYWORDS.faulty,
    action: 'update',
    fromVersion: '2.0.0',
    toVersion: '2.1.0',
    outcome: 'rolled-back',
    message: '安装后校验失败，已回滚到原版本',
    transactionId: 'txn-fixture-3',
  },
  {
    id: 'history-4',
    at: iso(2880),
    kind: 'plugin-bundle',
    name: KEYWORDS.webserver,
    action: 'batch-update',
    fromVersion: '0.2.1-rc.1',
    toVersion: '0.2.1-rc.2',
    outcome: 'blocked',
    message: '需要确认来源，用户取消了本次更新',
  },
]

/** Preview diagnostics payload. */
function diagnosticsSnapshot(): DiagnosticsResponse {
  return {
    ok: true,
    environment: {
      runtimeVersion: '0.2.1-rc.2',
      hostPid: 3028,
      profile: { name: 'web', dir: PROFILE_DIR, dshHome: DSH_HOME, installAnchor: 'C:\\Users\\123\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh' },
      platform: 'win32 x64',
      nodeVersion: 'v22.19.0',
      pnpmVersion: '10.4.1',
      gitVersion: 'git version 2.47.1.windows.1',
      hmrEnabled: true,
      registries: {
        registry: 'https://registry.npmmirror.com',
        fallbackRegistries: ['https://registry.npmjs.org'],
        resolved: 'https://registry.npmmirror.com',
      },
      manager: {
        version: '0.1.0',
        ownPackageName: 'dsh-extension-manager',
        updatesSupported: true,
        selfUpdateSupported: false,
        selfUpdateReason: '本地 link 安装不支持自更新（预览示例）',
        stateDir: STATE_DIR,
        logDir: `${STATE_DIR}\\logs`,
        backupDir: `${STATE_DIR}\\backups`,
      },
      skillProviders: [
        { key: 'filesystem', managed: true, path: SKILLS_ROOT },
        { key: 'builtin', managed: true, path: '(runtime)' },
        { key: 'codex', managed: false, path: 'C:\\Users\\123\\.codex\\skills' },
      ],
      limitations: [
        '预览模式：诊断数据来自本地示例，不代表真实 Host。',
        'Codex 兼容根目录未启用，相关技能不会进入运行时。',
        '官方插件随 DSH 版本发布，扩展管理器不会覆盖安装。',
      ],
    },
    probes: [
      { name: '状态目录可写', ok: true, detail: STATE_DIR },
      { name: '日志目录可写', ok: true, detail: `${STATE_DIR}\\logs` },
      { name: 'npm registry 可达', ok: true, detail: 'https://registry.npmmirror.com' },
      { name: 'git 可用', ok: true, detail: 'git version 2.47.1.windows.1' },
      { name: 'Codex 兼容目录读取', ok: false, detail: '目录读取超时（预览示例）' },
    ],
    logs: { stateDir: STATE_DIR, logDir: `${STATE_DIR}\\logs`, latestLog: `${STATE_DIR}\\logs\\manager.log` },
  }
}

/** Create the preview transport. */
export function createFixtureTransport(): Transport {
  ensureState()
  return {
    preview: true,
    async plugins(options = {}) {
      await delay(options.refresh === true ? 320 : 180)
      return pluginsSnapshot()
    },
    async skills(options = {}) {
      await delay(options.refresh === true ? 280 : 160)
      return skillsSnapshot()
    },
    async refresh(_body: RefreshRequest): Promise<RefreshResponse> {
      await delay(320)
      return { ok: true, plugins: pluginsSnapshot(), skills: skillsSnapshot() }
    },
    async check(body: CheckRequest): Promise<TaskState> {
      await delay(160)
      const scope = body.scope === 'all' ? 'plugins' : body.scope
      if (body.scope === 'all') {
        ensureState().pluginsCheck = { running: true }
      } else if (scope === 'plugins') {
        ensureState().pluginsCheck = { running: true }
      } else {
        ensureState().skillsCheck = { running: true }
      }
      const task = simulateTask('check', scope, body.ids ?? [], () => { /* snapshots are rebuilt per read */ })
      if (scope === 'plugins') ensureState().pluginsCheck = { running: true, taskId: task.id }
      else ensureState().skillsCheck = { running: true, taskId: task.id }
      return task
    },
    async waitForTask(id: string, options: TaskPollOptions = {}): Promise<TaskState> {
      const interval = options.intervalMs ?? 500
      const deadline = Date.now() + (options.timeoutMs ?? 15 * 60_000)
      for (;;) {
        if (options.signal?.aborted === true) throw new Error('请求已取消')
        const task = tasks.get(id)
        if (task === undefined) throw new Error('任务不存在或已过期')
        options.onTask?.(task)
        if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return task
        if (Date.now() > deadline) throw new Error('任务执行超时')
        await delay(interval)
      }
    },
    async task(id: string, _signal?: AbortSignal): Promise<TaskResponse> {
      await delay(60)
      const task = tasks.get(id)
      if (task === undefined) return { ok: false, error: '任务不存在或已过期' }
      return { ok: true, task, pending: task.status === 'queued' || task.status === 'running' }
    },
    async tasks(): Promise<TaskState[]> {
      await delay(40)
      return [...tasks.values()]
    },
    async updatePlan(body: UpdatePlanRequest): Promise<UpdatePlan> {
      await delay(280)
      const scope = body.scope === 'all' ? 'plugins' : body.scope
      return buildPlan(scope, body.ids)
    },
    async update(body) {
      await delay(220)
      const scope = body.scope === 'all' ? 'plugins' : body.scope
      const task = simulateTask('batch-update', scope, body.ids)
      const response: UpdateResponse = { ok: true, task, plan: buildPlan(scope, body.ids) }
      return response
    },
    async history(): Promise<HistoryEntry[]> {
      await delay(180)
      return HistoryEntries()
    },
    async diagnostics(): Promise<DiagnosticsResponse> {
      await delay(260)
      return diagnosticsSnapshot()
    },
    async health(): Promise<HealthResponse> {
      await delay(40)
      return { ok: true, plugin: 'extension-manager', version: '0.1.0', pid: 3028, now: new Date().toISOString() }
    },
  }
}

/** Separate function keeps the array type readable above. */
function HistoryEntries(): HistoryEntry[] {
  return HISTORY
}
