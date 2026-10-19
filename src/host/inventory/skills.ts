/**
 * Skills inventory: physical list A (every real SKILL.md copy this machine
 * exposes) joined with runtime list B (`ctx.skills.snapshot()`), plus
 * provenance, local-modification state, diagnostics, statistics and the
 * completeness audit shown by the Web page.
 *
 * Authoritative reads:
 *   - the running Cordis Loader configuration of `@deepseek-ai/dsh-skill-filesystem`
 *     for managed roots and their ranks;
 *   - the filesystem under those roots and under the non-managed external
 *     agent-tool roots (`~/.codex`, `~/.claude`, `~/.copilot`, `~/.cursor`);
 *   - `<AGENTS_HOME>/.skill-lock.json` for `skills` CLI provenance;
 *   - user-confirmed repository associations from the manager's durable state;
 *   - `ctx.skills.snapshot()` for the catalog each live scope actually sees.
 * Nothing here writes, moves or deletes a skill file.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {
  Diagnostic,
  LocalModificationInfo,
  RecordActions,
  Reconciliation,
  SkillRecord,
  SkillsInventoryPayload,
  SkillStats,
  SourceInfo,
  SourceStatus,
  UpdateStatus,
  VersionInfo,
  VirtualSkillRecord,
} from '../../shared/types'
import type { SkillsInventory } from '../contracts'
import type { ManagerLog } from '../logs'
import type { CheckCacheEntry, ManagerState, SkillSourceAssociation } from '../state'
import { profileFacts, type ProfileFacts } from '../env'
import {
  canonicalPath,
  computeSkillFolderTreeSha,
  dedupePhysicalCopies,
  describePhysicalAliases,
  discoverRoot,
  findSkillLockEntry,
  linkRuntimeCatalog,
  lockEntrySubdir,
  normalizeGitHubUrl,
  parseGitHubRepository,
  readGitHeadTree,
  readGitRepository,
  readGitWorktreeStatus,
  readSkillLockFile,
  relativePosix,
  resolveHomeRoot,
  resolveLocalModificationDecision,
  resolvePhysicalOverrides,
  resolveSkillRoots,
  samePath,
  sameTreeSha,
  shortTreeSha,
  skillPathKey,
  tidyPath,
  SKILL_NAME_PATTERN,
  SKILL_RANKS,
  type DiscoveredSkill,
  type GitRepositoryInfo,
  type PhysicalCopyOrdering,
  type PhysicalSkillIdentity,
  type RegisteredWorkspaceLike,
  type RuntimeCatalog,
  type RuntimeSkillSummary,
  type SkillLockEntry,
  type SkillProviderSettings,
  type SkillRootSpec,
} from './skillRoots'
import { verifyRemoteSkillFolder } from '../updates/skillUpdates'

/** Inventory cache window; the page may refresh explicitly at any time. */
const SCAN_CACHE_MS = 4000

/** Honest explanation for the missing per-skill switch. */
const TOGGLE_BLOCKED_REASON = 'DSH 没有官方的逐技能启停机制：技能是否加载由所在目录与运行时 provider 决定，管理器只展示真实状态，不提供伪造的开关。'

/** Module name of the DSH filesystem skill provider. */
const SKILL_FILESYSTEM_MODULE = '@deepseek-ai/dsh-skill-filesystem'

/** Structural view of `ctx.skills` — only the read surface the manager uses. */
interface SkillRegistryLike {
  snapshot(options: { cwd?: string; scope?: object }): Promise<unknown>
}

/** Structural view of `ctx.agents`. */
interface AgentRegistryLike {
  list(): readonly unknown[]
}

/** Structural view of `ctx.loader`. */
interface LoaderEntryLike {
  options?: { name?: unknown; config?: unknown; disabled?: unknown }
}

interface LoaderLike {
  entries(): Iterable<unknown>
}

/** Structural view of `ctx.configEditor`. */
interface ConfigEditorLike {
  configuration(): Array<{
    entry?: { options?: { name?: unknown } }
    inherited?: unknown
    override?: unknown
  }>
}

/** Structural view of `ctx.workspaceRegistry`. */
interface WorkspaceRegistryLike {
  list(): readonly unknown[]
}

interface WorkspaceLike {
  id?: unknown
  path?: unknown
  title?: unknown
  name?: unknown
}

/** Provider configuration rows read from the running composition. */
interface ProviderConfigRow {
  config: Record<string, unknown>
  source: 'loader' | 'config-editor'
}

/** Effective workspace + the other registered workspaces. */
interface WorkspaceSelection {
  path: string
  id?: string
  name?: string
  others: RegisteredWorkspaceLike[]
  diagnostics: Diagnostic[]
}

/** One physical copy with everything the record needs, before linking. */
interface PreparedCopy {
  root: SkillRootSpec
  discovered: DiscoveredSkill
  id: string
  identity: PhysicalSkillIdentity
  source: SourceInfo
  localModification: LocalModificationInfo
  diagnostics: Diagnostic[]
  invocation: { model: boolean; user: boolean }
  git?: GitRepositoryInfo
  currentTree?: string
  /** Cached check answer used for version + local-modification alignment. */
  cached?: CheckCacheEntry
  /** Lexical manifest paths of Junction/symlink aliases collapsed into this copy. */
  aliasPaths?: string[]
  /** Roots that reached the same physical directory through an alias. */
  aliasRootKeys?: string[]
  /** Whether a trustworthy remote source exists for update checking. */
  canCheck: boolean
  updateBlockedReason?: string
}

/** One root with discovery results. */
interface RootFinding {
  root: SkillRootSpec
  skills: DiscoveredSkill[]
  diagnostics: Diagnostic[]
  complete: boolean
  exists: boolean
}

/** One discovered skill before realpath de-duplication. */
interface DiscoveredCandidate {
  root: SkillRootSpec
  discovered: DiscoveredSkill
  id: string
}

/** Candidate plus the ordering facts the de-duplicator reads. */
type OrderedCandidate = DiscoveredCandidate & PhysicalCopyOrdering

/** Empty statistics block. */
function emptyStats(): SkillStats {
  return { physical: 0, runtime: 0, effective: 0, shadowed: 0, notManaged: 0, updatesAvailable: 0, abnormal: 0 }
}

/** Treat an unknown value as a plain record when possible. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Whether a module specifier is the DSH filesystem skill provider. */
function isSkillFilesystemModule(name: unknown): boolean {
  return typeof name === 'string' && (name === SKILL_FILESYSTEM_MODULE || name.startsWith(`${SKILL_FILESYSTEM_MODULE}/`))
}

/** Read one string field from a config object. */
function configString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read one boolean field from a config object (legacy values accepted). */
function configBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key]
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return undefined
}

