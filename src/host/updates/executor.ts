/**
 * Update planning and execution: the durable, reversible transaction engine.
 *
 * One update is a state machine persisted in the manager's state file after
 * every step:
 *
 *   PREFLIGHT → BACKUP → DOWNLOAD → STAGE → INSTALL → VALIDATE
 *              → PENDING_RESTART / VERIFIED
 *   any failure → FAILED → RECOVERY → RECOVERED / RECOVERY_REQUIRED
 *
 * Design invariants (each one is enforced here, not assumed):
 *   - A pnpm/plugin-manager exit code of 0 is not success: VALIDATE re-reads
 *     `listBundles()` and compares the recorded version and enablement.
 *   - The live install directory and the profile manifest files are copied and
 *     hash-verified before anything destructive starts; recovery restores and
 *     re-verifies from that offline copy.
 *   - The extension manager never updates itself automatically.
 *   - Write actions run through one process-wide serial queue, so two updates
 *     (from two browser tabs, or a batch plus a manual click) never overlap.
 *   - Cancellation is cooperative: an abort observed before INSTALL abandons
 *     the transaction untouched; an abort that arrives while INSTALL is already
 *     running is reported as "too late" and the item is validated to the end
 *     instead of leaving a half-replaced installation behind.
 *   - A crash leaves a non-terminal transaction on disk; {@link UpdateExecutor.recover}
 *     reconciles it at startup (verify pending restarts, restore from backup
 *     when the destructive step had started, abandon otherwise).
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import semver from 'semver'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {
  BundleInfo,
  ChangeResult,
  InstallBundleOptions,
  PluginManager,
} from '@deepseek-ai/dsh-plugin-manager'
import type {
  ExtensionKind,
  HistoryEntry,
  LocalModificationInfo,
  PluginBundleRecord,
  SkillRecord,
  TransactionPhase,
  TransactionRecord,
  UpdatePlan,
  UpdatePlanEntry,
} from '../../shared/types'
import type { HostServices, UpdateManager } from '../contracts'
import { resolvePackageDirectory, runtimeVersion, SELF_PACKAGE_NAME } from '../env'
import { managementErrorText } from '../inventory/plugins'
import { errorText } from '../logs'
import type { CheckCacheEntry } from '../state'
import {
  BackupManager,
  checkAccess,
  compareTreeManifests,
  containsSymlink,
  ensureDirectory,
  formatBytes,
  hashTree,
  measureDirectory,
  messageOf,
  moveTree,
  readFreeBytes,
  removeTree,
  resolveInside,
  sha256Hex,
  writeFileAtomicSafe,
  type BackupResult,
  type TreeManifest,
} from './backup.js'
import {
  archiveRoot,
  compareExtractedFiles,
  downloadGithubArchive,
  entriesUnder,
  extractArchive,
  gitTreeHashForEntries,
  parseGithubRepo,
  readNpmTarball,
  readSkillDocument,
  readTarArchive,
  type NpmTarball,
} from './tarball.js'
import { parseLockfileGitResolution } from './gitClient.js'
import {
  downloadTarball,
  evaluatePluginCompatibility,
  fetchNpmDocument,
  manifestOf,
  registryPolicy,
  tarballUrlOf,
  type FetchNpmDocumentOptions,
  type NpmDocument,
  type NpmDocumentOutcome,
  type NpmRegistryPolicy,
  type NpmVersionManifest,
} from './npmClient.js'

/** Safety bound on one update's staging extraction (npm tarball or GitHub archive). */
const MAX_DOWNLOAD_BYTES = 192 * 1024 * 1024
/** Bounds for registry lookups and downloads performed by the executor itself. */
const PACKUMENT_TIMEOUT_MS = 15_000
const TARBALL_TIMEOUT_MS = 60_000
const ARCHIVE_TIMEOUT_MS = 60_000
/** Minimum headroom the preflight insists on before writing (backup + extraction + replacement). */
const MIN_FREE_BYTES = 64 * 1024 * 1024
/** Plan-stage local-modification comparisons are cached briefly; plan() is polled by the UI. */
const PLAN_MODIFICATION_CACHE_TTL_MS = 60_000
const PLAN_MODIFICATION_CACHE_MAX = 64
const PLAN_LOOKUP_TIMEOUT_MS = 8_000
/** Backup retention and stale staging bounds enforced by maintain(). */
const BACKUP_RETENTION = 20
const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Filesystem noise that must not be reported as a local modification. */
const IGNORED_LOCAL_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** Extra audit detail attached to one transaction step (JSON-safe). */
export type TransactionStepDetail = Record<string, unknown>

/** Sink for persisted transaction records (`ManagerState` satisfies it). */
export interface UpdateTransactionSink {
  putTransaction(record: TransactionRecord): Promise<void>
}

/** Fields required to start one update transaction. */
export interface UpdateTransactionStart {
  id?: string
  kind: ExtensionKind
  extensionId: string
  name: string
  targetVersion?: string
  previousVersion?: string
}

/** Allowed phase transitions; anything else is a programming error, not a state. */
export const TRANSACTION_TRANSITIONS: Readonly<Record<TransactionPhase, readonly TransactionPhase[]>> = {
  PREFLIGHT: ['BACKUP', 'FAILED', 'RECOVERED'],
  BACKUP: ['DOWNLOAD', 'FAILED', 'RECOVERED'],
  DOWNLOAD: ['STAGE', 'FAILED', 'RECOVERED'],
  STAGE: ['INSTALL', 'FAILED', 'RECOVERED'],
  INSTALL: ['VALIDATE', 'FAILED'],
  VALIDATE: ['PENDING_RESTART', 'VERIFIED', 'FAILED'],
  PENDING_RESTART: ['VERIFIED', 'FAILED', 'RECOVERY'],
  VERIFIED: [],
  FAILED: ['RECOVERY', 'RECOVERED'],
  RECOVERY: ['RECOVERED', 'RECOVERY_REQUIRED'],
  RECOVERED: [],
  RECOVERY_REQUIRED: [],
}

/** A persisted transaction with an audit-trail API; every mutation also writes state. */
export class UpdateTransaction {
  readonly record: TransactionRecord
  private readonly sink: UpdateTransactionSink

  constructor(sink: UpdateTransactionSink, start: UpdateTransactionStart, existing?: TransactionRecord) {
    this.sink = sink
    if (existing !== undefined) {
      this.record = { ...existing, steps: existing.steps.map(step => ({ ...step })) }
      return
    }
    const now = new Date().toISOString()
    this.record = {
      id: start.id ?? randomUUID(),
      kind: start.kind,
      extensionId: start.extensionId,
      name: start.name,
      phase: 'PREFLIGHT',
      startedAt: now,
      updatedAt: now,
      steps: [{ at: now, phase: 'PREFLIGHT', message: '创建更新事务' }],
      ...(start.targetVersion === undefined ? {} : { targetVersion: start.targetVersion }),
      ...(start.previousVersion === undefined ? {} : { previousVersion: start.previousVersion }),
    }
  }

  /** Write the current record once (persists a freshly created transaction). */
  async save(): Promise<void> {
    await this.sink.putTransaction(this.snapshot())
  }

  /** Move to the next phase and append one audit line. */
  async setPhase(phase: TransactionPhase, message: string, detail?: TransactionStepDetail): Promise<void> {
    const allowed = TRANSACTION_TRANSITIONS[this.record.phase]
    if (!allowed.includes(phase)) {
      throw new Error(`非法的更新事务状态迁移：${this.record.phase} → ${phase}`)
    }
    this.record.phase = phase
    this.record.updatedAt = new Date().toISOString()
    this.pushStep(phase, message, detail)
    await this.sink.putTransaction(this.snapshot())
  }

  /** Append an audit line without changing the phase. */
  async note(message: string, detail?: TransactionStepDetail): Promise<void> {
    this.record.updatedAt = new Date().toISOString()
    this.pushStep(this.record.phase, message, detail)
    await this.sink.putTransaction(this.snapshot())
  }

  /** Persist the descriptive (non-phase) fields without appending a step. */
  async patch(patch: Partial<Pick<TransactionRecord, 'backupDir' | 'needsRestart' | 'result' | 'error' | 'rolledBack'>>): Promise<void> {
    if (patch.backupDir !== undefined) this.record.backupDir = patch.backupDir
    if (patch.needsRestart !== undefined) this.record.needsRestart = patch.needsRestart
    if (patch.result !== undefined) this.record.result = patch.result
    if (patch.error !== undefined) this.record.error = patch.error
    if (patch.rolledBack !== undefined) this.record.rolledBack = patch.rolledBack
    this.record.updatedAt = new Date().toISOString()
    await this.sink.putTransaction(this.snapshot())
  }

  /** Move to FAILED and record the error. */
  async fail(message: string, detail?: TransactionStepDetail): Promise<void> {
    await this.setPhase('FAILED', message, detail)
    await this.patch({ error: message, result: message })
  }

  /** Copy of the record safe to persist / hand to other code. */
  snapshot(): TransactionRecord {
    return {
      ...this.record,
      steps: this.record.steps.map(step => ({
        ...step,
        ...(step.detail === undefined ? {} : { detail: { ...step.detail } }),
      })),
    }
  }

  private pushStep(phase: TransactionPhase, message: string, detail?: TransactionStepDetail): void {
    const at = new Date().toISOString()
    this.record.steps.push({
      at,
      phase,
      message,
      ...(detail === undefined ? {} : { detail: { ...detail } }),
    })
    this.record.updatedAt = at
  }
}

/** Network port of the executor, injectable so transaction tests need no HTTP. */
export interface NpmNetwork {
  registryPolicy(ctx: Context): Promise<NpmRegistryPolicy>
  fetchNpmDocument(name: string, options: FetchNpmDocumentOptions): Promise<NpmDocumentOutcome>
  downloadTarball(url: string, options?: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }): Promise<Uint8Array>
}

/** Default network implementation backed by the shared npm client. */
const DEFAULT_NETWORK: NpmNetwork = {
  registryPolicy: ctx => registryPolicy(ctx),
  fetchNpmDocument: (name, options) => fetchNpmDocument(name, options),
  downloadTarball: (url, options) => downloadTarball(url, options ?? {}),
}

/** Archive download port, injectable so skill transaction tests need no HTTP. */
export interface ArchiveDownloadPort {
  download(repo: string, ref: string, options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }): Promise<Buffer>
}

/** Optional dependencies of {@link UpdateExecutor}; tests override the network and backup root. */
export interface UpdateExecutorDeps {
  network?: NpmNetwork
  backup?: BackupManager
  archive?: ArchiveDownloadPort
}

/** Input accepted by {@link UpdateExecutor.execute} (mirrors the UpdateManager contract). */
export interface UpdateExecuteInput {
  plan: UpdatePlan
  confirmed: boolean
  overwriteLocalModifications: boolean
  taskId: string
  signal: AbortSignal
  /** Workspace directory whose project skill roots should be scanned (client-selected). */
  workspace?: string
}

/** Per-item execution outcome, mapped to task rows and history entries. */
export interface ItemOutcome {
  status: 'ok' | 'failed' | 'skipped' | 'rolled-back' | 'recovery-required'
  message: string
  transactionId: string
  fromVersion?: string
  toVersion?: string
  needsRestart?: boolean
  /** True when the batch should stop after this item (cancellation or too-late abort). */
  stopBatch?: boolean
}

/** Context passed to the plan decision helpers; keeps them pure and testable. */
export interface PlanDecisionContext {
  hmrEnabled: boolean
  /** True when the caller named the record explicitly, so "nothing to update" is worth reporting. */
  requested: boolean
}

/** Error category: the record must not be updated (a refusal, not a system failure). */
class PreflightBlockedError extends Error {
  readonly detail: string | undefined

  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'PreflightBlockedError'
    this.detail = detail
  }
}

/** Error category: the user cancelled before anything destructive happened. */
class UpdateAbortedError extends Error {
  constructor(message = '更新已取消') {
    super(message)
    this.name = 'UpdateAbortedError'
  }
}

/** Process-wide install queue: one destructive plugin/skill action at a time. */
let writeChain: Promise<unknown> = Promise.resolve()

/** Run `operation` after every previously queued write action has settled. */
export function withInstallLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = writeChain.then(operation, operation)
  writeChain = next.then(() => undefined, () => undefined)
  return next
}

/** Whether one cached check status means "an update is worth planning". */
function isCandidateStatus(status: CheckCacheEntry['status'] | undefined): boolean {
  return status === 'update-available'
    || status === 'prerelease-only'
    || status === 'local-modified'
    || status === 'incompatible-update'
}

/** Chinese text for the compatibility requirements recorded by a check. */
function describeRequirements(requirements: Record<string, string> | undefined): string {
  if (requirements === undefined) return ''
  const entries = Object.entries(requirements)
  if (entries.length === 0) return ''
  return `（${entries.map(([name, range]) => `${name} ${range}`).join('；')}）`
}