/** Read a string array field from a config object. */
function configStringArray(config: Record<string, unknown>, key: string): string[] {
  const value = config[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

/** Resolve the effective `skill-filesystem` settings from the running Loader. */
function readProviderSettings(ctx: Context, facts: ProfileFacts): SkillProviderSettings {
  const notes: string[] = []
  const rows: ProviderConfigRow[] = []
  const loader = ctx.get('loader') as LoaderLike | undefined
  if (loader !== undefined && typeof loader.entries === 'function') {
    try {
      for (const raw of loader.entries()) {
        const entry = raw as LoaderEntryLike
        const options = entry.options
        if (options === undefined || !isSkillFilesystemModule(options.name)) continue
        if (options.disabled === true) continue
        rows.push({ config: asRecord(options.config), source: 'loader' })
      }
    } catch {
      // A broken Loader view degrades to the ConfigEditor / defaults path.
    }
  }
  if (rows.length === 0) {
    const editor = ctx.get('configEditor') as ConfigEditorLike | undefined
    if (editor !== undefined && typeof editor.configuration === 'function') {
      try {
        for (const item of editor.configuration()) {
          if (!isSkillFilesystemModule(item.entry?.options?.name)) continue
          rows.push({ config: { ...asRecord(item.inherited), ...asRecord(item.override) }, source: 'config-editor' })
        }
      } catch {
        // Fall through to defaults with a note.
      }
    }
  }
  let providerName = 'filesystem'
  let dshHomeConfigured: string | undefined
  let agentsHomeConfigured: string | undefined
  let bundledConfigured: string | undefined
  const customDirs = new Set<string>()
  let includeDefaultRoots = true
  if (rows.length > 0) {
    includeDefaultRoots = rows.some(row => configBoolean(row.config, 'includeDefaultRoots') !== false)
    for (const row of rows) {
      providerName = configString(row.config, 'providerName') ?? providerName
      dshHomeConfigured = configString(row.config, 'dshHome') ?? dshHomeConfigured
      agentsHomeConfigured = configString(row.config, 'agentsHome') ?? agentsHomeConfigured
      bundledConfigured = configString(row.config, 'bundledSkillDir') ?? bundledConfigured
      for (const dir of configStringArray(row.config, 'customSkillDirs')) customDirs.add(dir)
    }
    if (rows.length > 1) {
      notes.push(`运行时找到 ${String(rows.length)} 个 skill-filesystem 挂载（含 Agent 预设），自定义技能根按并集处理。`)
    }
  } else {
    notes.push('未能在运行时 Loader 配置中找到 skill-filesystem，按 DSH 默认根（项目根、DSH 用户根、共享 Agent 根）解析。')
  }
  const dshHome = resolveHomeRoot(dshHomeConfigured, 'DSH_HOME', facts.home === '' ? join(homedir(), '.dsh') : facts.home)
  const agentsHomeDefault = join(homedir(), '.agents')
  // `DSH_AGENTS_HOME` may be unset; the shared agent root then stays ~/.agents.
  const agentsHome = resolveHomeRoot(agentsHomeConfigured, 'DSH_AGENTS_HOME', agentsHomeDefault)
  const bundledFromEnv = includeDefaultRoots && (process.env.DSH_BUNDLED_SKILL_DIR ?? '').trim() !== ''
    ? (process.env.DSH_BUNDLED_SKILL_DIR ?? '').trim()
    : undefined
  const bundledSkillDir = bundledConfigured ?? bundledFromEnv
  return {
    providerName,
    includeDefaultRoots,
    dshHome,
    agentsHome,
    customSkillDirs: [...customDirs],
    ...(bundledSkillDir === undefined ? {} : { bundledSkillDir }),
    source: rows.length === 0 ? 'defaults' : (rows[0]?.source ?? 'loader'),
    notes,
  }
}

/** Whether `parent` contains `child` (case rules follow the platform). */
function containsPath(parent: string, child: string): boolean {
  const rel = relative(tidyPath(resolve(parent)), tidyPath(resolve(child)))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Select the workspace whose project roots are scanned. */
function selectWorkspace(ctx: Context, facts: ProfileFacts, requested?: string): WorkspaceSelection {
  const diagnostics: Diagnostic[] = []
  const registered: RegisteredWorkspaceLike[] = []
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
  if (registry !== undefined && typeof registry.list === 'function') {
    try {
      for (const raw of registry.list()) {
        const workspace = raw as WorkspaceLike
        if (typeof workspace.path !== 'string' || workspace.path === '') continue
        const name = typeof workspace.title === 'string' && workspace.title !== ''
          ? workspace.title
          : typeof workspace.name === 'string' && workspace.name !== '' ? workspace.name : undefined
        registered.push({
          path: tidyPath(resolve(workspace.path)),
          ...(typeof workspace.id === 'string' ? { id: workspace.id } : {}),
          ...(name === undefined ? {} : { name }),
        })
      }
    } catch {
      diagnostics.push({ level: 'warning', code: 'skill-workspace/unreadable', message: '无法读取 DSH 工作区注册表，项目技能根按 Host 工作目录解析。' })
    }
  }
  let selectedPath: string
  let matched: RegisteredWorkspaceLike | undefined
  if (requested !== undefined && requested.trim() !== '') {
    selectedPath = tidyPath(resolve(requested))
    matched = registered.find(workspace => samePath(workspace.path, selectedPath))
    if (matched === undefined) {
      diagnostics.push({ level: 'info', code: 'skill-workspace/unregistered', message: `请求的工作区「${selectedPath}」不在注册表中，仅按该目录解析项目技能根。` })
    }
  } else {
    const cwd = tidyPath(resolve(facts.cwd))
    matched = registered
      .filter(workspace => containsPath(workspace.path, cwd))
      .sort((left, right) => right.path.length - left.path.length)[0]
    if (matched !== undefined) {
      selectedPath = matched.path
    } else {
      selectedPath = cwd
      diagnostics.push({ level: 'info', code: 'skill-workspace/cwd-fallback', message: '当前 Host 工作目录不在已注册工作区中，项目技能根按该目录解析。' })
    }
  }
  const others = registered.filter(workspace => !samePath(workspace.path, selectedPath))
  return {
    path: selectedPath,
    ...(matched?.id === undefined ? {} : { id: matched.id }),
    ...(matched?.name === undefined ? {} : { name: matched.name }),
    others,
    diagnostics,
  }
}

/** Validate one runtime summary coming back from `ctx.skills.snapshot()`. */
function normalizeRuntimeSummary(raw: unknown): RuntimeSkillSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const name = record.name
  if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name)) return undefined
  const description = typeof record.description === 'string' ? record.description : ''
  const invocationRaw = asRecord(record.invocation)
  const invocation = {
    modelInvocable: invocationRaw.modelInvocable !== false,
    userInvocable: invocationRaw.userInvocable !== false,
  }
  const path = typeof record.path === 'string' && record.path !== '' ? record.path : undefined
  const provider = typeof record.provider === 'string' && record.provider !== '' ? record.provider : undefined
  const source = typeof record.source === 'string' && record.source !== '' ? record.source : undefined
  const whenToUse = typeof record.whenToUse === 'string' && record.whenToUse !== '' ? record.whenToUse : undefined
  return {
    name,
    description,
    invocation,
    ...(path === undefined ? {} : { path }),
    ...(provider === undefined ? {} : { provider }),
    ...(source === undefined ? {} : { source }),
    ...(whenToUse === undefined ? {} : { whenToUse }),
  }
}