/** The forms pnpm resolves through a git host (mirrors the plugin manager's parser). */
const GIT_SPEC_BASE = /^(?:github|gitlab|bitbucket|gist):|^git(?:\+[a-z]+)?:\/\/|^git@[^:]+:|^https?:\/\/[^/]+\/[^/]+\/[^/#]+(?:\.git)?$/iu

/**
 * Build the install spec for a git-backed bundle update: the recorded origin
 * with its ref fragment replaced by the target commit. Returns `undefined`
 * when the recorded spec is not a git spec pnpm would accept.
 */
export function buildGitTargetSpec(record: PluginBundleRecord, commit: string): string | undefined {
  const raw = record.source.spec ?? record.source.url
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const hashAt = trimmed.indexOf('#')
  const base = (hashAt === -1 ? trimmed : trimmed.slice(0, hashAt)).replace(/\/+$/u, '')
  if (base === '' || !GIT_SPEC_BASE.test(base)) return undefined
  return `${base}#${commit}`
}

/** Run `operation` over `items` with at most `limit` promises in flight. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next
      next += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await operation(item)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Merge a plan-stage local-modification answer into one plan entry. A clean
 * answer keeps the entry as it is; a modified or unknown answer downgrades it
 * to a confirmation-only entry with a Chinese explanation.
 */
export function applyPlanLocalModification(entry: UpdatePlanEntry, modification: LocalModificationInfo): UpdatePlanEntry {
  if (modification.state === 'clean') return entry
  const count = modification.files?.length ?? 0
  const sample = modification.files === undefined || modification.files.length === 0
    ? ''
    : `：${modification.files.slice(0, 5).join('、')}${count > 5 ? ' 等' : ''}`
  const reason = modification.state === 'modified'
    ? `检测到本地修改（${String(count)} 个文件${sample}），更新将覆盖这些修改；更新前会自动备份到扩展管理器备份目录，可恢复。`
    : `无法核对本地修改（${modification.detail ?? '网络不可用'}），更新可能覆盖本地修改；更新前会自动备份到扩展管理器备份目录，可恢复。`
  const risk = entry.risk === undefined || entry.risk === '' ? reason : `${entry.risk}${reason}`
  return {
    ...entry,
    eligible: false,
    requiresConfirmation: true,
    risk,
  }
}

/** Build the base plan entry shared by plugin and skill decisions. */
function planEntryBase(input: {
  id: string
  kind: ExtensionKind
  name: string
  displayName: string
  sourceLabel: string
  currentVersion?: string
  targetVersion?: string
  needsRestart: boolean
}): UpdatePlanEntry {
  return {
    id: input.id,
    kind: input.kind,
    name: input.name,
    displayName: input.displayName,
    sourceLabel: input.sourceLabel,
    eligible: false,
    requiresConfirmation: false,
    needsRestart: input.needsRestart,
    ...(input.currentVersion === undefined ? {} : { currentVersion: input.currentVersion }),
    ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
  }
}

/**
 * Decide what one plugin bundle record contributes to an update plan.
 * Returns `undefined` when the record has no update to plan (and was not
 * explicitly requested); a hard-blocked entry carries `excludedReason`; a
 * confirmation-only entry stays in `entries`.
 */
export function planPluginEntry(
  record: PluginBundleRecord,
  cache: CheckCacheEntry | undefined,
  context: PlanDecisionContext,
): UpdatePlanEntry | undefined {
  const status = cache?.status
  const base = planEntryBase({
    id: record.id,
    kind: 'plugin-bundle',
    name: record.name,
    displayName: record.displayName,
    sourceLabel: record.source.label,
    needsRestart: !context.hmrEnabled,
    ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
    ...(cache?.availableVersion === undefined ? {} : { targetVersion: cache.availableVersion }),
  })
  const excluded = (reason: string): UpdatePlanEntry => ({
    ...base,
    eligible: false,
    requiresConfirmation: false,
    excludedReason: reason,
  })
  const notCandidate = (): UpdatePlanEntry | undefined => {
    if (!context.requested) return undefined
    if (status === undefined || status === 'unchecked') return excluded('尚未检查更新，请先检查')
    if (status === 'up-to-date') return excluded('已是最新版本')
    if (status === 'incompatible-update') return excluded('新版本与当前 DSH 不兼容')
    if (status === 'needs-source' || status === 'no-source') return excluded('安装来源不足以自动更新')
    return excluded('没有可用的更新')
  }
  if (record.self === true || record.name === SELF_PACKAGE_NAME) return excluded('管理器自身不参与自动更新')
  if (!record.actions.canUpdate) return excluded(record.actions.updateBlockedReason ?? '当前安装来源不支持自动更新')
  if (record.source.kind === 'git') {
    if (!isCandidateStatus(status)) return notCandidate()
    if (cache === undefined) return excluded('尚未检查更新，请先检查')
    if (status === 'incompatible-update' || cache.compatibility === 'incompatible') {
      return excluded(`新版本与当前 DSH 不兼容${describeRequirements(cache.compatibilityRequirements)}`)
    }
    const commit = cache.availableCommit
    if (commit === undefined || !/^[0-9a-f]{7,40}$/iu.test(commit)) {
      return excluded('检查结果没有给出可安装的远端提交，请重新检查更新')
    }
    if (buildGitTargetSpec(record, commit) === undefined) {
      return excluded('无法根据当前安装规格构造 Git 更新目标，请手动更新')
    }
    return {
      ...base,
      targetVersion: commit.slice(0, 12),
      eligible: false,
      requiresConfirmation: true,
      risk: 'Git 安装：将按远端 commit 重新安装（先卸载旧版本）；安装脚本的副作用无法完全回滚；更新前会备份安装目录与 Profile 清单，失败时恢复到备份状态。',
    }
  }
  if (record.source.kind !== 'npm') {
    return excluded('当前仅支持 npm Registry 或 Git 安装来源的自动更新（本地来源请手动更新）')
  }
  if (!isCandidateStatus(status)) return notCandidate()
  if (cache === undefined) return excluded('尚未检查更新，请先检查')
  if (status === 'incompatible-update' || cache.compatibility === 'incompatible') {
    return excluded(`新版本与当前 DSH 不兼容${describeRequirements(cache.compatibilityRequirements)}`)
  }
  if (cache.availableVersion === undefined) return excluded('检查结果没有给出目标版本')
  const risks: string[] = ['更新前会备份安装目录与 Profile 清单；先卸载旧版本再安装新版本，失败会自动回滚。']
  if (status === 'local-modified') risks.push('检测到本地修改；确认覆盖会丢失这些修改（仍会先备份）。')
  if (status === 'prerelease-only' || cache.channel === 'prerelease') risks.push('仅有预发布版本可用，可能不稳定。')
  if (cache.compatibility === 'unknown') risks.push('未能确认与当前 DSH 的兼容性。')
  const requiresConfirmation = status === 'local-modified'
    || status === 'prerelease-only'
    || cache.channel === 'prerelease'
    || cache.compatibility === 'unknown'
  return {
    ...base,
    ...(cache.availableVersion === undefined ? {} : { targetVersion: cache.availableVersion }),
    eligible: !requiresConfirmation,
    requiresConfirmation,
    risk: risks.join(''),
  }
}

/**
 * Decide what one physical skill record contributes to an update plan.
 * Skills are replaced directory-by-directory; a repository checkout is never
 * overwritten wholesale.
 */
export function planSkillEntry(
  record: SkillRecord,
  cache: CheckCacheEntry | undefined,
  context: PlanDecisionContext,
): UpdatePlanEntry | undefined {
  const targetVersion = cache?.availableVersion
    ?? (cache?.availableTree === undefined ? undefined : cache.availableTree.slice(0, 12))
    ?? cache?.availableCommit?.slice(0, 12)
  const base = planEntryBase({
    id: record.id,
    kind: 'skill',
    name: record.name,
    displayName: record.displayName,
    sourceLabel: record.source.label,
    needsRestart: false,
    ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
    ...(targetVersion === undefined ? {} : { targetVersion }),
  })
  const excluded = (reason: string): UpdatePlanEntry => ({
    ...base,
    eligible: false,
    requiresConfirmation: false,
    excludedReason: reason,
  })
  if (record.layout !== 'directory') return excluded('平铺单文件技能不支持自动更新')
  if (!record.actions.canUpdate) return excluded(record.actions.updateBlockedReason ?? '该技能来源不支持自动更新')
  const status = cache?.status
  if (!isCandidateStatus(status)) {
    if (!context.requested) return undefined
    if (status === undefined || status === 'unchecked') return excluded('尚未检查更新，请先检查')
    if (status === 'up-to-date') return excluded('已是最新版本')
    if (status === 'no-source' || status === 'needs-source') return excluded('技能来源未经验证，无法自动更新')
    return excluded('没有可用的更新')
  }
  if (cache === undefined) return excluded('尚未检查更新，请先检查')
  if (cache.availableTree === undefined) {
    return excluded(status === 'local-modified'
      ? '远端内容没有变化，没有可应用的更新'
      : '检查结果缺少远端目录树哈希，无法校验内容；请重新检查更新')
  }
  const localModified = record.localModification.state === 'modified'
  const risks: string[] = ['只替换该技能目录，不覆盖所在仓库的其他文件；失败会自动回滚。']
  if (localModified) risks.push('技能目录有本地修改；确认覆盖会丢失这些修改（仍会先备份）。')
  return {
    ...base,
    ...(targetVersion === undefined ? {} : { targetVersion }),
    eligible: !localModified,
    requiresConfirmation: localModified,
    risk: risks.join(''),
  }
}

/** Facts common to both installation modes. */
interface PluginPreflightShared {
  record: PluginBundleRecord
  installDir: string
  profileDir: string
  enabled: boolean
  previousVersion?: string
  compatibilityNote?: string
  localModification: LocalModificationInfo
}

/** Verified metadata needed to install an npm-registry update. */
interface NpmPluginPreflight extends PluginPreflightShared {
  mode: 'npm'
  /** The exact registry version to install. */
  targetVersion: string
  /** Registry asked first; null = pnpm's own configuration. */
  registry: string | null
  targetTarballUrl: string
  targetManifest: NpmVersionManifest
}

/** Verified metadata needed to install a git-commit update. */
interface GitPluginPreflight extends PluginPreflightShared {
  mode: 'git'
  /** Abbreviated commit used in user-facing text. */
  targetVersion: string
  /** Install spec accepted by pnpm (`origin#commit`). */
  installSpec: string
  targetCommit: string
}

type PluginPreflight = NpmPluginPreflight | GitPluginPreflight

/** Verified metadata needed to replace one skill directory. */
interface SkillPreflight {
  record: SkillRecord
  skillDir: string
  rootDir: string
  repo: string
  /** codeload ref: the exact commit when the check knew it, else the recorded ref or HEAD. */
  ref: string
  commit?: string
  subdir: string
  targetVersion: string
  /** GitHub tree SHA the downloaded archive must reproduce. */
  expectedTree: string
}

/** Options shared by the two item runners. */
interface RunOptions {
  overwriteLocalModifications: boolean
  signal: AbortSignal
  /** True when the plan contains more than one entry (history action text). */
  batch: boolean
  /** Workspace directory for project skill roots. */
  workspace?: string
}

/** Plan and execute safe updates for plugins and skills. */
export class UpdateExecutor implements UpdateManager {
  protected readonly services: HostServices
  private readonly network: NpmNetwork
  private readonly archive: ArchiveDownloadPort
  private readonly backup: BackupManager
  private readonly log: HostServices['log']
  /** Plan-stage local-modification answers, keyed `${recordId}:${version}`, 60s TTL. */
  private readonly planModificationCache = new Map<string, { at: number; value: LocalModificationInfo }>()

  constructor(services: HostServices, deps: UpdateExecutorDeps = {}) {
    this.services = services
    this.network = deps.network ?? DEFAULT_NETWORK
    this.archive = deps.archive ?? {
      download: (repo, ref, options) => downloadGithubArchive(repo, ref, options),
    }
    this.backup = deps.backup ?? new BackupManager({
      backupRoot: services.state.paths.backupDir,
      log: services.log,
    })
    this.log = services.log
  }

  /** Build the plan without touching anything. */
  async plan(scope: 'plugins' | 'skills' | 'all', ids?: readonly string[], workspace?: string): Promise<UpdatePlan> {
    const requested = ids === undefined ? undefined : new Set(ids)
    const hmrEnabled = this.hmrEnabled()
    const entries: UpdatePlanEntry[] = []
    const excluded: UpdatePlanEntry[] = []
    if (scope === 'plugins' || scope === 'all') {
      const inventory = await this.services.plugins.scan()
      const candidates: Array<{ record: PluginBundleRecord; cache: CheckCacheEntry; entry: UpdatePlanEntry }> = []
      for (const record of inventory.bundles) {
        if (requested !== undefined && !requested.has(record.id)) continue
        const cache = this.services.state.check(`plugin:${record.id}`)
        const decision = planPluginEntry(record, cache, { hmrEnabled, requested: requested !== undefined })
        if (decision === undefined) continue
        if (decision.excludedReason !== undefined) {
          excluded.push(decision)
          continue
        }
        entries.push(decision)
        // npm candidates are compared against the published tarball of the
        // installed version, so a locally edited package is never silently
        // presented as a safe automatic update.
        if (record.source.kind === 'npm' && cache !== undefined && isCandidateStatus(cache.status)) {
          candidates.push({ record, cache, entry: decision })
        }
      }
      if (candidates.length > 0) {
        const policy = await this.network.registryPolicy(this.services.ctx).catch(() => undefined)
        const answers = await mapWithLimit(candidates, 3, async candidate => ({
          candidate,
          modification: await this.planLocalModification(candidate.record, policy),
        }))
        for (const answer of answers) {
          const index = entries.indexOf(answer.candidate.entry)
          if (index === -1) continue
          entries[index] = applyPlanLocalModification(answer.candidate.entry, answer.modification)
        }
      }
    }
    if (scope === 'skills' || scope === 'all') {
      const inventory = await this.services.skills.scan({ ...(workspace === undefined ? {} : { workspace }) })
      for (const record of inventory.physical) {
        if (requested !== undefined && !requested.has(record.id)) continue
        const cache = this.services.state.check(`skill:${record.id}`)
        const decision = planSkillEntry(record, cache, { hmrEnabled, requested: requested !== undefined })
        if (decision === undefined) continue
        if (decision.excludedReason !== undefined) excluded.push(decision)
        else entries.push(decision)
      }
    }
    return {
      // A scope='all' plan keeps its scope; every entry carries its own kind.
      kind: scope,
      entries,
      excluded,
      createdAt: new Date().toISOString(),
    }
  }

  /**
   * Plan-stage local-modification comparison for one npm candidate: download
   * the published tarball of the installed version and hash-compare it with the
   * install directory. Answers are cached briefly because the Web UI polls
   * plan(); every failure degrades to `unknown`, which is never treated clean.
   */
  private async planLocalModification(
    record: PluginBundleRecord,
    policy: NpmRegistryPolicy | undefined,
  ): Promise<LocalModificationInfo> {
    const currentVersion = record.version.current
    const installDir = record.paths.installDir
    if (installDir === undefined || currentVersion === undefined) {
      return { state: 'unknown', detail: '安装目录或当前版本不可读，无法核对本地修改' }
    }
    const key = `${record.id}:${currentVersion}`
    const cached = this.planModificationCache.get(key)
    if (cached !== undefined && Date.now() - cached.at < PLAN_MODIFICATION_CACHE_TTL_MS) return cached.value
    let value: LocalModificationInfo
    if (policy === undefined) {
      value = { state: 'unknown', detail: '无法确定 Registry 配置，网络可能不可用' }
    } else {
      try {
        const outcome = await this.network.fetchNpmDocument(record.name, {
          policy,
          timeoutMs: PLAN_LOOKUP_TIMEOUT_MS,
        })
        if (outcome.status !== 'ok') {
          value = {
            state: 'unknown',
            detail: outcome.status === 'not-found'
              ? 'Registry 中找不到该包，无法核对本地修改'
              : 'Registry 不可达，无法核对本地修改',
          }
        } else {
          value = await this.detectPluginLocalModification({
            record,
            document: outcome.document,
            installDir,
            signal: AbortSignal.timeout(PLAN_LOOKUP_TIMEOUT_MS + TARBALL_TIMEOUT_MS / 2),
            currentVersion,
          })
        }
      } catch (error) {
        value = { state: 'unknown', detail: `无法核对本地修改：${messageOf(error)}` }
      }
    }
    this.planModificationCache.set(key, { at: Date.now(), value })
    this.trimPlanModificationCache()
    return value
  }

  /** Forget cached plan-stage comparisons for one record (after an update). */
  private invalidatePlanModification(recordId: string): void {
    for (const key of [...this.planModificationCache.keys()]) {
      if (key.startsWith(`${recordId}:`)) this.planModificationCache.delete(key)
    }
  }

  /** Keep the short-lived plan cache bounded. */
  private trimPlanModificationCache(): void {
    while (this.planModificationCache.size > PLAN_MODIFICATION_CACHE_MAX) {
      const oldest = this.planModificationCache.keys().next().value
      if (oldest === undefined) return
      this.planModificationCache.delete(oldest)
    }
  }

  /**
   * Execute a confirmed plan item by item. Every item is one transaction; a
   * failed item is recovered before the next one starts, and the task registry
   * shows per-item progress throughout.
   */
  async execute(input: UpdateExecuteInput): Promise<void> {
    const { plan, confirmed, overwriteLocalModifications, signal } = input
    const tasks = this.services.tasks
    let task = tasks.get(input.taskId)
    if (task === undefined) {
      task = tasks.create({
        kind: plan.entries.length > 1 ? 'batch-update' : 'update',
        scope: plan.kind,
        items: plan.entries.map(entry => ({
          id: entry.id,
          name: entry.displayName,
          ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
          ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        })),
        plan,
      })
      this.log.warn('updates.task-missing', { requestedTaskId: input.taskId, createdTaskId: task.id })
    }
    const taskId = task.id
    tasks.start(taskId)
    const transactionIds: string[] = []
    const outcomes: ItemOutcome[] = []
    let cancelled = false
    // A plan with exactly one entry is the Web UI's "single update" flow: the
    // user asked for that one record and confirmed its risk. A batch plan only
    // runs confirmation-only entries when the caller accepted overwriting.
    const batchPlan = plan.entries.length > 1
    if (!confirmed) {
      // Confirmation is a hard gate: a plan without the user's acceptance never
      // touches the filesystem, whatever its entries say.
      for (const entry of plan.entries) tasks.itemDone(taskId, entry.id, 'skipped', '用户未确认更新计划')
      tasks.finish(taskId, 'cancelled', '用户未确认更新计划，未执行任何修改')
      return
    }
    if (plan.entries.length === 0) {
      tasks.finish(taskId, 'done', '没有可执行的更新项')
      return
    }
    for (const [index, entry] of plan.entries.entries()) {
      if (signal.aborted) {
        cancelled = true
        this.skipRemaining(taskId, plan.entries, index, '任务已取消')
        break
      }
      if (entry.kind !== 'plugin-bundle' && entry.kind !== 'skill') {
        tasks.itemDone(taskId, entry.id, 'skipped', '该记录类型不支持更新')
        continue
      }
      const allowed = entry.eligible
        || (entry.requiresConfirmation === true && (overwriteLocalModifications || !batchPlan))
      if (!allowed) {
        const reason = entry.requiresConfirmation
          ? '需要用户确认后才能执行该更新'
          : (entry.excludedReason ?? '不在安全批量更新范围内')
        tasks.itemDone(taskId, entry.id, 'skipped', reason)
        await this.appendHistory({
          kind: entry.kind,
          name: entry.name,
          action: this.actionFor(entry, plan.entries.length > 1),
          outcome: 'blocked',
          message: reason,
          ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
          ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        })
        continue
      }
      tasks.itemRunning(taskId, entry.id)
      try {
        const outcome = await withInstallLock(() => this.runItem(entry, {
          overwriteLocalModifications,
          signal,
          batch: plan.entries.length > 1,
          ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
        }))
        transactionIds.push(outcome.transactionId)
        outcomes.push(outcome)
        tasks.itemDone(taskId, entry.id, this.taskItemStatus(outcome.status), outcome.message, {
          ...(outcome.fromVersion === undefined ? {} : { from: outcome.fromVersion }),
          ...(outcome.toVersion === undefined ? {} : { to: outcome.toVersion }),
        })
        if (outcome.stopBatch === true) {
          cancelled = true
          this.skipRemaining(taskId, plan.entries, index + 1, signal.aborted ? '任务已取消' : '更新已进入不可中断阶段，后续项目已停止')
          break
        }
      } catch (error) {
        // runItem handles its own recovery; reaching here means the executor
        // itself failed (for example the state file could not be written).
        const message = `更新执行失败：${messageOf(error)}`
        this.log.error('updates.executor-error', { id: entry.id, message: errorText(error) })
        tasks.itemDone(taskId, entry.id, 'failed', message)
        await this.appendHistory({
          kind: entry.kind,
          name: entry.name,
          action: this.actionFor(entry, plan.entries.length > 1),
          outcome: 'failed',
          message,
          ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
          ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        })
      }
    }
    tasks.attachTransactions(taskId, transactionIds)
    const failed = outcomes.filter(outcome =>
      outcome.status === 'failed' || outcome.status === 'rolled-back' || outcome.status === 'recovery-required').length
    const done = outcomes.filter(outcome => outcome.status === 'ok').length
    const skipped = plan.entries.length - outcomes.length
    const summaryParts = [`成功 ${String(done)} 项`]
    if (failed > 0) summaryParts.push(`失败/已回滚 ${String(failed)} 项`)
    if (skipped > 0) summaryParts.push(`跳过 ${String(skipped)} 项`)
    const summary = summaryParts.join('，')
    if (cancelled) {
      tasks.finish(taskId, 'cancelled', `任务已取消；${summary}`)
      return
    }
    if (failed > 0) {
      const recoveryRequired = outcomes.filter(outcome => outcome.status === 'recovery-required').length
      const error = recoveryRequired > 0
        ? `有 ${String(recoveryRequired)} 项需要人工恢复，备份保留在扩展管理器数据目录`
        : '部分更新项失败，已自动回滚'
      tasks.finish(taskId, 'failed', `${summary}；${error}`, error)
      return
    }
    tasks.finish(taskId, 'done', summary)
  }

  /**
   * Reconcile transactions left open by an earlier process. Called once at
   * Host startup: pending restarts are verified, interrupted destructive steps
   * are rolled back from their verified backup, and stages that never touched
   * the live files are abandoned.
   */
  /**
   * Reconcile transactions left open by an earlier process, then enforce
   * retention. Called once at Host startup: pending restarts are verified,
   * interrupted destructive steps are rolled back from their verified backup,
   * stages that never touched the live files are abandoned, and old backups or
   * staging directories are cleaned up.
   */
  async recover(): Promise<void> {
    const open = this.services.state.openTransactions()
    if (open.length > 0) {
      this.log.info('updates.recover.start', { count: open.length })
      for (const record of open) {
        await withInstallLock(async () => {
          const transaction = new UpdateTransaction(this.services.state, {
            kind: record.kind,
            extensionId: record.extensionId,
            name: record.name,
          }, record)
          try {
            await this.recoverOne(transaction)
          } catch (error) {
            this.log.error('updates.recover.failed', { id: record.id, message: errorText(error) })
            await transaction.patch({
              result: `恢复过程中出现异常：${messageOf(error)}`,
              error: messageOf(error),
            }).catch(() => undefined)
          }
        })
        // The reconciled transaction's scratch space is no longer needed.
        await removeTree(join(this.services.state.paths.stagingDir, record.id)).catch(() => undefined)
      }
      this.services.plugins.invalidate()
      this.services.skills.invalidate()
      this.log.info('updates.recover.completed', { count: open.length })
    }
    // Retention is enforced on every start, not only when something crashed.
    await this.maintain()
  }

  /**
   * Retention maintenance: keep the newest {@link BACKUP_RETENTION} backups
   * (backups named by an open transaction are never pruned) and drop staging
   * directories older than 24 hours. Runs under the write lock, so a live
   * update is never disturbed.
   */
  async maintain(): Promise<void> {
    await withInstallLock(async () => {
      const protectedIds = new Set(this.services.state.openTransactions().map(transaction => transaction.id))
      try {
        const pruned = await this.backup.pruneBackups({ keep: BACKUP_RETENTION, protectedIds })
        if (pruned.removed.length > 0) {
          this.log.info('updates.backup-pruned', {
            removed: pruned.removed,
            kept: pruned.kept,
            retention: BACKUP_RETENTION,
          })
        }
      } catch (error) {
        this.log.warn('updates.backup-prune-failed', { message: errorText(error) })
      }
      const stagingDir = this.services.state.paths.stagingDir
      let stagingEntries: Dirent[]
      try {
        stagingEntries = await readdir(stagingDir, { withFileTypes: true })
      } catch {
        stagingEntries = []
      }
      const now = Date.now()
      let removedStaging = 0
      for (const entry of stagingEntries) {
        if (!entry.isDirectory()) continue
        const dir = join(stagingDir, entry.name)
        const info = await stat(dir).catch(() => undefined)
        if (info === undefined || now - info.mtimeMs < STAGING_MAX_AGE_MS) continue
        try {
          await removeTree(dir)
          removedStaging += 1
        } catch (error) {
          this.log.warn('updates.staging-cleanup-failed', { dir, message: errorText(error) })
        }
      }
      if (removedStaging > 0) this.log.info('updates.staging-cleaned', { removed: removedStaging })
    })
  }

  /** Route one plan entry to its item runner. */
  private async runItem(entry: UpdatePlanEntry, options: RunOptions): Promise<ItemOutcome> {
    if (entry.kind === 'skill') return this.runSkillUpdate(entry, options)
    return this.runPluginUpdate(entry, options)
  }

  /** Whether this Host can hot-apply profile changes. */
  private hmrEnabled(): boolean {
    return this.services.ctx.get('hmr') !== undefined
  }

  /** The plugin-manager service, or a clear failure when the Host lacks it. */
  private pluginManager(): PluginManager {
    const manager = this.services.ctx.get('pluginManager')
    if (manager === undefined) throw new Error('当前 Host 没有提供 pluginManager 服务，无法执行插件更新')
    return manager
  }

  /** Mark every entry from `start` on as skipped (cancellation tail). */
  private skipRemaining(taskId: string, entries: readonly UpdatePlanEntry[], start: number, message: string): void {
    for (const entry of entries.slice(start)) {
      this.services.tasks.itemDone(taskId, entry.id, 'skipped', message)
    }
  }

  /** Map one item outcome to the task row status. */
  private taskItemStatus(status: ItemOutcome['status']): 'ok' | 'failed' | 'skipped' {
    if (status === 'ok') return 'ok'
    if (status === 'skipped') return 'skipped'
    return 'failed'
  }

  /** History action text for one entry. */
  private actionFor(entry: UpdatePlanEntry, batch: boolean): HistoryEntry['action'] {
    if (entry.kind === 'skill') return 'skill-update'
    return batch ? 'batch-update' : 'update'
  }

  /** Append one durable history entry (never throws into the caller). */
  private async appendHistory(input: {
    kind: ExtensionKind
    name: string
    action: HistoryEntry['action']
    outcome: HistoryEntry['outcome']
    message: string
    fromVersion?: string
    toVersion?: string
    transactionId?: string
  }): Promise<void> {
    const entry: HistoryEntry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      kind: input.kind,
      name: input.name,
      action: input.action,
      outcome: input.outcome,
      message: input.message,
      ...(input.fromVersion === undefined ? {} : { fromVersion: input.fromVersion }),
      ...(input.toVersion === undefined ? {} : { toVersion: input.toVersion }),
      ...(input.transactionId === undefined ? {} : { transactionId: input.transactionId }),
    }
    try {
      await this.services.state.addHistory(entry)
    } catch (error) {
      this.log.warn('updates.history-write-failed', { message: errorText(error) })
    }
  }

  /** Refuse to continue when the user cancelled before a phase starts. */
  private ensureNotAborted(signal: AbortSignal, phase: string): void {
    if (signal.aborted) throw new UpdateAbortedError(`更新在 ${phase} 阶段开始前被取消`)
  }

  // ---------------------------------------------------------------------
  // Plugin updates
  // ---------------------------------------------------------------------

  /** PREFLIGHT → … → VALIDATE for one plugin bundle. */
  private async runPluginUpdate(entry: UpdatePlanEntry, options: RunOptions): Promise<ItemOutcome> {
    const inventory = await this.services.plugins.scan({ refresh: true })
    const record = inventory.bundles.find(item => item.id === entry.id)
    const transaction = new UpdateTransaction(this.services.state, {
      kind: 'plugin-bundle',
      extensionId: entry.id,
      name: entry.name,
      ...(entry.targetVersion === undefined ? {} : { targetVersion: entry.targetVersion }),
      ...(entry.currentVersion === undefined ? {} : { previousVersion: entry.currentVersion }),
    })
    await transaction.save()
    const stagingDir = join(this.services.state.paths.stagingDir, transaction.record.id)
    let backup: BackupResult | undefined
    let preflight: PluginPreflight | undefined
    let installStarted = false
    try {
      if (record === undefined) throw new PreflightBlockedError('清单中已找不到该插件（可能已被卸载）')
      await transaction.note(`开始更新 ${record.displayName}`, {
        from: entry.currentVersion,
        to: entry.targetVersion,
      })
      this.ensureNotAborted(options.signal, 'PREFLIGHT')
      preflight = await this.preflightPlugin(record, transaction, options)
      await transaction.note('预检通过', {
        mode: preflight.mode,
        targetVersion: preflight.targetVersion,
        ...(preflight.mode === 'npm' ? { registry: preflight.registry } : { spec: preflight.installSpec }),
        localModification: preflight.localModification.state,
        ...(preflight.compatibilityNote === undefined ? {} : { compatibility: preflight.compatibilityNote }),
      })

      this.ensureNotAborted(options.signal, 'BACKUP')
      await transaction.setPhase('BACKUP', '备份安装目录与 Profile 清单')
      backup = await this.backup.backupPlugin({
        transactionId: transaction.record.id,
        installDir: preflight.installDir,
        profileDir: preflight.profileDir,
      })
      const verification = await this.backup.verify(backup)
      if (!verification.ok) throw new Error(`备份校验失败：${verification.problems.join('；')}`)
      await transaction.patch({ backupDir: backup.dir })
      await transaction.note('备份校验通过', {
        files: backup.fileCount,
        bytes: backup.totalBytes,
        dir: backup.dir,
      })

      this.ensureNotAborted(options.signal, 'DOWNLOAD')
      await transaction.setPhase('DOWNLOAD', preflight.mode === 'git'
        ? `确认 Git 目标提交 ${preflight.targetVersion}`
        : `下载目标版本 ${preflight.targetVersion}`)
      const downloaded = preflight.mode === 'npm'
        ? await this.downloadPluginTarball(preflight, transaction, stagingDir, options.signal)
        : undefined
      if (preflight.mode === 'git') {
        await transaction.note('Git 安装由 pnpm 按提交拉取，无需预下载', { spec: preflight.installSpec })
      }

      this.ensureNotAborted(options.signal, 'STAGE')
      await transaction.setPhase('STAGE', preflight.mode === 'git'
        ? 'Git 安装跳过解包校验；安装后依据 pnpm-lock.yaml 校验提交'
        : '解包并校验目标版本内容')
      if (preflight.mode === 'npm' && downloaded !== undefined) {
        await this.stagePluginPackage(preflight, downloaded, transaction, stagingDir)
      } else if (preflight.mode === 'git') {
        await transaction.note('Git 安装不预解包；锁定提交将在 VALIDATE 阶段核对')
      }

      this.ensureNotAborted(options.signal, 'INSTALL')
      await transaction.setPhase('INSTALL', preflight.mode === 'git'
        ? `先卸载旧版本，再按 Git 提交安装 ${preflight.record.name}（${preflight.targetVersion}）`
        : `先卸载旧版本，再安装 ${preflight.record.name}@${preflight.targetVersion}`)
      installStarted = true
      const install = await this.installPlugin(preflight, transaction, options)

      // From here on a cancellation is "too late": validate the resulting
      // installation instead of leaving a half-known state behind.
      if (options.signal.aborted) {
        await transaction.note('取消请求在安装阶段到达（too-late）；安装已完成，继续校验现场')
      }
      await transaction.setPhase('VALIDATE', preflight.mode === 'git'
        ? '读回 listBundles 并核对 pnpm-lock.yaml 提交'
        : '读回 listBundles 校验版本与启用状态')
      const problems = preflight.mode === 'git'
        ? await this.validateGitPlugin(preflight)
        : await this.validatePlugin(preflight)
      if (problems.length > 0) throw new Error(`安装后校验失败：${problems.join('；')}`)

      await this.services.state.clearCheck(`plugin:${entry.id}`)
      this.invalidatePlanModification(record.id)
      this.services.plugins.invalidate()
      const targetLabel = preflight.mode === 'git' ? `提交 ${preflight.targetVersion}` : preflight.targetVersion
      const needsRestart = install.application === 'restart-required'
      if (needsRestart) {
        await transaction.setPhase('PENDING_RESTART', '更新已写入，等待重启 DSH 生效', {
          restartReason: install.restartReason,
        })
        await transaction.patch({ needsRestart: true, result: `已更新到 ${targetLabel}，重启 DSH 后生效` })
      } else {
        await transaction.setPhase('VERIFIED', '更新完成并已校验', {
          version: preflight.targetVersion,
          enabled: preflight.enabled,
        })
        await transaction.patch({ needsRestart: false, result: `已更新到 ${targetLabel}` })
      }
      await this.appendHistory({
        kind: 'plugin-bundle',
        name: record.name,
        action: this.actionFor(entry, options.batch),
        outcome: 'success',
        message: needsRestart ? `已更新到 ${targetLabel}，重启后生效` : `已更新到 ${targetLabel}`,
        ...(preflight.previousVersion === undefined ? {} : { fromVersion: preflight.previousVersion }),
        toVersion: preflight.targetVersion,
        transactionId: transaction.record.id,
      })
      const outcome: ItemOutcome = {
        status: 'ok',
        message: needsRestart ? `已更新到 ${targetLabel}，需要重启 DSH` : `已更新到 ${targetLabel}`,
        transactionId: transaction.record.id,
        ...(preflight.previousVersion === undefined ? {} : { fromVersion: preflight.previousVersion }),
        toVersion: preflight.targetVersion,
        ...(needsRestart ? { needsRestart: true } : {}),
        ...(options.signal.aborted ? { stopBatch: true } : {}),
      }
      return outcome
    } catch (error) {
      return this.recoverPluginFailure({
        entry,
        transaction,
        preflight,
        backup,
        installStarted,
        error,
        options,
      })
    } finally {
      await removeTree(stagingDir).catch(() => undefined)
    }
  }

  /** Run every plugin preflight check and return verified install facts. */
  private async preflightPlugin(
    record: PluginBundleRecord,
    transaction: UpdateTransaction,
    options: RunOptions,
  ): Promise<PluginPreflight> {
    const facts = this.services.facts
    if (record.self === true || record.name === SELF_PACKAGE_NAME) {
      throw new PreflightBlockedError('管理器自身不参与自动更新')
    }
    if (!record.actions.canUpdate) {
      throw new PreflightBlockedError(record.actions.updateBlockedReason ?? '当前安装来源不支持自动更新')
    }
    const cache = this.services.state.check(`plugin:${record.id}`)
    if (cache === undefined) throw new PreflightBlockedError('尚未检查更新，请先检查')
    if (cache.status === 'incompatible-update' || cache.compatibility === 'incompatible') {
      throw new PreflightBlockedError(`新版本与当前 DSH 不兼容${describeRequirements(cache.compatibilityRequirements)}`)
    }
    if (!isCandidateStatus(cache.status)) throw new PreflightBlockedError('检查结果没有可用的新版本')
    const conflicting = this.services.state.openTransactions().filter(item =>
      item.extensionId === record.id && item.id !== transaction.record.id)
    if (conflicting.length > 0) {
      const phases = [...new Set(conflicting.map(item => item.phase))].join('、')
      throw new PreflightBlockedError(`该插件存在未完成的更新事务（${phases}），请先处理恢复`)
    }
    const installDir = record.paths.installDir
    if (installDir === undefined) throw new PreflightBlockedError('无法解析该插件的安装目录')
    const installInfo = await lstat(installDir).catch(() => undefined)
    if (installInfo === undefined) throw new PreflightBlockedError('安装目录不存在（安装记录与磁盘不一致）')
    if (installInfo.isSymbolicLink()) throw new PreflightBlockedError('安装目录是符号链接（本地链接安装），不支持自动更新')
    if (!installInfo.isDirectory()) throw new PreflightBlockedError('安装目录不是目录')
    if (!(await checkAccess(installDir))) throw new PreflightBlockedError('安装目录不可写（可能被其他程序占用）')
    if (!(await checkAccess(dirname(installDir)))) throw new PreflightBlockedError('安装目录的上级目录不可写，无法替换文件')
    if (!(await checkAccess(facts.dir))) throw new PreflightBlockedError('当前 Profile 目录不可写，无法更新依赖清单')
    const measured = await measureDirectory(installDir)
    const free = await readFreeBytes(facts.dir) ?? await readFreeBytes(installDir)
    if (free !== undefined && free < measured.bytes * 2 + MIN_FREE_BYTES) {
      throw new PreflightBlockedError(`磁盘空间不足：需要约 ${formatBytes(measured.bytes * 2 + MIN_FREE_BYTES)}，当前可用 ${formatBytes(free)}`)
    }
    const currentVersion = record.version.current
    const shared: PluginPreflightShared = {
      record,
      installDir,
      profileDir: facts.dir,
      enabled: record.runtime.enabled === true,
      ...(currentVersion === undefined ? {} : { previousVersion: currentVersion }),
      localModification: { state: 'unknown' },
    }
    if (record.source.kind === 'git') return this.preflightGitPlugin(cache, shared, transaction, options)
    if (record.source.kind !== 'npm') {
      throw new PreflightBlockedError('当前仅支持 npm Registry 或 Git 安装来源的自动更新（本地来源请手动更新）')
    }
    if (record.source.spec !== undefined) {
      const prefix = `${record.name}@`
      const recordedSpec = record.source.spec.startsWith(prefix) ? record.source.spec.slice(prefix.length) : record.source.spec
      if (recordedSpec.startsWith('npm:')) {
        throw new PreflightBlockedError('该插件以别名方式安装，不支持自动更新')
      }
    }
    const targetVersion = cache.availableVersion
    if (targetVersion === undefined) throw new PreflightBlockedError('检查结果没有给出目标版本')
    if (currentVersion !== undefined && semver.valid(currentVersion) !== null && semver.valid(targetVersion) !== null) {
      if (semver.eq(currentVersion, targetVersion)) {
        throw new PreflightBlockedError('目标版本与当前版本相同（检查缓存可能已过期，请重新检查）')
      }
      if (semver.lt(targetVersion, currentVersion)) {
        throw new PreflightBlockedError('目标版本低于当前版本（检查缓存可能已过期，请重新检查）')
      }
    }
    const policy = await this.network.registryPolicy(this.services.ctx)
    const document = await this.fetchDocument(record.name, policy, options.signal)
    const targetManifest = manifestOf(document, targetVersion)
    if (targetManifest === undefined) {
      throw new PreflightBlockedError(`Registry 中没有目标版本 ${targetVersion}（检查缓存可能已过期，请重新检查）`)
    }
    const targetTarballUrl = tarballUrlOf(targetManifest)
    if (targetTarballUrl === undefined) throw new Error('上游没有提供目标版本的 tarball 地址')
    const compatibility = evaluatePluginCompatibility(targetManifest, runtimeVersion(facts))
    if (compatibility.compatibility === 'incompatible') {
      throw new PreflightBlockedError(`目标版本与当前 DSH 运行版本不兼容${describeRequirements(compatibility.requirements)}`)
    }
    const compatibilityNote = compatibility.compatibility === 'unknown'
      ? (compatibility.detail ?? '未能确认与当前 DSH 的兼容性')
      : undefined
    const localModification = await this.detectPluginLocalModification({
      record,
      document,
      installDir,
      signal: options.signal,
      ...(currentVersion === undefined ? {} : { currentVersion }),
    })
    this.ensureLocalModificationAcceptable(localModification, options)
    await transaction.note('本地修改检测结果', {
      state: localModification.state,
      files: localModification.files ?? [],
      detail: localModification.detail,
    })
    return {
      ...shared,
      mode: 'npm',
      targetVersion,
      registry: policy.registry,
      targetTarballUrl,
      targetManifest,
      localModification,
      ...(compatibilityNote === undefined ? {} : { compatibilityNote }),
    }
  }

  /** Git-source preflight: exact commit, install spec, commit-based validation. */
  private async preflightGitPlugin(
    cache: CheckCacheEntry,
    shared: PluginPreflightShared,
    transaction: UpdateTransaction,
    options: RunOptions,
  ): Promise<GitPluginPreflight> {
    const record = shared.record
    const commit = cache.availableCommit ?? record.version.availableCommit
    if (commit === undefined || !/^[0-9a-f]{7,40}$/iu.test(commit)) {
      throw new PreflightBlockedError('检查结果没有给出可安装的远端提交，请重新检查更新')
    }
    const installSpec = buildGitTargetSpec(record, commit)
    if (installSpec === undefined) {
      throw new PreflightBlockedError('无法根据当前安装规格构造 Git 更新目标，请手动更新')
    }
    // A git checkout has no published file list to compare against; treat the
    // local-modification answer as unknown and require the explicit overwrite
    // acknowledgement, exactly like an unverifiable npm package.
    const localModification: LocalModificationInfo = {
      state: 'unknown',
      detail: 'Git 安装没有可比较的发布基线；更新会用目标提交重新安装，覆盖安装目录中的本地改动',
    }
    this.ensureLocalModificationAcceptable(localModification, options)
    const compatibilityNote = cache.compatibility === 'compatible'
      ? undefined
      : 'Git 安装的 DSH 兼容性无法在更新前完全确认（以上游 package.json 申报为准）'
    await transaction.note('Git 安装预检', {
      commit,
      spec: installSpec,
      localModification: localModification.state,
    })
    return {
      ...shared,
      mode: 'git',
      targetVersion: commit.slice(0, 12),
      installSpec,
      targetCommit: commit,
      localModification,
      ...(compatibilityNote === undefined ? {} : { compatibilityNote }),
    }
  }

  /** Refuse an update whose local files changed unless the caller accepted overwriting them. */
  private ensureLocalModificationAcceptable(localModification: LocalModificationInfo, options: RunOptions): void {
    if (localModification.state === 'clean' || options.overwriteLocalModifications) return
    throw new PreflightBlockedError(
      localModification.state === 'modified'
        ? `本地安装文件已被修改${localModification.files === undefined ? '' : `（${localModification.files.slice(0, 5).join('、')}）`}；如确认覆盖，请选择“覆盖本地修改”后重试`
        : `无法核对本地文件是否被修改${localModification.detail === undefined ? '' : `：${localModification.detail}`}；如确认继续，请选择“覆盖本地修改”后重试`,
    )
  }

  /** Ask the configured registries for one packument. */
  private async fetchDocument(name: string, policy: NpmRegistryPolicy, signal: AbortSignal): Promise<NpmDocument> {
    const outcome = await this.network.fetchNpmDocument(name, {
      policy,
      signal,
      timeoutMs: PACKUMENT_TIMEOUT_MS,
    })
    if (outcome.status === 'ok') return outcome.document
    if (outcome.status === 'not-found') throw new Error(`Registry 中找不到包 ${name}`)
    if (outcome.status === 'invalid') throw new Error(`Registry 返回的包文档无法解析：${outcome.message}`)
    const detail = outcome.attempts.map(attempt => `${attempt.registry}：${attempt.message}`).join('；')
    throw new Error(`无法连接 Registry（${detail}）`)
  }

  /** Compare the installed package files against the registry tarball of the installed version. */
  private async detectPluginLocalModification(input: {
    record: PluginBundleRecord
    document: NpmDocument
    installDir: string
    signal: AbortSignal
    currentVersion?: string
  }): Promise<LocalModificationInfo> {
    const { currentVersion } = input
    if (currentVersion === undefined) {
      return { state: 'unknown', detail: '没有记录当前安装版本，无法与 registry 内容比较' }
    }
    const manifest = manifestOf(input.document, currentVersion)
    const tarballUrl = tarballUrlOf(manifest)
    if (tarballUrl === undefined) {
      return { state: 'unknown', detail: `Registry 缺少当前版本 ${currentVersion} 的 tarball 信息` }
    }
    let tarball: NpmTarball
    try {
      const bytes = await this.network.downloadTarball(tarballUrl, {
        signal: input.signal,
        timeoutMs: TARBALL_TIMEOUT_MS,
      })
      tarball = readNpmTarball(Buffer.from(bytes))
    } catch (error) {
      throw new Error(`无法下载当前版本 ${currentVersion} 的发布内容用于本地修改比较：${messageOf(error)}`)
    }
    const expected: TreeManifest = {
      files: tarball.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      symlinks: [],
      dirs: [],
      totalBytes: tarball.totalBytes,
    }
    const observed = await hashTree(input.installDir, { ignore: isLocalNoise })
    const comparison = compareTreeManifests(expected, observed, 20)
    if (comparison.clean) {
      return { state: 'clean', detail: `安装目录内容与 registry 发布的 ${currentVersion} 一致` }
    }
    const files = [...comparison.modified, ...comparison.added, ...comparison.missing]
    const details: string[] = []
    if (comparison.modified.length > 0) details.push(`内容不同 ${String(comparison.modified.length)} 个`)
    if (comparison.added.length > 0) details.push(`多余文件 ${String(comparison.added.length)} 个`)
    if (comparison.missing.length > 0) details.push(`缺失文件 ${String(comparison.missing.length)} 个`)
    return {
      state: 'modified',
      files: files.slice(0, 20),
      detail: `与 registry 发布的 ${currentVersion} 不一致：${details.join('，')}`,
    }
  }

  /** DOWNLOAD: fetch and verify the target tarball, then keep it for STAGE. */
  private async downloadPluginTarball(
    preflight: NpmPluginPreflight,
    transaction: UpdateTransaction,
    stagingDir: string,
    signal: AbortSignal,
  ): Promise<{ tarball: NpmTarball; buffer: Buffer }> {
    let bytes: Uint8Array
    try {
      bytes = await this.network.downloadTarball(preflight.targetTarballUrl, {
        signal,
        timeoutMs: TARBALL_TIMEOUT_MS,
        maxBytes: MAX_DOWNLOAD_BYTES,
      })
    } catch (error) {
      throw new Error(`下载目标版本失败：${messageOf(error)}`)
    }
    const buffer = Buffer.from(bytes)
    const integrityProblem = verifyTarballIntegrity(buffer, preflight.targetManifest)
    if (integrityProblem !== undefined) throw new Error(`目标版本完整性校验失败：${integrityProblem}`)
    let tarball: NpmTarball
    try {
      tarball = readNpmTarball(buffer)
    } catch (error) {
      throw new Error(`目标版本压缩包无法解析：${messageOf(error)}`)
    }
    if (tarball.name !== undefined && tarball.name !== preflight.record.name) {
      throw new Error(`下载的包名不符：期望 ${preflight.record.name}，实际 ${tarball.name}`)
    }
    if (tarball.version !== preflight.targetVersion) {
      throw new Error(`下载的版本不符：期望 ${preflight.targetVersion}，实际 ${tarball.version ?? '未知'}`)
    }
    await ensureDirectory(stagingDir)
    const archivePath = join(stagingDir, 'target.tgz')
    await writeFileAtomicSafe(archivePath, buffer)
    await transaction.note('目标版本已下载并核对', {
      version: tarball.version,
      files: tarball.files.length,
      bytes: buffer.byteLength,
      archivePath,
    })
    return { tarball, buffer }
  }

  /** STAGE: extract the tarball, verify what landed on disk and the bundle declaration. */
  private async stagePluginPackage(
    preflight: NpmPluginPreflight,
    downloaded: { tarball: NpmTarball; buffer: Buffer },
    transaction: UpdateTransaction,
    stagingDir: string,
  ): Promise<void> {
    const extractDir = join(stagingDir, 'package')
    let extracted: Awaited<ReturnType<typeof extractArchive>>
    try {
      extracted = await extractArchive(downloaded.tarball.entries, extractDir, { prefix: 'package/' })
    } catch (error) {
      throw new Error(`解包目标版本失败：${messageOf(error)}`)
    }
    const fileProblem = compareExtractedFiles(extracted.files, downloaded.tarball.files)
    if (!fileProblem.ok) {
      throw new Error(`解包内容与发布清单不一致（新增 ${String(fileProblem.added.length)}、不同 ${String(fileProblem.modified.length)}、缺失 ${String(fileProblem.missing.length)}）`)
    }
    const observed = await hashTree(extractDir, { ignore: isLocalNoise })
    const expected: TreeManifest = {
      files: downloaded.tarball.files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      symlinks: [],
      dirs: [],
      totalBytes: downloaded.tarball.totalBytes,
    }
    const comparison = compareTreeManifests(expected, observed, 20)
    if (!comparison.clean) throw new Error('解包到磁盘后的文件校验失败（写入不完整）')
    const manifest = await readJsonFile(join(extractDir, 'package.json'))
    if (manifest === undefined) throw new Error('目标版本缺少可读的 package.json')
    if (typeof manifest['name'] === 'string' && manifest['name'] !== preflight.record.name) {
      throw new Error(`目标版本 package.json 的包名不符：${manifest['name']}`)
    }
    if (typeof manifest['version'] === 'string' && manifest['version'] !== preflight.targetVersion) {
      throw new Error(`目标版本 package.json 的版本不符：${manifest['version']}`)
    }
    const dsh = manifest['dsh']
    const bundle = typeof dsh === 'object' && dsh !== null ? (dsh as { bundle?: unknown }).bundle : undefined
    if (typeof bundle !== 'object' || bundle === null) {
      throw new Error('目标版本没有声明 dsh.bundle，安装后不会成为组合包')
    }
    await transaction.note('目标版本内容校验通过', {
      files: extracted.files.length,
      directories: extracted.directories.length,
      bundle: true,
    })
  }

  /** INSTALL: remove the old bundle first (HMR requires it), then install the exact target. */
  private async installPlugin(
    preflight: PluginPreflight,
    transaction: UpdateTransaction,
    options: RunOptions,
  ): Promise<{ application: ChangeResult['application']; restartReason: string | undefined }> {
    const manager = this.pluginManager()
    const name = preflight.record.name
    let directOverwrite = false
    try {
      const removal: ChangeResult = await manager.removeBundle(name)
      if (removal.application === 'failed') {
        const code = removal.error?.code
        if (code === 'stop-profile' && !this.hmrEnabled()) {
          directOverwrite = true
          await transaction.note('当前 Profile 没有 HMR，无法卸载运行中的组合包；改为直接覆盖安装（安装结果会要求重启）')
        } else {
          throw new Error(managementErrorText(removal.error) || 'pluginManager.removeBundle 返回失败')
        }
      } else if (removal.application === 'cancelled') {
        throw new UpdateAbortedError('卸载旧版本被取消')
      } else {
        await transaction.note('旧版本已卸载', { changed: removal.changed })
      }
    } catch (error) {
      if (error instanceof UpdateAbortedError) throw error
      throw new Error(`卸载旧版本失败：${messageOf(error)}`)
    }
    if (options.signal.aborted) throw new UpdateAbortedError('安装开始前任务已被取消')
    const installSpec = preflight.mode === 'git'
      ? preflight.installSpec
      : `${name}@${preflight.targetVersion}`
    const installOptions: InstallBundleOptions = {
      enabled: preflight.enabled,
      ...(preflight.mode === 'npm' && preflight.registry !== null ? { registry: preflight.registry } : {}),
      ...(preflight.mode === 'npm' ? { saveExact: true } : {}),
    }
    let change: ChangeResult
    try {
      change = await manager.installBundle(installSpec, installOptions)
    } catch (error) {
      throw new Error(`安装目标版本失败：${messageOf(error)}`)
    }
    if (change.application === 'failed') {
      const diagnostic = change.packageResult?.output.trim()
      throw new Error(`安装目标版本失败：${managementErrorText(change.error)}${diagnostic === undefined || diagnostic === '' ? '' : `（${diagnostic.slice(-800)}）`}`)
    }
    if (change.application === 'cancelled') {
      throw new UpdateAbortedError('安装被取消（pluginManager 已恢复其清单文件）')
    }
    await transaction.note('pluginManager 报告安装完成', {
      application: change.application,
      mode: preflight.mode,
      spec: installSpec,
      version: change.version,
      bundle: change.bundle,
      registries: change.registries,
      ...(directOverwrite ? { directOverwrite } : {}),
    })
    return {
      application: change.application,
      restartReason: change.restartReason,
    }
  }

  /** VALIDATE: read back the bundle list and compare version + enablement. */
  private async validatePlugin(preflight: NpmPluginPreflight): Promise<string[]> {
    const manager = this.pluginManager()
    let bundles: BundleInfo[]
    try {
      bundles = await manager.listBundles()
    } catch (error) {
      return [`无法读取 listBundles 校验安装结果：${messageOf(error)}`]
    }
    const current = bundles.find(bundle => bundle.name === preflight.record.name)
    if (current === undefined) return ['listBundles 中没有找到该组合包']
    const problems: string[] = []
    if (current.version !== preflight.targetVersion) {
      problems.push(`版本读回不一致：期望 ${preflight.targetVersion}，实际 ${current.version ?? '未知'}`)
    }
    if (current.enabled !== preflight.enabled) {
      problems.push(`启用状态读回不一致：期望 ${preflight.enabled ? '启用' : '停用'}，实际 ${current.enabled ? '启用' : '停用'}`)
    }
    if (current.availability !== 'profile') {
      problems.push(`安装位置异常：期望 profile，实际 ${current.availability}`)
    }
    if (current.error !== undefined) problems.push(managementErrorText(current.error))
    return problems
  }

  /**
   * VALIDATE for a git-source bundle: the version in `package.json` need not
   * change between commits, so the recorded lockfile commit is the authority.
   */
  private async validateGitPlugin(preflight: GitPluginPreflight): Promise<string[]> {
    const manager = this.pluginManager()
    let bundles: BundleInfo[]
    try {
      bundles = await manager.listBundles()
    } catch (error) {
      return [`无法读取 listBundles 校验安装结果：${messageOf(error)}`]
    }
    const current = bundles.find(bundle => bundle.name === preflight.record.name)
    if (current === undefined) return ['listBundles 中没有找到该组合包']
    const problems: string[] = []
    if (current.enabled !== preflight.enabled) {
      problems.push(`启用状态读回不一致：期望 ${preflight.enabled ? '启用' : '停用'}，实际 ${current.enabled ? '启用' : '停用'}`)
    }
    if (current.availability !== 'profile') problems.push(`安装位置异常：期望 profile，实际 ${current.availability}`)
    if (current.error !== undefined) problems.push(managementErrorText(current.error))
    const targetCommit = preflight.targetCommit
    try {
      const lockfile = await readFile(join(this.services.facts.dir, 'pnpm-lock.yaml'), 'utf8')
      const resolution = parseLockfileGitResolution(lockfile, preflight.record.name)
      if (resolution?.commit === undefined) {
        problems.push('pnpm-lock.yaml 中没有该 Git 安装的提交记录')
      } else if (resolution.commit.toLowerCase() !== targetCommit.toLowerCase()) {
        problems.push(`pnpm-lock.yaml 记录的提交为 ${resolution.commit.slice(0, 12)}，期望 ${targetCommit.slice(0, 12)}`)
      }
    } catch (error) {
      problems.push(`无法读取 pnpm-lock.yaml 校验 Git 提交：${messageOf(error)}`)
    }
    return problems
  }

  /** Failure path of a plugin update: recover from the verified backup, then report. */
  private async recoverPluginFailure(input: {
    entry: UpdatePlanEntry
    transaction: UpdateTransaction
    preflight: PluginPreflight | undefined
    backup: BackupResult | undefined
    installStarted: boolean
    error: unknown
    options: RunOptions
  }): Promise<ItemOutcome> {
    const { transaction } = input
    const blocked = input.error instanceof PreflightBlockedError
    const aborted = input.error instanceof UpdateAbortedError
    const message = blocked || aborted ? messageOf(input.error) : `更新失败：${messageOf(input.error)}`
    try {
      await transaction.fail(message, {
        ...(blocked ? { blocked: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      })
    } catch (failure) {
      this.log.warn('updates.transaction-fail-write-failed', { message: errorText(failure) })
    }
    return this.finishPluginRecovery({
      entry: input.entry,
      transaction,
      preflight: input.preflight,
      backup: input.backup,
      installStarted: input.installStarted,
      errorMessage: message,
      blocked,
      aborted,
      options: input.options,
    })
  }

  /** RECOVERY phase: restore the verified installation, then decide the terminal phase. */
  private async finishPluginRecovery(input: {
    entry: UpdatePlanEntry
    transaction: UpdateTransaction
    preflight: PluginPreflight | undefined
    backup: BackupResult | undefined
    installStarted: boolean
    errorMessage: string
    blocked: boolean
    aborted: boolean
    options: RunOptions
  }): Promise<ItemOutcome> {
    const { transaction, preflight, backup, entry } = input
    try {
      await transaction.setPhase('RECOVERY', backup === undefined ? '审查是否需要恢复（尚未产生修改）' : '从备份恢复安装目录与 Profile 清单')
    } catch (error) {
      this.log.warn('updates.recovery-phase-write-failed', { message: errorText(error) })
    }
    let recovered = true
    let rolledBack = false
    let problems: string[] = []
    let restoredVersion: string | undefined
    if (input.installStarted && preflight !== undefined) {
      if (backup === undefined) {
        recovered = false
        problems = ['安装已开始，但事务没有可用的备份目录']
      } else {
        const report = await this.backup.restorePlugin(backup, preflight.installDir)
        recovered = report.ok
        problems = report.problems
        rolledBack = report.ok
        restoredVersion = report.verifiedVersion
        if (report.ok && preflight.previousVersion !== undefined && restoredVersion !== preflight.previousVersion) {
          recovered = false
          problems = [...problems, `恢复后的版本为 ${restoredVersion ?? '未知'}，期望 ${preflight.previousVersion}`]
        }
      }
    } else if (input.installStarted) {
      recovered = false
      problems = ['安装已开始，但预检信息缺失，无法确定恢复位置']
    }
    this.services.plugins.invalidate()
    if (recovered) {
      const restartHint = rolledBack && this.hmrEnabled()
        ? '；运行中的 DSH 可能仍持有新版本代码，建议重启以完全恢复'
        : ''
      const resultMessage = rolledBack
        ? `更新失败，已从备份回滚到 ${restoredVersion ?? preflight?.previousVersion ?? '原版本'}${restartHint}`
        : (input.blocked || input.aborted ? input.errorMessage : '更新失败，未产生安装目录修改')
      try {
        await transaction.setPhase('RECOVERED', resultMessage, {
          rolledBack,
          ...(restoredVersion === undefined ? {} : { restoredVersion }),
        })
        await transaction.patch({
          ...(rolledBack ? { rolledBack: true, needsRestart: this.hmrEnabled() } : {}),
          result: resultMessage,
        })
      } catch (error) {
        this.log.warn('updates.recovered-phase-write-failed', { message: errorText(error) })
      }
      await this.appendHistory({
        kind: 'plugin-bundle',
        name: entry.name,
        action: this.actionFor(entry, input.options.batch),
        outcome: input.blocked || input.aborted ? 'blocked' : (rolledBack ? 'rolled-back' : 'failed'),
        message: resultMessage,
        ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
        ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        transactionId: transaction.record.id,
      })
      return {
        status: input.blocked || input.aborted ? 'skipped' : (rolledBack ? 'rolled-back' : 'failed'),
        message: resultMessage,
        transactionId: transaction.record.id,
        ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
        ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        ...(input.aborted ? { stopBatch: true } : {}),
      }
    }
    const requiredMessage = `更新失败且无法自动恢复；备份保留在 ${backup?.dir ?? transaction.record.backupDir ?? '（无备份目录）'}。请人工检查后重试。`
    try {
      await transaction.setPhase('RECOVERY_REQUIRED', requiredMessage, { problems })
      await transaction.patch({ result: `${requiredMessage}${problems.length === 0 ? '' : `（${problems.join('；')}）`}`, rolledBack: false })
    } catch (error) {
      this.log.warn('updates.recovery-required-write-failed', { message: errorText(error) })
    }
    await this.appendHistory({
      kind: 'plugin-bundle',
      name: entry.name,
      action: this.actionFor(entry, input.options.batch),
      outcome: 'recovery-required',
      message: `${input.errorMessage}；自动恢复失败：${problems.join('；')}`,
      ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
      ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
      transactionId: transaction.record.id,
    })
    return {
      status: 'recovery-required',
      message: requiredMessage,
      transactionId: transaction.record.id,
      ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
      ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
      stopBatch: true,
    }
  }

  // ---------------------------------------------------------------------
  // Skill updates
  // ---------------------------------------------------------------------

  /** PREFLIGHT → … → VALIDATE for one physical skill directory. */
  private async runSkillUpdate(entry: UpdatePlanEntry, options: RunOptions): Promise<ItemOutcome> {
    const inventory = await this.services.skills.scan({
      refresh: true,
      ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    })
    const record = inventory.physical.find(item => item.id === entry.id)
    const transaction = new UpdateTransaction(this.services.state, {
      kind: 'skill',
      extensionId: entry.id,
      name: entry.name,
      ...(entry.targetVersion === undefined ? {} : { targetVersion: entry.targetVersion }),
      ...(entry.currentVersion === undefined ? {} : { previousVersion: entry.currentVersion }),
    })
    await transaction.save()
    const stagingDir = join(this.services.state.paths.stagingDir, transaction.record.id)
    let backup: BackupResult | undefined
    let preflight: SkillPreflight | undefined
    let movedAside = false
    let asideDir = ''
    try {
      if (record === undefined) throw new PreflightBlockedError('清单中已找不到该技能（可能已被移动或删除）')
      await transaction.note(`开始更新技能 ${record.displayName}`, {
        from: entry.currentVersion,
        to: entry.targetVersion,
      })
      this.ensureNotAborted(options.signal, 'PREFLIGHT')
      preflight = await this.preflightSkill(record, transaction, options)
      await transaction.note('预检通过', {
        repo: preflight.repo,
        ref: preflight.ref,
        ...(preflight.commit === undefined ? {} : { commit: preflight.commit }),
        subdir: preflight.subdir,
        tree: preflight.expectedTree,
      })

      this.ensureNotAborted(options.signal, 'BACKUP')
      await transaction.setPhase('BACKUP', '备份技能目录')
      backup = await this.backup.backupSkill({
        transactionId: transaction.record.id,
        skillDir: preflight.skillDir,
      })
      const verification = await this.backup.verify(backup)
      if (!verification.ok) throw new Error(`技能目录备份校验失败：${verification.problems.join('；')}`)
      await transaction.patch({ backupDir: backup.dir })
      await transaction.note('技能目录备份校验通过', { files: backup.fileCount, dir: backup.dir })

      this.ensureNotAborted(options.signal, 'DOWNLOAD')
      await transaction.setPhase('DOWNLOAD', `下载 GitHub 归档 ${preflight.repo}@${preflight.ref.slice(0, 12)}`)
      let archiveBytes: Buffer
      try {
        archiveBytes = await this.archive.download(preflight.repo, preflight.ref, {
          signal: options.signal,
          timeoutMs: ARCHIVE_TIMEOUT_MS,
          maxBytes: MAX_DOWNLOAD_BYTES,
        })
      } catch (error) {
        throw new Error(`下载技能归档失败：${messageOf(error)}`)
      }
      await ensureDirectory(stagingDir)
      await writeFileAtomicSafe(join(stagingDir, 'source.tgz'), archiveBytes)
      await transaction.note('归档已下载', { bytes: archiveBytes.byteLength })

      this.ensureNotAborted(options.signal, 'STAGE')
      await transaction.setPhase('STAGE', '解包并校验技能内容')
      const staged = await this.stageSkillPackage(preflight, archiveBytes, transaction, stagingDir)

      this.ensureNotAborted(options.signal, 'INSTALL')
      await transaction.setPhase('INSTALL', '先移出旧目录，再放入新目录')
      asideDir = join(backup.dir, 'skill-old')
      await moveTree(preflight.skillDir, asideDir)
      movedAside = true
      await transaction.note('旧技能目录已移到备份侧', { asideDir })
      try {
        await moveTree(join(stagingDir, 'skill'), preflight.skillDir)
      } catch (error) {
        // Put the original directory back immediately; recovery below re-verifies it.
        await moveTree(asideDir, preflight.skillDir).catch(() => undefined)
        movedAside = false
        throw new Error(`新技能目录无法放入目标位置：${messageOf(error)}`)
      }
      await transaction.note('新技能目录已放入目标位置')

      await transaction.setPhase('VALIDATE', '校验技能目录内容与来源')
      const problems = await this.validateSkill(preflight, staged.tree)
      if (problems.length > 0) throw new Error(`技能更新后校验失败：${problems.join('；')}`)
      await removeTree(asideDir).catch(() => undefined)
      await this.services.state.clearCheck(`skill:${entry.id}`)
      try {
        await this.services.state.setCheck({
          recordId: `skill:${entry.id}`,
          status: 'up-to-date',
          ...(preflight.commit === undefined ? {} : { availableCommit: preflight.commit }),
          availableTree: preflight.expectedTree,
          availableVersion: preflight.targetVersion,
          channel: 'commit',
          checkedAt: new Date().toISOString(),
          detail: `更新后已确认技能内容与远端 tree ${preflight.expectedTree.slice(0, 12)} 一致`,
        })
      } catch (error) {
        this.log.warn('updates.skill-check-cache-write-failed', { message: errorText(error) })
      }
      this.services.skills.invalidate()
      await transaction.setPhase('VERIFIED', '技能目录已替换并校验通过', {
        ...(preflight.commit === undefined ? { ref: preflight.ref } : { commit: preflight.commit }),
        tree: preflight.expectedTree,
      })
      await transaction.patch({ result: `已更新到 ${preflight.targetVersion}`, needsRestart: false })
      // Advance the user-confirmed baseline so the next check compares against
      // the content that is now on disk instead of reporting the same update again.
      const association = this.services.state.skillSource(`skill:${entry.id}`)
      if (association !== undefined) {
        await this.services.state.setSkillSource({
          ...association,
          baseline: {
            ...(association.baseline ?? {}),
            tree: preflight.expectedTree,
            ...(preflight.commit === undefined ? {} : { commit: preflight.commit }),
          },
          confirmedAt: association.confirmedAt,
        }).catch((error: unknown) => {
          this.log.warn('updates.skill-baseline-write-failed', { message: errorText(error) })
        })
      }
      await this.appendHistory({
        kind: 'skill',
        name: record.name,
        action: this.actionFor(entry, options.batch),
        outcome: 'success',
        message: `已更新技能目录（${preflight.targetVersion}）`,
        ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
        ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        transactionId: transaction.record.id,
      })
      return {
        status: 'ok',
        message: `已更新技能目录（${preflight.targetVersion}）`,
        transactionId: transaction.record.id,
        ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
        ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        ...(options.signal.aborted ? { stopBatch: true } : {}),
      }
    } catch (error) {
      return this.finishSkillFailure({
        entry,
        transaction,
        preflight,
        backup,
        movedAside,
        asideDir,
        error,
        options,
      })
    } finally {
      await removeTree(stagingDir).catch(() => undefined)
    }
  }

  /** Run every skill preflight check and return verified replacement facts. */
  private async preflightSkill(
    record: SkillRecord,
    transaction: UpdateTransaction,
    options: RunOptions,
  ): Promise<SkillPreflight> {
    if (record.layout !== 'directory') throw new PreflightBlockedError('平铺单文件技能不支持自动更新')
    if (!record.actions.canUpdate) throw new PreflightBlockedError(record.actions.updateBlockedReason ?? '该技能来源不支持自动更新')
    const skillDir = record.paths.installDir
    const rootDir = record.paths.rootDir
    if (skillDir === undefined || rootDir === undefined) {
      throw new PreflightBlockedError('无法确定技能目录或其发现根，安全起见拒绝更新')
    }
    const resolved = await resolveInside(rootDir, skillDir)
    if (resolved === undefined) throw new PreflightBlockedError('技能目录不在其发现根内（路径校验失败）')
    const association = this.services.state.skillSource(`skill:${record.id}`)
    const url = association?.url ?? record.source.url
    const sourceRepo = record.source.repo
    const repo = parseGithubRepo(url)
      ?? (sourceRepo === undefined ? undefined : parseGithubRepo(`https://github.com/${sourceRepo}`))
    if (repo === undefined) throw new PreflightBlockedError('技能来源不是可识别的 GitHub 仓库地址')
    const verified = association?.verified === true || record.source.trust === 'verified'
    if (!verified) throw new PreflightBlockedError('技能来源尚未经过验证，请先在来源中确认仓库')
    const subdir = normalizeSubdir(association?.subdir ?? record.source.subdir)
    if (subdir === undefined) throw new PreflightBlockedError('技能来源的子目录配置非法')
    const cache = this.services.state.check(`skill:${record.id}`)
    if (cache === undefined) throw new PreflightBlockedError('尚未检查更新，请先检查')
    if (!isCandidateStatus(cache.status)) throw new PreflightBlockedError('检查结果没有可用的新版本')
    const knownCommit = cache.availableCommit ?? record.version.availableCommit
    const commit = knownCommit !== undefined && /^[0-9a-f]{7,40}$/iu.test(knownCommit) ? knownCommit : undefined
    const expectedTree = cache.availableTree ?? record.version.availableTree
    if (expectedTree === undefined) {
      throw new PreflightBlockedError('检查结果缺少远端目录树哈希，无法校验下载内容；请重新检查更新')
    }
    // Without an exact commit, download the recorded ref (branch/tag) or HEAD
    // and rely on the tree hash: content that moved since the check fails the
    // hash comparison instead of being installed.
    const recordedRef = association?.ref ?? record.source.ref
    const ref = commit ?? (recordedRef !== undefined && recordedRef.trim() !== '' ? recordedRef.trim() : 'HEAD')
    const conflicting = this.services.state.openTransactions().filter(item =>
      item.extensionId === record.id && item.id !== transaction.record.id)
    if (conflicting.length > 0) throw new PreflightBlockedError('该技能存在未完成的更新事务，请先处理恢复')
    const symlink = await containsSymlink(skillDir)
    if (symlink !== undefined) {
      throw new PreflightBlockedError(`技能目录包含符号链接（${symlink}），为避免越界修改暂不支持自动更新`)
    }
    const modification = record.localModification
    if (modification.state === 'modified' && !options.overwriteLocalModifications) {
      throw new PreflightBlockedError(
        `技能目录有本地修改${modification.files === undefined ? '' : `（${modification.files.slice(0, 5).join('、')}）`}；如确认覆盖，请选择“覆盖本地修改”后重试`,
      )
    }
    if (modification.state === 'unknown' && !options.overwriteLocalModifications) {
      throw new PreflightBlockedError('无法确认技能目录是否被本地修改；如确认继续，请选择“覆盖本地修改”后重试')
    }
    const measured = await measureDirectory(skillDir)
    const free = await readFreeBytes(rootDir) ?? await readFreeBytes(skillDir)
    if (free !== undefined && free < measured.bytes * 2 + MIN_FREE_BYTES) {
      throw new PreflightBlockedError(`磁盘空间不足：需要约 ${formatBytes(measured.bytes * 2 + MIN_FREE_BYTES)}，当前可用 ${formatBytes(free)}`)
    }
    if (!(await checkAccess(dirname(skillDir)))) throw new PreflightBlockedError('技能目录的上级目录不可写，无法替换')
    await transaction.note('本地修改检测结果', {
      state: modification.state,
      files: modification.files ?? [],
    })
    return {
      record,
      skillDir,
      rootDir,
      repo,
      ref,
      ...(commit === undefined ? {} : { commit }),
      subdir,
      targetVersion: cache.availableVersion ?? expectedTree.slice(0, 12),
      expectedTree,
    }
  }

  /** STAGE: locate the skill subtree in the GitHub archive and verify its tree hash. */
  private async stageSkillPackage(
    preflight: SkillPreflight,
    archiveBytes: Buffer,
    transaction: UpdateTransaction,
    stagingDir: string,
  ): Promise<{ tree: TreeManifest }> {
    const entries = readTarArchive(archiveBytes)
    const root = archiveRoot(entries)
    if (root === undefined) throw new Error('GitHub 归档结构异常（没有统一的根目录）')
    if (preflight.commit !== undefined
      && !root.endsWith(preflight.commit)
      && !root.endsWith(preflight.commit.slice(0, 7))) {
      throw new Error(`归档根目录 ${root} 与目标提交 ${preflight.commit.slice(0, 12)} 不匹配`)
    }
    const prefix = preflight.subdir === '' ? `${root}/` : `${root}/${preflight.subdir}/`
    const subtree = entriesUnder(entries, prefix)
    if (subtree.length === 0) throw new Error(`归档中找不到技能子目录（${preflight.subdir === '' ? '仓库根' : preflight.subdir}）`)
    const link = subtree.find(item => item.type === 'symlink' || item.type === 'hardlink')
    if (link !== undefined) throw new Error(`技能内容包含链接条目（${link.path}），为避免越界修改暂不支持自动替换`)
    const actual = gitTreeHashForEntries(entries, prefix)
    if (actual !== preflight.expectedTree) {
      throw new Error(`技能内容校验失败：目录树哈希不一致（期望 ${preflight.expectedTree}，实际 ${actual}）`)
    }
    await transaction.note('目录树哈希校验通过', {
      tree: actual,
      ...(preflight.commit === undefined ? { ref: preflight.ref } : { commit: preflight.commit }),
    })
    const stagedDir = join(stagingDir, 'skill')
    const extracted = await extractArchive(entries, stagedDir, { prefix })
    const expectedFiles = subtree
      .filter(item => item.type === 'file' && item.data !== undefined)
      .map(item => ({
        path: item.relativePath,
        size: item.data?.byteLength ?? 0,
        sha256: sha256Hex(item.data ?? Buffer.alloc(0)),
      }))
      .sort((left, right) => left.path.localeCompare(right.path))
    const expectedManifest: TreeManifest = {
      files: expectedFiles,
      symlinks: [],
      dirs: [],
      totalBytes: expectedFiles.reduce((total, file) => total + file.size, 0),
    }
    const observed = await hashTree(stagedDir)
    const comparison = compareTreeManifests(expectedManifest, observed, 20)
    if (!comparison.clean) throw new Error('技能归档解包到磁盘后的内容校验失败（写入不完整）')
    if (extracted.files.length !== expectedFiles.length) {
      throw new Error('技能归档解包后的文件数量与归档清单不一致')
    }
    const document = await readSkillDocument(stagedDir)
    if (document === undefined) throw new Error('技能归档内容缺少 SKILL.md')
    if (document.name !== undefined && document.name !== preflight.record.name) {
      throw new Error(`技能归档中的技能名不符：期望 ${preflight.record.name}，实际 ${document.name}`)
    }
    await transaction.note('技能内容校验通过', { files: expectedFiles.length, bytes: expectedManifest.totalBytes })
    return { tree: expectedManifest }
  }

  /** VALIDATE: re-read the installed skill directory after the swap. */
  private async validateSkill(preflight: SkillPreflight, expected: TreeManifest): Promise<string[]> {
    const problems: string[] = []
    const resolved = await resolveInside(preflight.rootDir, preflight.skillDir)
    if (resolved === undefined) problems.push('替换后的技能目录不在其发现根内')
    const document = await readSkillDocument(preflight.skillDir)
    if (document === undefined) problems.push('替换后的技能目录缺少 SKILL.md')
    else if (document.name !== undefined && document.name !== preflight.record.name) {
      problems.push(`替换后的技能名不符：${document.name}`)
    }
    const symlink = await containsSymlink(preflight.skillDir)
    if (symlink !== undefined) problems.push(`替换后的技能目录出现符号链接：${symlink}`)
    const observed = await hashTree(preflight.skillDir)
    const comparison = compareTreeManifests(expected, observed, 20)
    if (!comparison.clean) {
      problems.push(`替换后的目录内容与归档不一致（新增 ${String(comparison.added.length)}、不同 ${String(comparison.modified.length)}、缺失 ${String(comparison.missing.length)}）`)
    }
    return problems
  }

  /** Failure path of a skill update: restore the original directory, then report. */
  private async finishSkillFailure(input: {
    entry: UpdatePlanEntry
    transaction: UpdateTransaction
    preflight: SkillPreflight | undefined
    backup: BackupResult | undefined
    movedAside: boolean
    asideDir: string
    error: unknown
    options: RunOptions
  }): Promise<ItemOutcome> {
    const { transaction, preflight, backup } = input
    const blocked = input.error instanceof PreflightBlockedError
    const aborted = input.error instanceof UpdateAbortedError
    const message = blocked || aborted ? messageOf(input.error) : `更新失败：${messageOf(input.error)}`
    try {
      await transaction.fail(message, {
        ...(blocked ? { blocked: true } : {}),
        ...(aborted ? { aborted: true } : {}),
      })
      await transaction.setPhase('RECOVERY', '恢复技能目录')
    } catch (error) {
      this.log.warn('updates.skill-recovery-phase-write-failed', { message: errorText(error) })
    }
    let recovered = !input.movedAside
    let rolledBack = false
    const problems: string[] = []
    if (preflight !== undefined && input.movedAside) {
      if (backup !== undefined) {
        const report = await this.backup.restoreSkill(backup, preflight.skillDir)
        recovered = report.ok
        rolledBack = report.ok
        problems.push(...report.problems)
      } else {
        try {
          if (existsSync(preflight.skillDir)) await removeTree(preflight.skillDir)
          await moveTree(input.asideDir, preflight.skillDir)
          recovered = true
          rolledBack = true
        } catch (error) {
          recovered = false
          problems.push(`无法移回原技能目录：${messageOf(error)}`)
        }
      }
    }
    // The `skill-old` copy is not a live directory; remove it once recovery succeeded.
    if (recovered && input.asideDir !== '') await removeTree(input.asideDir).catch(() => undefined)
    this.services.skills.invalidate()
    if (!recovered) {
      const requiredMessage = `技能更新失败且无法自动恢复；备份保留在 ${backup?.dir ?? '（无备份目录）'}。技能目录可能缺文件，请人工检查。`
      try {
        await transaction.setPhase('RECOVERY_REQUIRED', requiredMessage, { problems })
        await transaction.patch({ result: requiredMessage, rolledBack: false })
      } catch (error) {
        this.log.warn('updates.skill-recovery-required-write-failed', { message: errorText(error) })
      }
      await this.appendHistory({
        kind: 'skill',
        name: input.entry.name,
        action: this.actionFor(input.entry, input.options.batch),
        outcome: 'recovery-required',
        message: `${message}；自动恢复失败：${problems.join('；')}`,
        ...(input.entry.currentVersion === undefined ? {} : { fromVersion: input.entry.currentVersion }),
        ...(input.entry.targetVersion === undefined ? {} : { toVersion: input.entry.targetVersion }),
        transactionId: transaction.record.id,
      })
      return {
        status: 'recovery-required',
        message: requiredMessage,
        transactionId: transaction.record.id,
        ...(input.entry.currentVersion === undefined ? {} : { fromVersion: input.entry.currentVersion }),
        ...(input.entry.targetVersion === undefined ? {} : { toVersion: input.entry.targetVersion }),
        stopBatch: true,
      }
    }
    const resultMessage = rolledBack
      ? '技能更新失败，已从备份回滚原目录'
      : (blocked || aborted ? message : '技能更新失败，未修改技能目录')
    try {
      await transaction.setPhase('RECOVERED', resultMessage, { rolledBack })
      await transaction.patch({ ...(rolledBack ? { rolledBack: true } : {}), result: resultMessage })
    } catch (error) {
      this.log.warn('updates.skill-recovered-write-failed', { message: errorText(error) })
    }
    await this.appendHistory({
      kind: 'skill',
      name: input.entry.name,
      action: this.actionFor(input.entry, input.options.batch),
      outcome: blocked || aborted ? 'blocked' : (rolledBack ? 'rolled-back' : 'failed'),
      message: resultMessage,
      ...(input.entry.currentVersion === undefined ? {} : { fromVersion: input.entry.currentVersion }),
      ...(input.entry.targetVersion === undefined ? {} : { toVersion: input.entry.targetVersion }),
      transactionId: transaction.record.id,
    })
    return {
      status: blocked || aborted ? 'skipped' : (rolledBack ? 'rolled-back' : 'failed'),
      message: resultMessage,
      transactionId: transaction.record.id,
      ...(input.entry.currentVersion === undefined ? {} : { fromVersion: input.entry.currentVersion }),
      ...(input.entry.targetVersion === undefined ? {} : { toVersion: input.entry.targetVersion }),
      ...(aborted ? { stopBatch: true } : {}),
    }
  }

  // ---------------------------------------------------------------------
  // Startup reconciliation
  // ---------------------------------------------------------------------

  /** Reconcile one open transaction with the current disk state. */
  private async recoverOne(transaction: UpdateTransaction): Promise<void> {
    const record = transaction.record
    if (record.kind === 'skill') {
      await this.recoverSkillTransaction(transaction)
      return
    }
    if (record.phase === 'PENDING_RESTART') {
      const problems = await this.verifyPluginVersion(record)
      if (problems.length === 0) {
        await transaction.setPhase('VERIFIED', '重启后确认版本与启用状态正确')
        await transaction.patch({ needsRestart: false, result: '重启后已确认更新生效' })
        await this.appendHistory({
          kind: 'plugin-bundle',
          name: record.name,
          action: 'update',
          outcome: 'success',
          message: '重启后已确认更新生效',
          ...(record.previousVersion === undefined ? {} : { fromVersion: record.previousVersion }),
          ...(record.targetVersion === undefined ? {} : { toVersion: record.targetVersion }),
          transactionId: record.id,
        })
        return
      }
      await transaction.setPhase('RECOVERY', `重启后校验失败：${problems.join('；')}`)
      await this.attemptPluginRestore(transaction)
      return
    }
    if (record.phase === 'INSTALL' || record.phase === 'VALIDATE' || record.phase === 'RECOVERY' || record.phase === 'FAILED') {
      await this.attemptPluginRestore(transaction)
      return
    }
    // PREFLIGHT/BACKUP/DOWNLOAD/STAGE never touch the live install tree.
    await transaction.setPhase('RECOVERED', '进程中断于替换之前，未修改安装内容')
    await transaction.patch({ result: '上一次更新在替换前中断，未产生修改' })
    await this.appendHistory({
      kind: 'plugin-bundle',
      name: record.name,
      action: 'update',
      outcome: 'blocked',
      message: '上一次更新在替换前中断，未产生修改',
      transactionId: record.id,
    })
  }

  /** Reconcile one interrupted skill transaction. */
  private async recoverSkillTransaction(transaction: UpdateTransaction): Promise<void> {
    const record = transaction.record
    if (record.phase === 'PREFLIGHT' || record.phase === 'BACKUP' || record.phase === 'DOWNLOAD' || record.phase === 'STAGE') {
      await transaction.setPhase('RECOVERED', '进程中断于替换之前，未修改技能目录')
      await transaction.patch({ result: '上一次技能更新在替换前中断，未产生修改' })
      await this.appendHistory({
        kind: 'skill',
        name: record.name,
        action: 'skill-update',
        outcome: 'blocked',
        message: '上一次技能更新在替换前中断，未产生修改',
        transactionId: record.id,
      })
      return
    }
    const inventory = await this.services.skills.scan({ refresh: true })
    const skill = inventory.physical.find(item => item.id === record.extensionId)
    const skillDir = skill?.paths.installDir
    if (record.phase === 'PENDING_RESTART') {
      if (skillDir === undefined) {
        await transaction.setPhase('RECOVERY_REQUIRED', '找不到技能目录，无法确认更新结果')
        return
      }
      const document = await readSkillDocument(skillDir)
      if (document !== undefined) {
        await transaction.setPhase('VERIFIED', '技能目录存在，事务已确认')
        await this.appendHistory({
          kind: 'skill',
          name: record.name,
          action: 'skill-update',
          outcome: 'success',
          message: '技能目录存在，事务已确认',
          transactionId: record.id,
        })
        return
      }
      await transaction.setPhase('RECOVERY', '技能目录缺少 SKILL.md，尝试从备份恢复')
      await this.attemptSkillRestore(transaction, skillDir)
      return
    }
    await this.attemptSkillRestore(transaction, skillDir)
  }

  /** Ensure a transaction is in RECOVERY before a restore attempt (crash paths may be mid-phase). */
  private async ensureRecoveryPhase(transaction: UpdateTransaction, message: string): Promise<boolean> {
    try {
      if (transaction.record.phase === 'RECOVERY') return true
      if (transaction.record.phase === 'FAILED') {
        await transaction.setPhase('RECOVERY', message)
        return true
      }
      await transaction.setPhase('FAILED', message)
      await transaction.setPhase('RECOVERY', message)
      return true
    } catch (error) {
      this.log.warn('updates.recovery-phase-unavailable', {
        phase: transaction.record.phase,
        message: errorText(error),
      })
      return false
    }
  }

  /** Try to restore an interrupted plugin transaction from its verified backup. */
  private async attemptPluginRestore(transaction: UpdateTransaction): Promise<void> {
    const record = transaction.record
    if (!(await this.ensureRecoveryPhase(transaction, '检测到中断的更新事务，尝试从备份恢复'))) return
    const liveDir = await this.resolvePluginInstallDir(record)
    const backup = await this.loadBackup(record.id)
    if (backup === undefined || liveDir === undefined) {
      const reason = liveDir === undefined ? '找不到插件安装目录' : '找不到可用的备份目录'
      await transaction.setPhase('RECOVERY_REQUIRED', `中断事务无法自动恢复：${reason}；备份保留在 ${record.backupDir ?? '（无备份）'}`)
      await this.appendHistory({
        kind: 'plugin-bundle',
        name: record.name,
        action: 'update',
        outcome: 'recovery-required',
        message: `中断事务无法自动恢复：${reason}`,
        transactionId: record.id,
      })
      return
    }
    const report = await this.backup.restorePlugin(backup, liveDir)
    if (report.ok) {
      await transaction.setPhase('RECOVERED', '已从中断的更新中恢复到备份版本', { rolledBack: true })
      await transaction.patch({ rolledBack: true, result: '已从中断的更新中恢复到备份版本' })
      this.services.plugins.invalidate()
      await this.appendHistory({
        kind: 'plugin-bundle',
        name: record.name,
        action: 'update',
        outcome: 'rolled-back',
        message: '已从中断的更新中恢复到备份版本',
        transactionId: record.id,
      })
      return
    }
    await transaction.setPhase('RECOVERY_REQUIRED', `中断事务恢复失败：${report.problems.join('；')}`)
    await transaction.patch({ result: `中断事务恢复失败；备份保留在 ${backup.dir}` })
    await this.appendHistory({
      kind: 'plugin-bundle',
      name: record.name,
      action: 'update',
      outcome: 'recovery-required',
      message: `中断事务恢复失败：${report.problems.join('；')}`,
      transactionId: record.id,
    })
  }

  /** Try to restore an interrupted skill transaction from its verified backup. */
  private async attemptSkillRestore(transaction: UpdateTransaction, skillDir: string | undefined): Promise<void> {
    const record = transaction.record
    if (!(await this.ensureRecoveryPhase(transaction, '检测到中断的技能更新事务，尝试从备份恢复'))) return
    const backup = await this.loadBackup(record.id)
    if (backup === undefined || skillDir === undefined) {
      await transaction.setPhase('RECOVERY_REQUIRED', '中断事务无法自动恢复：找不到技能目录或备份')
      return
    }
    const report = await this.backup.restoreSkill(backup, skillDir)
    if (report.ok) {
      await transaction.setPhase('RECOVERED', '已从中断的更新中恢复技能目录', { rolledBack: true })
      await transaction.patch({ rolledBack: true, result: '已从中断的更新中恢复技能目录' })
      this.services.skills.invalidate()
      await this.appendHistory({
        kind: 'skill',
        name: record.name,
        action: 'skill-update',
        outcome: 'rolled-back',
        message: '已从中断的更新中恢复技能目录',
        transactionId: record.id,
      })
      return
    }
    await transaction.setPhase('RECOVERY_REQUIRED', `中断事务恢复失败：${report.problems.join('；')}`)
    await transaction.patch({ result: `中断事务恢复失败；备份保留在 ${backup.dir}` })
    await this.appendHistory({
      kind: 'skill',
      name: record.name,
      action: 'skill-update',
      outcome: 'recovery-required',
      message: `中断事务恢复失败：${report.problems.join('；')}`,
      transactionId: record.id,
    })
  }

  /** Read a backup directory recorded by a previous process. */
  private async loadBackup(transactionId: string): Promise<BackupResult | undefined> {
    try {
      return await this.backup.loadBackup(transactionId)
    } catch {
      return undefined
    }
  }

  /** Resolve the install directory of a plugin from the refreshed inventory / package resolver. */
  private async resolvePluginInstallDir(record: TransactionRecord): Promise<string | undefined> {
    try {
      const inventory = await this.services.plugins.scan({ refresh: true })
      const found = inventory.bundles.find(item => item.id === record.extensionId)
      if (found?.paths.installDir !== undefined) return found.paths.installDir
    } catch (error) {
      this.log.warn('updates.recover.inventory-failed', { message: errorText(error) })
    }
    return resolvePackageDirectory(this.services.facts, record.name)
  }

  /** Validate a pending-restart plugin's version and enablement. */
  private async verifyPluginVersion(record: TransactionRecord): Promise<string[]> {
    if (record.targetVersion === undefined) return ['事务没有记录目标版本']
    let manager: PluginManager
    try {
      manager = this.pluginManager()
    } catch (error) {
      return [messageOf(error)]
    }
    let bundles: BundleInfo[]
    try {
      bundles = await manager.listBundles()
    } catch (error) {
      return [`无法读取 listBundles：${messageOf(error)}`]
    }
    const current = bundles.find(bundle => bundle.name === record.name)
    if (current === undefined) return ['listBundles 中找不到该组合包']
    if (current.version !== record.targetVersion) {
      return [`版本为 ${current.version ?? '未知'}，期望 ${record.targetVersion}`]
    }
    return []
  }
}

// -------------------------------------------------------------------------
// Small helpers
// -------------------------------------------------------------------------

/** Filesystem noise filter for local-modification comparisons. */
function isLocalNoise(relativePath: string): boolean {
  const segments = relativePath.split('/')
  if (segments.some(segment => segment === 'node_modules' || segment === '.git')) return true
  const name = segments.at(-1) ?? ''
  return IGNORED_LOCAL_FILES.has(name)
}

/** Normalize a skill source subdirectory; `undefined` means the value is unsafe. */
function normalizeSubdir(raw: string | undefined): string | undefined {
  if (raw === undefined) return ''
  const trimmed = raw.trim().replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (trimmed === '' || trimmed === '.') return ''
  const segments = trimmed.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined
  if (segments.some(segment => /^[A-Za-z]:/u.test(segment))) return undefined
  return trimmed
}

/** Read one JSON file, returning `undefined` for missing or unreadable files. */
async function readJsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Verify the downloaded tarball against the published `dist.integrity` or
 * `dist.shasum`. Returns a problem description, or `undefined` when the
 * registry published no checksum or the checksum matches.
 */
export function verifyTarballIntegrity(buffer: Buffer, manifest: NpmVersionManifest): string | undefined {
  const integrity = manifest.dist?.integrity
  if (integrity !== undefined && integrity.trim() !== '') {
    for (const part of integrity.trim().split(/\s+/u)) {
      const match = /^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/u.exec(part)
      if (match === null) continue
      const algorithm = match[1] ?? ''
      const expected = match[2] ?? ''
      try {
        const actual = createHash(algorithm).update(buffer).digest('base64')
        if (actual === expected) return undefined
        return `dist.integrity 校验失败（${algorithm}）`
      } catch {
        continue
      }
    }
  }
  const shasum = manifest.dist?.shasum
  if (shasum !== undefined && shasum.trim() !== '') {
    const actual = createHash('sha1').update(buffer).digest('hex')
    if (actual !== shasum.trim().toLowerCase()) return 'dist.shasum 校验失败'
  }
  return undefined
}