/**
 * Observe the runtime catalog from every scope this Host process can address:
 * the host-wide layer and each live Agent (whose preset composition mounts its
 * own filesystem provider). The union is list B; duplicates are merged by
 * name+path so a scope that sees an extra copy contributes it.
 */
async function observeRuntimeCatalog(ctx: Context, workspacePath: string): Promise<RuntimeCatalog> {
  const registry = ctx.get('skills') as SkillRegistryLike | undefined
  if (registry === undefined || typeof registry.snapshot !== 'function') {
    return { available: false, complete: false, skills: [], observations: [], errors: ['Host 没有提供 skills 服务，无法读取运行时技能清单。'] }
  }
  const targets: Array<{ label: string; scope?: object }> = [{ label: 'Host 全局技能层' }]
  const agents = ctx.get('agents') as AgentRegistryLike | undefined
  if (agents !== undefined && typeof agents.list === 'function') {
    try {
      const live = agents.list().slice(0, 8)
      for (const [index, agent] of live.entries()) {
        if (typeof agent !== 'object' || agent === null) continue
        targets.push({ label: `Agent 会话 ${String(index + 1)}`, scope: agent })
      }
    } catch {
      // Agent registry is optional for the inventory.
    }
  }
  const skills: RuntimeSkillSummary[] = []
  const seen = new Set<string>()
  const observations: string[] = []
  const errors: string[] = []
  let complete = true
  for (const target of targets) {
    try {
      const snapshot = await registry.snapshot({
        cwd: workspacePath,
        ...(target.scope === undefined ? {} : { scope: target.scope }),
      })
      observations.push(target.label)
      const record = asRecord(snapshot)
      if (record.complete !== true) complete = false
      const rawSkills = Array.isArray(record.skills) ? record.skills : []
      for (const raw of rawSkills) {
        const summary = normalizeRuntimeSummary(raw)
        if (summary === undefined) continue
        const key = `${summary.name}\u0000${summary.path === undefined ? '' : skillPathKey(summary.path)}`
        if (seen.has(key)) continue
        seen.add(key)
        skills.push(summary)
      }
    } catch (error) {
      complete = false
      errors.push(`${target.label}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { available: true, complete, skills, observations, errors }
}

/**
 * Derive additional managed roots from the runtime catalog. Agent presets mount
 * their own `skill-filesystem` provider with extra `customSkillDirs`; that
 * mount lives in a scoped composition the Host-level Loader configuration does
 * not enumerate, but its skills are visible in list B. A skill directory whose
 * parent is outside every known root reveals such a root.
 */
function observeRuntimeRoots(
  catalog: RuntimeCatalog,
  knownRoots: readonly SkillRootSpec[],
  settings: SkillProviderSettings,
): { roots: SkillRootSpec[]; notes: string[] } {
  const roots: SkillRootSpec[] = []
  const notes: string[] = []
  if (!catalog.available) return { roots, notes }
  const seen = new Set<string>()
  for (const summary of catalog.skills) {
    if (summary.path === undefined || summary.path === '') continue
    if (summary.provider !== undefined && summary.provider !== settings.providerName) continue
    const skillDir = dirname(summary.path)
    if (knownRoots.some(root => containsPath(root.path, skillDir))) continue
    const candidate = dirname(skillDir)
    if (candidate === skillDir) continue
    const key = skillPathKey(candidate)
    if (seen.has(key)) continue
    seen.add(key)
    roots.push({
      key: `runtime:${basename(candidate)}`,
      label: `运行时观察到的技能根（${candidate}）`,
      path: candidate,
      rank: SKILL_RANKS.custom,
      managed: true,
      kind: 'custom',
      synthetic: true,
      note: '该技能根由运行时技能清单观察到（Agent 预设挂载的 skill-filesystem），未出现在 Host 级 Loader 配置中。',
    })
    notes.push(`运行时技能清单显示了一个不在 Loader 配置中的文件系统技能根：${candidate}（已补充扫描为托管根）。`)
    if (roots.length >= 8) break
  }
  return { roots, notes }
}

/** Build the provenance block for one physical copy. */
function buildSource(input: {
  root: SkillRootSpec
  discovered: DiscoveredSkill
  association?: SkillSourceAssociation
  lockEntry?: SkillLockEntry
  git?: GitRepositoryInfo
  currentTree?: string
}): { source: SourceInfo; canCheck: boolean; updateBlockedReason?: string } {
  const { root, discovered, association, lockEntry, git, currentTree } = input
  if (association !== undefined) {
    const repository = parseGitHubRepository(association.url)
    const label = repository === undefined ? `用户确认来源 · ${association.url}` : `用户确认来源 · ${repository.owner}/${repository.repo}`
    const source: SourceInfo = {
      kind: 'skill-git',
      trust: 'verified',
      label,
      url: association.url,
      ...(association.ref === undefined ? {} : { ref: association.ref }),
      ...(association.subdir === undefined ? {} : { subdir: association.subdir }),
      ...(association.baseline?.commit === undefined ? {} : { commit: association.baseline.commit }),
      ...(repository === undefined ? {} : { repo: `${repository.owner}/${repository.repo}` }),
      detail: association.verified
        ? '用户在管理器中确认并校验过的仓库来源'
        : '用户确认的来源，但当时未能通过远端校验；更新检查会重新核对',
    }
    return repository === undefined
      ? { source, canCheck: false, updateBlockedReason: '确认的来源不是 GitHub 仓库，管理器暂不支持该来源的更新检查' }
      : root.managed
        ? { source, canCheck: true }
        : { source, canCheck: false, updateBlockedReason: '该目录不在 DSH 托管范围内，管理器不会修改其内容' }
  }
  if (lockEntry !== undefined && lockEntry.sourceUrl !== undefined) {
    const repository = parseGitHubRepository(lockEntry.sourceUrl)
    const hasRecordedHash = lockEntry.skillFolderHash !== undefined && lockEntry.skillFolderHash !== ''
    const clean = currentTree !== undefined && sameTreeSha(currentTree, lockEntry.skillFolderHash)
    const subdir = lockEntrySubdir(lockEntry)
    // Provenance trust is about the recorded source, not about local drift:
    // `~/.agents/.skill-lock.json` is written by the installer together with the
    // folder hash, so a GitHub-backed entry stays `verified`. Local edits are
    // reported through `localModification` and gated by the update confirmation.
    const trustedSource = repository !== undefined && hasRecordedHash
    const source: SourceInfo = {
      kind: 'skill-lock',
      trust: trustedSource ? 'verified' : 'needs-confirmation',
      label: repository === undefined ? '锁文件记录 · 非 GitHub 来源' : `锁文件记录 · ${repository.owner}/${repository.repo}`,
      url: repository === undefined ? lockEntry.sourceUrl : normalizeGitHubUrl(repository),
      ...(repository === undefined ? {} : { repo: `${repository.owner}/${repository.repo}` }),
      ...(subdir === undefined ? {} : { subdir }),
      ...(lockEntry.ref === undefined ? {} : { ref: lockEntry.ref }),
      detail: clean
        ? '目录哈希与 ~/.agents/.skill-lock.json 记录一致'
        : '来源由 ~/.agents/.skill-lock.json 记录；目录哈希与记录不一致（本地可能被修改，或安装后上游有变化）',
    }
    const checkable = root.managed && repository !== undefined && hasRecordedHash
    if (checkable) return { source, canCheck: true }
    const reason = !root.managed
      ? '该目录不在 DSH 托管范围内，管理器不会修改其内容'
      : repository === undefined
        ? '锁文件记录的来源不是 GitHub 仓库，暂不支持更新检查'
        : '锁文件缺少目录哈希，无法确认本地基线'
    return { source, canCheck: false, updateBlockedReason: reason }
  }
  if (git !== undefined && git.remoteUrl !== undefined) {
    const repository = parseGitHubRepository(git.remoteUrl)
    const subdir = relativePosix(git.root, discovered.dir)
    const source: SourceInfo = {
      kind: 'skill-git',
      trust: repository === undefined ? 'unknown' : 'verified',
      label: repository === undefined ? 'Git 仓库（非 GitHub）' : `Git 仓库 · ${repository.owner}/${repository.repo}`,
      url: git.remoteUrl,
      ...(repository === undefined ? {} : { repo: `${repository.owner}/${repository.repo}` }),
      ...(git.branch === undefined ? {} : { ref: git.branch }),
      ...(git.commit === undefined ? {} : { commit: git.commit }),
      ...(subdir === '' ? {} : { subdir }),
      ...(repository === undefined ? { detail: '该仓库不在 GitHub 上，管理器暂不支持自动更新检查' } : {}),
    }
    if (repository !== undefined && root.managed) return { source, canCheck: true }
    return {
      source,
      canCheck: false,
      updateBlockedReason: root.managed
        ? '该 Git 仓库不在 GitHub 上，管理器暂不支持其更新检查'
        : '该目录不在 DSH 托管范围内，管理器不会修改其内容',
    }
  }
  return {
    source: {
      kind: 'filesystem',
      trust: root.managed ? 'local-custom' : 'unknown',
      label: root.managed ? '本地文件系统（无远端来源）' : '本机外部目录（DSH 未托管）',
      detail: root.managed
        ? '该技能是本地目录，没有记录可核对的远端仓库'
        : `该目录属于其他 Agent 工具，DSH 不会加载：${root.path}`,
    },
    canCheck: false,
    updateBlockedReason: root.managed ? '该技能没有可核对的远端来源' : '该目录不在 DSH 托管范围内，管理器不会修改其内容',
  }
}

/** Build the version block for one physical copy from the durable check cache. */
function buildVersion(input: {
  cached?: CheckCacheEntry
  canCheck: boolean
  currentTree?: string
  git?: GitRepositoryInfo
}): VersionInfo {
  const { cached, canCheck, currentTree, git } = input
  const status: UpdateStatus = canCheck ? (cached?.status ?? 'unchecked') : 'no-source'
  // `availableTree` is an *update candidate* for the UI; an up-to-date answer
  // carries the observed upstream tree only so local-modification alignment can
  // use it, and must not be rendered as a pending candidate.
  const availableTree = status === 'up-to-date' ? undefined : cached?.availableTree
  return {
    ...(currentTree === undefined ? {} : { currentTree }),
    ...(git?.commit === undefined ? {} : { currentCommit: git.commit }),
    ...(git?.branch === undefined ? {} : { branch: git.branch }),
    ...(availableTree === undefined ? {} : { availableTree }),
    ...(cached?.availableCommit === undefined ? {} : { availableCommit: cached.availableCommit }),
    ...(cached?.channel === undefined ? {} : { channel: cached.channel }),
    ...(cached?.compatibility === undefined ? {} : { compatibility: cached.compatibility }),
    ...(cached?.checkedAt === undefined ? {} : { lastCheckedAt: cached.checkedAt }),
    status,
    ...(cached?.detail !== undefined ? { reason: cached.detail } : canCheck ? {} : { reason: '没有可核对的远端来源' }),
  }
}

/** Build the local-modification block for one physical copy. */
async function resolveLocalModification(input: {
  root: SkillRootSpec
  discovered: DiscoveredSkill
  association?: SkillSourceAssociation
  lockEntry?: SkillLockEntry
  git?: GitRepositoryInfo
  currentTree?: string
  /** Upstream tree from the latest durable check (`state.checks`). */
  remoteTree?: string
  /** Timestamp of the recorded baseline (lock install time / confirmation time). */
  baselineRecordedAt?: string
  signal?: AbortSignal
}): Promise<LocalModificationInfo> {
  const { root, discovered, association, lockEntry, git, currentTree } = input
  const baseline = lockEntry?.skillFolderHash ?? association?.baseline?.tree
  const decision = resolveLocalModificationDecision({
    ...(currentTree === undefined ? {} : { localTree: currentTree }),
    ...(baseline === undefined ? {} : { baselineTree: baseline }),
    baselineLabel: lockEntry !== undefined ? '锁记录基线' : '来源基线',
    ...(input.remoteTree === undefined ? {} : { remoteTree: input.remoteTree }),
    ...(input.baselineRecordedAt === undefined ? {} : { baselineRecordedAt: input.baselineRecordedAt }),
  })
  if (decision.state !== 'unknown') {
    return {
      state: decision.state,
      ...(decision.state === 'modified' ? { files: [] } : {}),
      ...(decision.detail === undefined ? {} : { detail: decision.detail }),
    }
  }
  // No comparable tree: a Git checkout can still report its worktree state.
  if (git !== undefined) {
    const status = await readGitWorktreeStatus(git.root, discovered.dir, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    if (status.state === 'clean') return { state: 'clean', files: [], detail: 'Git 工作区没有未提交修改' }
    if (status.state === 'modified') {
      return { state: 'modified', files: status.files.slice(0, 20), detail: 'Git 工作区存在未提交修改' }
    }
    return {
      state: 'unknown',
      ...(status.error === undefined ? {} : { detail: `无法读取 Git 状态：${status.error}` }),
    }
  }
  return {
    state: 'unknown',
    detail: root.managed ? '没有可比较的远端基线，无法判断本地是否被修改' : '非托管目录没有本地修改基线',
  }
}

/** Extract the diagnostics that describe one physical copy. */
function diagnosticsForCopy(diagnostics: readonly Diagnostic[], identity: PhysicalSkillIdentity): Diagnostic[] {
  return diagnostics.filter(item => {
    const detail = item.detail ?? {}
    if (detail.path === identity.realPath) return true
    return detail.name === identity.name && detail.loser === identity.rootKey
  })
}

/** Group winning copies by name so shadowed copies can be attached to them. */
function computeOverriddenCopies(
  copies: readonly PhysicalSkillIdentity[],
  effective: ReadonlySet<string>,
): Map<string, Array<{ rootKey: string; path: string }>> {
  const winnersByName = new Map<string, string[]>()
  for (const copy of copies) {
    if (!effective.has(copy.id)) continue
    const list = winnersByName.get(copy.name) ?? []
    list.push(copy.id)
    winnersByName.set(copy.name, list)
  }
  const result = new Map<string, Array<{ rootKey: string; path: string }>>()
  for (const copy of copies) {
    if (effective.has(copy.id) || !copy.managed) continue
    for (const winnerId of winnersByName.get(copy.name) ?? []) {
      const list = result.get(winnerId) ?? []
      list.push({ rootKey: copy.rootKey, path: copy.manifestPath })
      result.set(winnerId, list)
    }
  }
  return result
}

/** Logical skill ids are root-qualified so two roots can hold the same name. */
function skillIdFor(rootKey: string, name: string, seen: Map<string, number>): string {
  const base = `${rootKey}:${name}`
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}#${String(count + 1)}`
}

/** The live implementation behind `ctx.skills`. */
export class SkillsInventoryImpl implements SkillsInventory {
  protected readonly ctx: Context
  protected readonly state: ManagerState
  protected readonly log: ManagerLog
  private cached: { at: number; workspace?: string; payload: SkillsInventoryPayload } | undefined

  constructor(ctx: Context, state: ManagerState, log: ManagerLog) {
    this.ctx = ctx
    this.state = state
    this.log = log
  }

  /** Drop the short-lived scan cache. */
  invalidate(): void {
    this.cached = undefined
  }

  /** Read both skill lists, their join, provenance and the completeness audit. */
  async scan(options: { refresh?: boolean; workspace?: string } = {}): Promise<SkillsInventoryPayload> {
    const now = Date.now()
    if (options.refresh !== true && this.cached !== undefined
      && this.cached.workspace === options.workspace && now - this.cached.at < SCAN_CACHE_MS) {
      return this.cached.payload
    }
    const started = Date.now()
    const facts = profileFacts(this.ctx)
    if (facts === undefined) return this.emptyPayload(now, ['当前 Host 没有提供 profileContext，无法解析技能根与运行时清单。'])
    const sources: SourceStatus[] = []
    const counts: Record<string, number> = {}
    const notes: string[] = []
    const unexplained: Array<{ id: string; name: string; why: string }> = []
    const settings = readProviderSettings(this.ctx, facts)
    notes.push(...settings.notes)
    const workspace = selectWorkspace(this.ctx, facts, options.workspace)
    for (const item of workspace.diagnostics) notes.push(item.message)
    const resolution = resolveSkillRoots({
      workspacePath: workspace.path,
      dshHome: settings.dshHome,
      userHome: homedir(),
      settings,
      registeredWorkspaces: workspace.others,
      ...(workspace.id === undefined ? {} : { workspace: { id: workspace.id } }),
    })
    for (const item of resolution.diagnostics) notes.push(item.message)
    const lockRead = await readSkillLockFile(settings.agentsHome)
    const lock = lockRead.lock
    const lockEntries = lock === undefined ? 0 : Object.keys(lock.skills).length
    counts.lockEntries = lockEntries
    sources.push({
      id: 'skill-lock',
      label: '技能安装锁文件（skills CLI v3）',
      contributes: 'provenance',
      count: lockEntries,
      complete: lockRead.error === undefined,
      location: lockRead.path,
      ...(lockRead.error === undefined ? {} : { error: lockRead.error }),
    })
    if (!existsSync(lockRead.path)) {
      notes.push(`未找到技能安装锁文件 ${lockRead.path}；由 skills CLI 安装的技能将没有锁文件来源。`)
    }
    sources.push({
      id: 'skill-provider-config',
      label: 'skill-filesystem 运行时配置',
      contributes: 'provenance',
      count: settings.customSkillDirs.length,
      complete: true,
      location: settings.source === 'defaults' ? '（默认值）' : settings.source,
    })
    // Runtime list B is observed first: agent-preset compositions mount their
    // own filesystem provider, which is invisible to the Host-level Loader
    // configuration, so list B reveals skill roots that must be scanned for A.
    const runtimeCatalog = await observeRuntimeCatalog(this.ctx, workspace.path)
    const runtimeNames = new Set(runtimeCatalog.skills.map(summary => summary.name))
    counts.runtimeSkills = runtimeNames.size
    sources.push({
      id: 'skill-runtime',
      label: '运行时技能目录（ctx.skills 快照）',
      contributes: 'skills-runtime',
      count: runtimeNames.size,
      complete: runtimeCatalog.available && runtimeCatalog.complete,
      location: runtimeCatalog.observations.length === 0 ? '（未观察到可用 scope）' : runtimeCatalog.observations.join('、'),
      ...(runtimeCatalog.errors.length === 0 ? {} : { error: runtimeCatalog.errors.join('；') }),
    })
    for (const error of runtimeCatalog.errors) notes.push(error)
    if (!runtimeCatalog.available) {
      notes.push('运行时技能清单不可用；生效关系只能按 DSH 根优先级推断，不能确认实际加载情况。')
    }
    const observed = observeRuntimeRoots(runtimeCatalog, resolution.roots, settings)
    for (const note of observed.notes) notes.push(note)
    counts.runtimeObservedRoots = observed.roots.length
    const allRoots = [...resolution.roots, ...observed.roots]
    // Physical discovery, one root at a time. Findings stay raw here: skills
    // reached through a Junction / symlink alias are collapsed by realpath below
    // so one physical directory never produces two records.
    const discoveredRoots: RootFinding[] = []
    const candidates: DiscoveredCandidate[] = []
    const seenIds = new Map<string, number>()
    for (const root of allRoots) {
      const exists = existsSync(root.path)
      const discovery = await discoverRoot(root)
      for (const item of discovery.diagnostics.filter(entry => entry.level !== 'info')) {
        this.log.warn('skills.invalid-entry', { path: item.detail?.path ?? root.path, code: item.code, message: item.message })
        if (unexplained.length < 25) {
          const pathText = typeof item.detail?.path === 'string' ? item.detail.path : root.path
          unexplained.push({ id: `invalid:${skillPathKey(pathText)}`, name: pathText.split(/[\\/]/u).pop() ?? pathText, why: item.message })
        }
      }
      discoveredRoots.push({ root, skills: discovery.skills, diagnostics: discovery.diagnostics, complete: discovery.complete, exists })
      for (const discovered of discovery.skills) {
        candidates.push({ root, discovered, id: skillIdFor(root.key, discovered.name, seenIds) })
      }
    }
    const orderedCandidates: OrderedCandidate[] = candidates.map(candidate => ({
      ...candidate,
      name: candidate.discovered.name,
      rootKey: candidate.root.key,
      ...(candidate.root.rank === undefined ? {} : { rank: candidate.root.rank }),
      managed: candidate.root.managed,
      synthetic: candidate.root.synthetic === true,
      realPath: candidate.discovered.realPath,
      manifestPath: candidate.discovered.manifestPath,
      dir: candidate.discovered.dir,
      layout: candidate.discovered.layout,
    }))
    const deduped = dedupePhysicalCopies(orderedCandidates)
    const aliasGroups = new Map<string, OrderedCandidate[]>()
    for (const entry of deduped.dropped) {
      const group = aliasGroups.get(entry.keptBy.id) ?? []
      group.push(entry.copy)
      aliasGroups.set(entry.keptBy.id, group)
      notes.push(`技能别名去重：${entry.copy.manifestPath}（根 ${entry.copy.rootKey}）与 ${entry.keptBy.manifestPath} 指向同一真实目录（${entry.keptBy.dir}），只计一次。`)
    }
    if (deduped.dropped.length > 0) counts.aliasCopies = deduped.dropped.length
    const keptByRoot = new Map<string, OrderedCandidate[]>()
    for (const candidate of deduped.kept) {
      const group = keptByRoot.get(candidate.root.key) ?? []
      group.push(candidate)
      keptByRoot.set(candidate.root.key, group)
    }
    // A runtime-derived root that only contributed aliases of configured roots
    // must not show up as an extra, misleading root.
    const findings: RootFinding[] = []
    for (const finding of discoveredRoots) {
      const kept = keptByRoot.get(finding.root.key) ?? []
      if (finding.root.synthetic === true && kept.length === 0) {
        notes.push(`运行时观察到的技能根「${finding.root.path}」只包含已由常规根扫描到的 Junction/符号链接别名（realpath 去重），未作为独立根重复计入。`)
        continue
      }
      findings.push({ ...finding, skills: kept.map(candidate => candidate.discovered) })
    }
    for (const finding of findings) {
      const kept = keptByRoot.get(finding.root.key) ?? []
      sources.push({
        id: `skill-root:${finding.root.key}`,
        label: `技能根 · ${finding.root.label}`,
        contributes: 'skills-physical',
        count: kept.length,
        complete: finding.complete,
        location: finding.root.path,
        ...(finding.complete
          ? {}
          : { error: finding.diagnostics.find(item => item.code === 'skill-root/unreadable')?.message ?? '目录无法完整读取' }),
      })
      counts[`root.${finding.root.key}`] = kept.length
    }
    const invalidEntries = unexplained.filter(item => item.id.startsWith('invalid:')).length
    counts.invalidEntries = invalidEntries
    counts.roots = findings.length
    counts.managedRoots = findings.filter(finding => finding.root.managed).length
    counts.unmanagedRoots = findings.filter(finding => !finding.root.managed).length
    counts.customSkillDirs = settings.customSkillDirs.length
    // Only roots actually kept after alias de-duplication are reported.
    counts.runtimeObservedRoots = findings.filter(finding => finding.root.synthetic === true).length
    // Prepare every de-duplicated physical copy.
    const agentsSkillsDir = canonicalPath(join(settings.agentsHome, 'skills'))
    const prepared: PreparedCopy[] = []
    const identities: PhysicalSkillIdentity[] = []
    let notManaged = 0
    const gitRoots = new Set<string>()
    for (const candidate of deduped.kept) {
      const { root, discovered, id } = candidate
      const aliases = aliasGroups.get(id) ?? []
      const association = this.state.skillSource(`skill:${id}`)
      // The lock file records installs under `<AGENTS_HOME>/skills`; a copy is
      // covered by it only when its discovery root is exactly that directory.
      const lockApplies = root.managed && samePath(canonicalPath(root.path), agentsSkillsDir)
      const lockEntry = lockApplies ? findSkillLockEntry(lock, discovered.name) : undefined
      const git = readGitRepository(discovered.dir)
      if (git !== undefined) gitRoots.add(git.root)
      const needsTreeHash = root.managed || association !== undefined || lockEntry !== undefined
      const tree = needsTreeHash
        ? await computeSkillFolderTreeSha(discovered.dir, { maxFiles: 2000 })
        : { sha: '', files: 0, bytes: 0, fileHashes: {} as Record<string, string> }
      let currentTree = tree.error === undefined && tree.sha !== '' ? tree.sha : undefined
      if (git !== undefined && root.managed) {
        const subdir = relativePosix(git.root, discovered.dir)
        const head = await readGitHeadTree(git.root, subdir)
        if (head.sha !== undefined) currentTree = head.sha
      }
      const provenance = buildSource({
        root,
        discovered,
        ...(association === undefined ? {} : { association }),
        ...(lockEntry === undefined ? {} : { lockEntry }),
        ...(git === undefined ? {} : { git }),
        ...(currentTree === undefined ? {} : { currentTree }),
      })
      const checked = this.state.check(`skill:${id}`)
      const baselineRecordedAt = lockEntry?.updatedAt ?? lockEntry?.installedAt ?? association?.confirmedAt
      const localModification = await resolveLocalModification({
        root,
        discovered,
        ...(association === undefined ? {} : { association }),
        ...(lockEntry === undefined ? {} : { lockEntry }),
        ...(git === undefined ? {} : { git }),
        ...(currentTree === undefined ? {} : { currentTree }),
        // The latest check's upstream tree lets a manager-updated copy show
        // clean even though the lock file still records the older baseline.
        ...(checked?.availableTree === undefined ? {} : { remoteTree: checked.availableTree }),
        ...(baselineRecordedAt === undefined ? {} : { baselineRecordedAt }),
      })
      if (!root.managed) notManaged += 1
      const diagnostics: Diagnostic[] = []
      if (!root.managed) {
        diagnostics.push({
          level: 'info',
          code: 'skill/unmanaged-root',
          message: `位于 DSH 未托管目录（${root.label}），当前 DSH 不会加载该副本。`,
          detail: { path: discovered.manifestPath, rootKey: root.key },
        })
      }
      if (tree.error !== undefined) {
        diagnostics.push({
          level: 'warning',
          code: 'skill/hash-failed',
          message: `无法计算技能目录哈希：${tree.error}`,
          detail: { path: discovered.dir },
        })
      }
      if (localModification.state === 'modified') {
        diagnostics.push({
          level: 'warning',
          code: 'skill/local-modified',
          message: localModification.detail ?? '本地技能内容与记录基线不一致',
          detail: { path: discovered.dir },
        })
      }
      if (aliases.length > 0) {
        diagnostics.push(...describePhysicalAliases({ winner: candidate, aliases }))
      }
      const identity: PhysicalSkillIdentity = {
        id,
        name: discovered.name,
        rootKey: root.key,
        ...(root.rank === undefined ? {} : { rank: root.rank }),
        managed: root.managed,
        realPath: discovered.realPath,
        manifestPath: discovered.manifestPath,
        dir: discovered.dir,
      }
      identities.push(identity)
      prepared.push({
        root,
        discovered,
        id,
        identity,
        source: provenance.source,
        localModification,
        diagnostics,
        invocation: {
          model: discovered.invocation.modelInvocable,
          user: discovered.invocation.userInvocable,
        },
        ...(git === undefined ? {} : { git }),
        ...(currentTree === undefined ? {} : { currentTree }),
        ...(checked === undefined ? {} : { cached: checked }),
        ...(aliases.length === 0
          ? {}
          : {
              aliasPaths: aliases.map(alias => alias.manifestPath),
              aliasRootKeys: aliases.map(alias => alias.rootKey),
            }),
        canCheck: provenance.canCheck,
        ...(provenance.updateBlockedReason === undefined ? {} : { updateBlockedReason: provenance.updateBlockedReason }),
      })
    }
    counts.gitRepositories = gitRoots.size
    if (gitRoots.size > 0) {
      sources.push({
        id: 'skill-git-repositories',
        label: '技能所在 Git 仓库',
        contributes: 'provenance',
        count: gitRoots.size,
        complete: true,
        location: [...gitRoots].slice(0, 5).join('、'),
      })
    }
    // Static precedence is still computed: it is the honest fallback when the
    // runtime catalog cannot be observed and it explains shadowing.
    const overrides = resolvePhysicalOverrides(identities)
    const link = linkRuntimeCatalog(identities, runtimeCatalog)
    const runtimeAvailable = runtimeCatalog.available
    const effectiveSet = runtimeAvailable ? link.effective : overrides.effective
    const loadedSet = runtimeAvailable ? link.loaded : new Set<string>()
    const shadowedBy = runtimeAvailable ? link.shadowedBy : overrides.shadowedBy
    const overriddenCopies = runtimeAvailable
      ? computeOverriddenCopies(identities, effectiveSet)
      : overrides.overriddenCopies
    const runtimeProviderByPath = new Map<string, string>()
    for (const summary of runtimeCatalog.skills) {
      if (summary.path === undefined || summary.path === '') continue
      runtimeProviderByPath.set(skillPathKey(summary.path), summary.provider ?? 'unknown')
    }
    const records: SkillRecord[] = []
    for (const copy of prepared) {
      const effective = effectiveSet.has(copy.id)
      const loaded = loadedSet.has(copy.id)
      const shadow = shadowedBy.get(copy.id)
      const overridden = overriddenCopies.get(copy.id)
      const cached = copy.cached
      const version = buildVersion({
        ...(cached === undefined ? {} : { cached }),
        canCheck: copy.canCheck,
        ...(copy.currentTree === undefined ? {} : { currentTree: copy.currentTree }),
        ...(copy.git === undefined ? {} : { git: copy.git }),
      })
      const diagnostics = [...copy.diagnostics]
      if (runtimeAvailable) diagnostics.push(...diagnosticsForCopy(link.diagnostics, copy.identity))
      else diagnostics.push(...diagnosticsForCopy(overrides.diagnostics, copy.identity))
      if (runtimeAvailable && copy.root.managed && !effective && shadow === undefined) {
        diagnostics.push({
          level: 'info',
          code: 'skill/not-loaded',
          message: '已安装在该技能根中，但运行时清单没有含它的生效技能（可能因同名技能被更高优先级覆盖或该工作区未激活）。',
          detail: { path: copy.discovered.manifestPath, rootKey: copy.root.key },
        })
        if (unexplained.length < 25) {
          unexplained.push({
            id: copy.id,
            name: copy.discovered.name,
            why: '已安装在托管技能根中，但运行时技能清单没有把它作为生效技能（工作区未激活或同名被覆盖）。',
          })
        }
      }
      const provider = runtimeProviderByPath.get(skillPathKey(copy.identity.realPath))
        ?? (copy.root.managed ? settings.providerName : undefined)
      const actions: RecordActions = {
        canCheck: copy.canCheck,
        canUpdate: copy.canCheck,
        ...(copy.canCheck ? {} : { updateBlockedReason: copy.updateBlockedReason ?? '没有可核对的远端来源' }),
        ...(copy.localModification.state === 'modified' ? { requiresConfirmation: true } : {}),
        canToggle: false,
        toggleBlockedReason: TOGGLE_BLOCKED_REASON,
      }
      // An aliased copy (Junction / symlink) keeps its lexical install path so
      // the user sees where the entry lives; `resolvedPath` names the real
      // directory the inventory hashed and de-duplicated against.
      const aliased = copy.aliasPaths !== undefined && copy.aliasPaths.length > 0
      const paths = aliased
        ? {
            installDir: copy.discovered.lexicalDir,
            manifestPath: copy.discovered.manifestPath,
            resolvedPath: copy.discovered.dir,
            rootDir: copy.root.path,
          }
        : {
            installDir: copy.discovered.dir,
            manifestPath: copy.discovered.manifestPath,
            rootDir: copy.root.path,
          }
      records.push({
        id: copy.id,
        kind: 'skill',
        name: copy.discovered.name,
        displayName: copy.discovered.name,
        description: copy.discovered.description,
        version,
        source: copy.source,
        runtime: {
          installed: true,
          loaded,
          ...(runtimeAvailable && runtimeCatalog.complete ? {} : { catalogIncomplete: true }),
        },
        scope: copy.root.managed ? 'current-profile' : 'filesystem',
        rootKey: copy.root.key,
        ...(copy.root.rank === undefined ? {} : { rootRank: copy.root.rank }),
        ...(copy.root.note === undefined ? {} : { rootNote: copy.root.note }),
        layout: copy.discovered.layout,
        paths,
        ...(provider === undefined ? {} : { provider }),
        effective,
        ...(shadow === undefined ? {} : { shadowedBy: shadow }),
        ...(overridden === undefined || overridden.length === 0 ? {} : { overriddenCopies: overridden }),
        invocation: copy.invocation,
        localModification: copy.localModification,
        diagnostics,
        actions,
      })
    }
    records.sort(compareSkillRecords)
    // Runtime-only skills: virtual/plugin-registered ones, or filesystem skills
    // whose directory is outside every scanned root.
    const virtual: VirtualSkillRecord[] = []
    for (const summary of link.virtual) {
      const path = summary.path
      const installDir = path === undefined ? undefined : dirname(path)
      const existsOnDisk = installDir !== undefined && existsSync(installDir)
      const outsideRoots = path !== undefined && existsOnDisk
      virtual.push({
        id: `virtual:${summary.provider ?? 'unknown'}:${summary.name}`,
        kind: 'skill',
        name: summary.name,
        displayName: summary.name,
        description: summary.description,
        version: {
          status: 'no-source',
          reason: path === undefined
            ? '虚拟技能没有磁盘文件，也就没有可核对的安装来源'
            : '该技能目录不在管理器扫描的技能根中，没有可核对的安装来源',
        },
        source: {
          kind: summary.provider === 'runtime' ? 'bundled' : 'unknown',
          trust: 'unknown',
          label: summary.provider === 'runtime' ? '运行时注册技能' : `运行时 Provider · ${summary.provider ?? '未知'}`,
          detail: path === undefined
            ? '该技能由插件在运行时直接注册，没有物理 SKILL.md'
            : outsideRoots
              ? '该技能来自扫描范围之外的文件系统目录，管理器不会修改它'
              : '运行时清单报告了该技能，但其路径当前不存在',
        },
        runtime: {
          installed: existsOnDisk,
          loaded: true,
          ...(runtimeCatalog.complete ? {} : { catalogIncomplete: true }),
        },
        scope: summary.provider === 'filesystem' ? 'filesystem' : 'current-profile',
        rootKey: `virtual:${summary.provider ?? 'unknown'}`,
        layout: 'virtual',
        paths: {
          ...(installDir === undefined ? {} : { installDir }),
          ...(path === undefined ? {} : { manifestPath: path }),
        },
        ...(summary.provider === undefined ? {} : { provider: summary.provider }),
        effective: true,
        invocation: {
          model: summary.invocation.modelInvocable,
          user: summary.invocation.userInvocable,
        },
        localModification: {
          state: 'unknown',
          detail: path === undefined ? '运行时注册技能没有物理文件' : '不在管理器扫描根中，无法建立本地修改基线',
        },
        diagnostics: [{
          level: 'info',
          code: 'skill/virtual',
          message: path === undefined
            ? '这是运行时注册的虚拟技能，没有物理副本。'
            : outsideRoots
              ? '该技能目录不在管理器扫描的技能根中，仅按运行时观察展示。'
              : '运行时清单报告了该技能，但其磁盘路径当前不存在。',
          ...(path === undefined ? {} : { detail: { path } }),
        }],
        actions: {
          canCheck: false,
          canUpdate: false,
          updateBlockedReason: '虚拟/未扫描技能没有可核对的物理来源',
          canToggle: false,
          toggleBlockedReason: TOGGLE_BLOCKED_REASON,
        },
      })
    }
    counts.physical = records.length
    counts.virtualSkills = virtual.length
    counts.effective = records.filter(record => record.effective).length
    counts.shadowed = records.filter(record => record.shadowedBy !== undefined).length
    counts.notManaged = notManaged
    counts.checksCached = Object.keys(this.state.get().checks).length
    const stats: SkillStats = {
      physical: records.length,
      runtime: runtimeNames.size,
      effective: records.filter(record => record.effective).length,
      shadowed: records.filter(record => record.shadowedBy !== undefined).length,
      notManaged,
      updatesAvailable: records.filter(record => record.version.status === 'update-available').length,
      abnormal: records.filter(record => record.diagnostics.some(item => item.level !== 'info')
        || record.version.status === 'network-error' || record.version.status === 'check-failed').length,
    }
    const reconciliation: Reconciliation = {
      complete: runtimeCatalog.available && runtimeCatalog.complete
        && lockRead.error === undefined
        && findings.every(finding => finding.complete),
      scannedAt: new Date(now).toISOString(),
      durationMs: Date.now() - started,
      sources,
      counts,
      unexplained,
      notes,
    }
    const lastCheckAt = this.state.get().settings.lastCheckAt?.skills
    const payload: SkillsInventoryPayload = {
      workspace: {
        path: workspace.path,
        ...(workspace.id === undefined ? {} : { id: workspace.id }),
        ...(workspace.name === undefined ? {} : { name: workspace.name }),
      },
      roots: findings.map(finding => {
        const invalidCount = finding.diagnostics.filter(item => item.level !== 'info').length
        const unreadable = finding.diagnostics.find(item => item.code === 'skill-root/unreadable')
        return {
          key: finding.root.key,
          label: finding.root.label,
          path: finding.root.path,
          ...(finding.root.rank === undefined ? {} : { rank: finding.root.rank }),
          managed: finding.root.managed,
          exists: finding.exists,
          complete: finding.complete && invalidCount === 0,
          ...(unreadable !== undefined
            ? { error: unreadable.message }
            : invalidCount > 0 ? { error: `${String(invalidCount)} 个技能条目无法解析` } : {}),
          count: finding.skills.length,
        }
      }),
      physical: records,
      virtual,
      stats,
      reconciliation,
      check: {
        running: false,
        ...(lastCheckAt === undefined ? {} : { lastRunAt: lastCheckAt }),
      },
    }
    this.cached = { at: now, ...(options.workspace === undefined ? {} : { workspace: options.workspace }), payload }
    return payload
  }

  /**
   * Verify and persist a user-confirmed repository source for one skill copy.
   * Verification resolves the remote folder tree once and compares it with the
   * locally computed baseline; a network failure still records the association
   * (marked unverified) so the user does not lose their input.
   */
  async associateSource(input: {
    id: string
    url: string
    ref?: string
    subdir?: string
    baseline?: { version?: string; commit?: string; tree?: string }
  }): Promise<{ record?: SkillRecord; task?: import('../../shared/types').TaskState; error?: string }> {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (id === '') return { error: '缺少技能记录 id' }
    const repository = parseGitHubRepository(input.url)
    if (repository === undefined) return { error: '只接受 GitHub 仓库地址（例如 https://github.com/owner/repo）' }
    const inventory = await this.scan({ refresh: true })
    const record = inventory.physical.find(item => item.id === id)
    if (record === undefined) return { error: '找不到该技能副本；可能已移动或清单已变化，请刷新后重试' }
    const installDir = record.paths.installDir
    if (installDir === undefined) return { error: '该技能记录没有物理目录，无法建立来源基线' }
    const computed = await computeSkillFolderTreeSha(installDir)
    if (computed.error !== undefined) return { error: `无法读取技能目录计算基线：${computed.error}` }
    const localGit = readGitRepository(installDir)
    let subdir = input.subdir === undefined ? undefined : input.subdir.replaceAll('\\', '/').replace(/^\/+|\/+$/gu, '')
    if (subdir === undefined) {
      subdir = localGit === undefined ? '' : relativePosix(localGit.root, installDir)
    }
    const remote = await verifyRemoteSkillFolder({
      repository,
      subdir,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      expectedTree: computed.sha,
      timeoutMs: 10_000,
    })
    const association: SkillSourceAssociation = {
      recordId: `skill:${id}`,
      url: normalizeGitHubUrl(repository),
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(subdir === '' ? {} : { subdir }),
      confirmedAt: new Date().toISOString(),
      baseline: {
        tree: computed.sha,
        ...(localGit?.commit === undefined ? {} : { commit: localGit.commit }),
        ...(record.version.current === undefined ? {} : { version: record.version.current }),
      },
      verified: remote.ok,
      detail: remote.message,
    }
    await this.state.setSkillSource(association)
    this.invalidate()
    this.log.info('skills.source-associated', { id, url: association.url, subdir, verified: remote.ok })
    const refreshed = await this.scan({ refresh: true })
    const updated = refreshed.physical.find(item => item.id === id) ?? record
    return { record: updated }
  }

  /** Payload used when the Host has no profile context (management disabled). */
  private emptyPayload(now: number, notes: string[]): SkillsInventoryPayload {
    const reconciliation: Reconciliation = {
      complete: false,
      scannedAt: new Date(now).toISOString(),
      durationMs: 0,
      sources: [],
      counts: {},
      unexplained: [],
      notes,
    }
    return {
      roots: [],
      physical: [],
      virtual: [],
      stats: emptyStats(),
      reconciliation,
      check: { running: false },
    }
  }
}

/** Sort managed copies first (by rank), then non-managed, then by name. */
function compareSkillRecords(left: SkillRecord, right: SkillRecord): number {
  const leftManaged = left.scope !== 'filesystem' ? 0 : 1
  const rightManaged = right.scope !== 'filesystem' ? 0 : 1
  if (leftManaged !== rightManaged) return leftManaged - rightManaged
  const rankDiff = (left.rootRank ?? Number.MAX_SAFE_INTEGER) - (right.rootRank ?? Number.MAX_SAFE_INTEGER)
  if (rankDiff !== 0) return rankDiff
  return left.name.localeCompare(right.name)
}
