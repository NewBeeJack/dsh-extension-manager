/**
 * Plugin update checking: npm packages, git installs, and the honest answers
 * for everything that has no reliable upstream.
 *
 * The checker never writes durable state (the check service persists the
 * returned cache entries) and never performs an update. Its one job is to
 * compare each installed bundle with its recorded source and return a
 * `CheckCacheEntry` per record:
 *
 *   npm  → dist-tags.latest / next+rc / prerelease vs the installed semver,
 *          plus the candidate's `engines.dsh` / dsh peers against the running
 *          DSH version (app-boot semantics);
 *   git  → installed commit (bundle info, else `pnpm-lock.yaml` resolution)
 *          vs the remote ref from `git ls-remote`;
 *   local-link / local-path / tarball / unknown / official → `no-source` or
 *          `needs-source` with a Chinese explanation.
 *
 * A network or timeout failure is reported as `network-error` / `check-failed`
 * and is never presented as "up to date". At most four lookups run at once,
 * each bounded in time and abortable.
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PluginBundleRecord, SourceInfo, UpdateStatus } from '../../shared/types'
import type { CheckBatchResult, CheckOutcome, PluginUpdateChecker } from '../contracts'
import { errorText, type ManagerLog } from '../logs'
import type { CheckCacheEntry, ManagerState } from '../state'
import { lockfilePath, profileFacts, runtimeVersion, type ProfileFacts } from '../env'
import {
  describeRegistry,
  evaluatePluginCompatibility,
  fetchNpmDocument,
  manifestOf,
  normalizeSemver,
  registryPolicy,
  selectUpdateCandidate,
  type CompatibilityEvaluation,
  type NpmRegistryPolicy,
} from './npmClient'
import {
  isCommitRef,
  isTagRef,
  parseGitSpec,
  parseLockfileGitResolution,
  resolveRemoteCommit,
  type GitRefType,
  type GitSpec,
  type RemoteCommitResult,
} from './gitClient'

/** At most four registry / git lookups run at once. */
const MAX_CONCURRENCY = 4
/** Bound for each individual network lookup (registry packument or git ls-remote). */
const CHECK_TIMEOUT_MS = 12_000
/** Cache answers younger than this are reused when the caller does not ask for a refresh. */
const CACHE_TTL_MS = 5 * 60 * 1000

/** One record's check outcome plus the bookkeeping the batch result needs. */
interface RecordResult {
  outcome: CheckOutcome
  skipped?: { recordId: string; name: string; reason: string }
  transport?: { source: string; message: string }
  itemStatus: 'ok' | 'failed'
  itemMessage?: string
}

/** Facts shared by every record in one batch run. */
interface BatchContext {
  facts: ProfileFacts | undefined
  runtimeVersion: string | undefined
  signal: AbortSignal | undefined
  refresh: boolean
  onItem: ((recordId: string, status: 'running' | 'ok' | 'failed', message?: string) => void) | undefined
  policy: () => Promise<NpmRegistryPolicy>
  lockfile: () => string | undefined
}

/** One cached answer may be reused only while it paints a definite state. */
function reusableStatus(status: UpdateStatus): boolean {
  return status === 'up-to-date'
    || status === 'update-available'
    || status === 'incompatible-update'
    || status === 'prerelease-only'
    || status === 'no-source'
    || status === 'needs-source'
}

function shortCommit(commit: string): string {
  return commit.length > 7 ? commit.slice(0, 7) : commit
}

/** Read a record's source even if a caller passed a partially-filled record. */
function sourceOf(record: PluginBundleRecord): SourceInfo | undefined {
  return (record as { source?: SourceInfo }).source
}

function currentVersionOf(record: PluginBundleRecord): string | undefined {
  return (record as { version?: { current?: string } }).version?.current
}

function selfOf(record: PluginBundleRecord): boolean {
  return (record as { self?: boolean }).self === true
}

function formatRequirements(requirements: Readonly<Record<string, string>>): string {
  const entries = Object.entries(requirements)
  if (entries.length === 0) return ''
  const shown = entries.slice(0, 3).map(([key, range]) => `${key} ${range}`)
  if (entries.length > 3) shown.push(`等 ${String(entries.length)} 项要求`)
  return shown.join('，')
}

/** Chinese clause appended to a candidate description once compatibility is known. */
function compatibilityClause(compatibility: CompatibilityEvaluation, runtime: string | undefined): string {
  if (compatibility.compatibility === 'compatible') {
    return runtime === undefined ? '，未声明 DSH 版本限制' : `，与当前 DSH ${runtime} 兼容`
  }
  if (compatibility.compatibility === 'incompatible') {
    const requirements = formatRequirements(compatibility.requirements)
    const runtimeText = runtime === undefined ? '当前 DSH' : `当前 DSH ${runtime}`
    return `，但要求 ${requirements}，与${runtimeText} 不兼容`
  }
  return compatibility.detail === undefined ? '，兼容性未知' : `；兼容性未知：${compatibility.detail}`
}

/** Build one cache entry with only the fields that actually apply. */
function cacheEntry(record: PluginBundleRecord, patch: {
  status: UpdateStatus
  availableVersion?: string
  availableCommit?: string
  availableTree?: string
  channel?: 'stable' | 'prerelease' | 'tag' | 'commit' | 'unknown'
  compatibility?: 'compatible' | 'incompatible' | 'unknown'
  compatibilityRequirements?: Record<string, string>
  detail?: string
}): CheckCacheEntry {
  const current = currentVersionOf(record)
  return {
    recordId: `plugin:${record.id}`,
    status: patch.status,
    checkedAt: new Date().toISOString(),
    ...(current === undefined ? {} : { currentVersion: current }),
    ...(patch.availableVersion === undefined ? {} : { availableVersion: patch.availableVersion }),
    ...(patch.availableCommit === undefined ? {} : { availableCommit: patch.availableCommit }),
    ...(patch.availableTree === undefined ? {} : { availableTree: patch.availableTree }),
    ...(patch.channel === undefined ? {} : { channel: patch.channel }),
    ...(patch.compatibility === undefined ? {} : { compatibility: patch.compatibility }),
    ...(patch.compatibilityRequirements === undefined || Object.keys(patch.compatibilityRequirements).length === 0
      ? {}
      : { compatibilityRequirements: patch.compatibilityRequirements }),
    ...(patch.detail === undefined ? {} : { detail: patch.detail }),
  }
}

/** Run `worker` over `items` with a fixed concurrency bound. */
async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workerCount = Math.min(concurrency, Math.max(1, items.length))
  const runners = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      await worker(item, index)
    }
  })
  await Promise.all(runners)
}

/**
 * npm-backed bundle check: registry lookup, candidate selection, compatibility.
 */
async function checkNpmRecord(
  record: PluginBundleRecord,
  source: SourceInfo,
  context: BatchContext,
): Promise<RecordResult> {
  const packageName = (source.packageName ?? record.name).trim()
  const currentRaw = currentVersionOf(record)
  if (packageName === '') {
    return staticResult(record, 'needs-source', '安装清单没有记录 npm 包名，无法查询上游')
  }
  if (currentRaw === undefined) {
    return staticResult(record, 'check-failed', '安装清单没有记录当前版本，无法与 Registry 比较', 'failed')
  }
  if (normalizeSemver(currentRaw) === undefined) {
    return staticResult(record, 'check-failed', `当前版本 ${currentRaw} 不是合法的 semver，无法比较`, 'failed')
  }
  const policy = await context.policy()
  const lookup = await fetchNpmDocument(packageName, {
    policy,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    timeoutMs: CHECK_TIMEOUT_MS,
    ...(source.registry === undefined ? {} : { registry: source.registry }),
  })
  if (lookup.status === 'unavailable') {
    if (context.signal?.aborted === true) {
      return staticResult(record, 'check-failed', '检查已取消：未完成 Registry 查询', 'failed')
    }
    const allUnconfigured = lookup.attempts.length > 0
      && lookup.attempts.every(attempt => attempt.kind === 'unconfigured')
    if (allUnconfigured) {
      return staticResult(
        record,
        'check-failed',
        '无法读取 pnpm 的 registry 配置（registries().resolved 为空），没有可查询的上游 Registry；请检查 DSH 的 registry 设置',
        'failed',
      )
    }
    const detail = lookupFailureText('Registry', lookup.attempts)
    const first = lookup.attempts[0]
    return {
      outcome: {
        recordId: `plugin:${record.id}`,
        cache: cacheEntry(record, { status: 'network-error', detail }),
      },
      itemStatus: 'failed',
      itemMessage: detail,
      transport: {
        source: first === undefined ? 'npm' : `npm:${describeRegistry(first.registry)}`,
        message: detail,
      },
    }
  }
  if (lookup.status === 'not-found') {
    const registries = lookup.attempts.map(attempt => describeRegistry(attempt.registry)).join('、')
    return staticResult(
      record,
      'needs-source',
      `上游 Registry（${registries}）找不到包 ${packageName}；请确认包名或安装来源`,
    )
  }
  if (lookup.status === 'invalid') {
    return staticResult(record, 'check-failed', lookup.message, 'failed')
  }
  const document = lookup.document
  const evaluation = selectUpdateCandidate(document['dist-tags'], currentRaw)
  if (evaluation.kind === 'no-candidate') {
    return staticResult(record, 'check-failed', evaluation.detail, 'failed')
  }
  if (evaluation.kind === 'up-to-date') {
    const detail = upToDateDetail(evaluation, currentRaw)
    return {
      outcome: {
        recordId: `plugin:${record.id}`,
        cache: cacheEntry(record, {
          status: 'up-to-date',
          ...(evaluation.version === undefined ? {} : { availableVersion: evaluation.version }),
          ...(evaluation.channel === undefined ? {} : { channel: evaluation.channel }),
          detail,
        }),
      },
      itemStatus: 'ok',
      itemMessage: detail,
    }
  }
  const candidate = evaluation.candidate
  const manifest = manifestOf(document, candidate.version)
  const compatibility = evaluatePluginCompatibility(manifest, context.runtimeVersion)
  const channel: 'stable' | 'prerelease' = candidate.channel
  if (evaluation.kind === 'prerelease-only') {
    const stableText = evaluation.stable === undefined ? '' : `，稳定版仍为 ${evaluation.stable.version}`
    const detail = `仅有预发布版本 ${candidate.version}（${candidate.tag}）${stableText}；预发布版本默认不建议自动更新${compatibilityClause(compatibility, context.runtimeVersion)}`
    return {
      outcome: {
        recordId: `plugin:${record.id}`,
        cache: cacheEntry(record, {
          status: 'prerelease-only',
          availableVersion: candidate.version,
          channel,
          compatibility: compatibility.compatibility,
          compatibilityRequirements: compatibility.requirements,
          detail,
        }),
      },
      itemStatus: 'ok',
      itemMessage: detail,
    }
  }
  if (compatibility.compatibility === 'incompatible') {
    const detail = `Registry 最新版本 ${candidate.version}（当前 ${currentRaw}）${compatibilityClause(compatibility, context.runtimeVersion)}；请等待兼容版本或先升级 DSH`
    return {
      outcome: {
        recordId: `plugin:${record.id}`,
        cache: cacheEntry(record, {
          status: 'incompatible-update',
          availableVersion: candidate.version,
          channel,
          compatibility: compatibility.compatibility,
          compatibilityRequirements: compatibility.requirements,
          detail,
        }),
      },
      itemStatus: 'ok',
      itemMessage: detail,
    }
  }
  const channelText = channel === 'stable' ? 'Registry 最新稳定版' : '预发布通道'
  const detail = `${channelText} ${candidate.version}（当前 ${currentRaw}）${compatibilityClause(compatibility, context.runtimeVersion)}`
  return {
    outcome: {
      recordId: `plugin:${record.id}`,
      cache: cacheEntry(record, {
        status: 'update-available',
        availableVersion: candidate.version,
        channel,
        compatibility: compatibility.compatibility,
        compatibilityRequirements: compatibility.requirements,
        detail,
      }),
    },
    itemStatus: 'ok',
    itemMessage: detail,
  }
}

/** Chinese explanation for "no update" that stays honest about which version was compared. */
function upToDateDetail(
  evaluation: Extract<ReturnType<typeof selectUpdateCandidate>, { kind: 'up-to-date' }>,
  currentRaw: string,
): string {
  if (evaluation.version === undefined) return `当前版本 ${currentRaw} 已是最新版本`
  const current = normalizeSemver(currentRaw)
  const known = normalizeSemver(evaluation.version)
  const sameVersion = current !== undefined && known !== undefined && current === known
  if (evaluation.channel === 'stable') {
    if (sameVersion) return `已是最新稳定版 ${evaluation.version}`
    return `当前版本 ${currentRaw} 高于 Registry 最新稳定版 ${evaluation.version}，无需更新`
  }
  if (sameVersion) return `已是最新版本 ${evaluation.version}`
  return `当前版本 ${currentRaw} 没有更新的稳定版或预发布版本（Registry 最新标签版本 ${evaluation.version}）`
}

/** Readable summary of why every registry attempt failed. */
function lookupFailureText(
  noun: string,
  attempts: readonly { registry: string; kind: string; message: string }[],
): string {
  if (attempts.length === 0) return `${noun} 查询失败：没有可用的 registry 配置`
  const parts = attempts.map(attempt => {
    const label = describeRegistry(attempt.registry)
    const kind = attempt.kind === 'timeout' ? '超时'
      : attempt.kind === 'network' ? '无法连接'
        : attempt.kind === 'aborted' ? '已取消'
          : attempt.kind === 'unconfigured' ? '未配置'
            : attempt.kind === 'too-large' ? '响应过大'
              : attempt.kind === 'not-found' ? '包不存在'
                : attempt.kind === 'invalid-json' ? '返回内容非法'
                  : '请求失败'
    return `${label} ${kind}${attempt.message === '' ? '' : `（${attempt.message}）`}`
  })
  return `${noun} 查询失败：${parts.join('；')}`
}

/** Build the outcome of a record that needs no network lookup. */
function staticResult(
  record: PluginBundleRecord,
  status: 'no-source' | 'needs-source' | 'check-failed',
  detail: string,
  itemStatus: 'ok' | 'failed' = 'ok',
): RecordResult {
  return {
    outcome: {
      recordId: `plugin:${record.id}`,
      cache: cacheEntry(record, { status, detail }),
    },
    skipped: { recordId: record.id, name: record.name, reason: detail },
    itemStatus,
    itemMessage: detail,
  }
}

/** Whether the installed commit and the remote commit name the same object (abbreviations match too). */
function sameCommit(installed: string, remote: string): boolean {
  const local = installed.trim().toLowerCase()
  const target = remote.trim().toLowerCase()
  if (local === target) return true
  const shorter = local.length <= target.length ? local : target
  const longer = local.length <= target.length ? target : local
  return shorter.length >= 7 && longer.startsWith(shorter)
}

/** The provenance summary appended to git details. */
function gitRefLabel(ref: string | undefined): string {
  return ref === undefined ? '默认分支 HEAD' : `ref ${ref}`
}

/** Map a git remote failure onto a check status. */
function gitFailureResult(
  record: PluginBundleRecord,
  url: string,
  ref: string | undefined,
  failure: Extract<RemoteCommitResult, { ok: false }>,
  signal: AbortSignal | undefined,
): RecordResult {
  if (failure.kind === 'aborted' || signal?.aborted === true) {
    return staticResult(record, 'check-failed', '检查已取消：未完成 Git 查询', 'failed')
  }
  if (failure.kind === 'network' || failure.kind === 'timeout') {
    const label = failure.kind === 'timeout' ? 'Git 远端查询超时' : '无法连接 Git 远端仓库'
    return {
      outcome: {
        recordId: `plugin:${record.id}`,
        cache: cacheEntry(record, { status: 'network-error', detail: `${label}：${failure.message}` }),
      },
      itemStatus: 'failed',
      itemMessage: `${label}：${failure.message}`,
      transport: { source: `git:${url}`, message: failure.message },
    }
  }
  if (failure.kind === 'git-missing') {
    return staticResult(record, 'check-failed', '本机未安装 git，无法查询远端 commit；请安装 git 后重试', 'failed')
  }
  if (failure.kind === 'not-found') {
    return staticResult(record, 'check-failed', `远端仓库找不到 ${gitRefLabel(ref)}：${failure.message}`, 'failed')
  }
  return staticResult(record, 'check-failed', `Git 查询失败：${failure.message}`, 'failed')
}

/** Git-backed bundle check: installed commit vs remote ref. */
async function checkGitRecord(
  record: PluginBundleRecord,
  source: SourceInfo,
  context: BatchContext,
  lockfileText: string | undefined,
): Promise<RecordResult> {
  const spec: GitSpec | undefined = parseGitSpec(source.spec)
    ?? parseGitSpec(source.url)
    ?? (source.repo === undefined ? undefined : parseGitSpec(source.repo))
  if (spec === undefined) {
    return staticResult(record, 'needs-source', '无法解析该记录的 Git 安装地址，无法核对远端 commit')
  }
  const lockResolution = lockfileText === undefined || record.name === ''
    ? undefined
    : parseLockfileGitResolution(lockfileText, record.name)
  const recordedCommit = (source.commit ?? '').trim() === '' ? undefined : source.commit
  const versionCommit = (record.version?.currentCommit ?? '').trim() === '' ? undefined : record.version.currentCommit
  const installedCommit = recordedCommit ?? versionCommit ?? lockResolution?.commit
  const installedFromLockfile = recordedCommit === undefined && versionCommit === undefined && lockResolution?.commit !== undefined
  const ref = source.ref ?? spec.ref
  const refType: GitRefType = ref === undefined
    ? 'unknown'
    : isCommitRef(ref) ? 'commit' : isTagRef(ref) ? 'tag' : 'branch'
  const remoteUrl = spec.url
  if (refType === 'commit' && ref !== undefined) {
    // A pinned commit is already the requested state; nothing to ask the remote.
    const detail = installedCommit === undefined
      ? `安装规格锁定在 commit ${shortCommit(ref)}，不跟随分支/标签更新`
      : `安装规格锁定在 commit ${shortCommit(ref)}；已安装 commit ${shortCommit(installedCommit)}`
    return {
      outcome: {
        recordId: `plugin:${record.id}`,
        cache: cacheEntry(record, {
          status: 'up-to-date',
          availableCommit: ref.toLowerCase(),
          channel: 'commit',
          detail,
        }),
      },
      itemStatus: 'ok',
      itemMessage: detail,
    }
  }
  if (installedCommit === undefined) {
    return staticResult(
      record,
      'needs-source',
      '无法确定已安装的 commit（Bundle 信息与 pnpm-lock.yaml 都未记录），因此不能判断 Git 安装是否有更新',
    )
  }
  const remote = await resolveRemoteCommit(
    {
      url: remoteUrl,
      ...(ref === undefined ? {} : { ref, refType }),
    },
    {
      timeoutMs: CHECK_TIMEOUT_MS,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    },
  )
  if (!remote.ok) return gitFailureResult(record, remoteUrl, ref, remote, context.signal)
  const availableCommit = remote.commit.toLowerCase()
  const channel: 'tag' | 'commit' = remote.version === undefined ? 'commit' : 'tag'
  const refLabel = remote.refName === undefined || remote.refName === 'HEAD'
    ? gitRefLabel(ref)
    : remote.refName.replace(/^refs\/(heads|tags)\//u, '')
  if (sameCommit(installedCommit, availableCommit)) {
    const detail = `已是最新：${refLabel} ${shortCommit(remote.commit)}`
    return {
      outcome: {
        recordId: `plugin:${record.id}`,
        cache: cacheEntry(record, {
          status: 'up-to-date',
          availableCommit: remote.commit,
          channel,
          detail,
        }),
      },
      itemStatus: 'ok',
      itemMessage: detail,
    }
  }
  const lockfileHint = installedFromLockfile ? '，已安装 commit 取自 pnpm-lock.yaml' : ''
  const detail = `远端 ${refLabel} 已更新：${shortCommit(remote.commit)}（本地 ${shortCommit(installedCommit)}${lockfileHint}）；Git 安装的 DSH 兼容性需在更新前核对上游 package.json`
  return {
    outcome: {
      recordId: `plugin:${record.id}`,
      cache: cacheEntry(record, {
        status: 'update-available',
        availableCommit: remote.commit,
        channel,
        compatibility: 'unknown',
        detail,
      }),
    },
    itemStatus: 'ok',
    itemMessage: detail,
  }
}

/**
 * The `PluginUpdateChecker` implementation wired into the Host. Constructor
 * signature is part of the module contract: `(ctx, state, log)`.
 */
export class PluginUpdateCheckerImpl implements PluginUpdateChecker {
  protected readonly ctx: Context
  protected readonly state: ManagerState
  protected readonly log: ManagerLog
  private lockfileCache: { dir: string; mtimeMs: number; text: string | undefined } | undefined

  constructor(ctx: Context, state: ManagerState, log: ManagerLog) {
    this.ctx = ctx
    this.state = state
    this.log = log
  }

  /** Check every record, at most four lookups at a time. */
  async check(
    records: readonly PluginBundleRecord[],
    options: { refresh?: boolean; signal?: AbortSignal; onItem?: (recordId: string, status: 'running' | 'ok' | 'failed', message?: string) => void },
  ): Promise<CheckBatchResult> {
    const startedAt = Date.now()
    const facts = profileFacts(this.ctx)
    let policyPromise: Promise<NpmRegistryPolicy> | undefined
    const context: BatchContext = {
      facts,
      runtimeVersion: facts === undefined ? undefined : runtimeVersion(facts),
      signal: options.signal,
      refresh: options.refresh === true,
      onItem: options.onItem,
      policy: () => {
        policyPromise ??= registryPolicy(this.ctx)
        return policyPromise
      },
      lockfile: () => this.readLockfile(facts),
    }
    const results = new Array<RecordResult | undefined>(records.length)
    await runPool(records, MAX_CONCURRENCY, async (record, index) => {
      context.onItem?.(record.id, 'running')
      let result: RecordResult
      try {
        result = await this.checkRecord(record, context)
      } catch (error) {
        const detail = `检查失败：${errorText(error)}`
        result = {
          outcome: {
            recordId: `plugin:${record.id}`,
            cache: cacheEntry(record, { status: 'check-failed', detail }),
          },
          itemStatus: 'failed',
          itemMessage: detail,
        }
        this.log.warn('plugin-updates.record-failed', { record: record.id, error: errorText(error) })
      }
      results[index] = result
      context.onItem?.(record.id, result.itemStatus, result.itemMessage)
    })
    const outcomes: CheckOutcome[] = []
    const skipped: Array<{ recordId: string; name: string; reason: string }> = []
    const transportErrors: Array<{ source: string; message: string }> = []
    const transportSeen = new Set<string>()
    for (const result of results) {
      if (result === undefined) continue
      outcomes.push(result.outcome)
      if (result.skipped !== undefined) skipped.push(result.skipped)
      if (result.transport !== undefined && !transportSeen.has(result.transport.source)) {
        transportSeen.add(result.transport.source)
        transportErrors.push(result.transport)
      }
    }
    const message = summarize(outcomes.map(outcome => outcome.cache.status), transportErrors.length)
    this.log.info('plugin-updates.checked', {
      checked: outcomes.length,
      skipped: skipped.length,
      transportErrors: transportErrors.length,
      durationMs: Date.now() - startedAt,
      ...(facts === undefined ? {} : { profile: facts.name }),
    })
    return { outcomes, skipped, transportErrors, message }
  }

  /** Check one record and map it onto a cache entry. */
  private async checkRecord(record: PluginBundleRecord, context: BatchContext): Promise<RecordResult> {
    const recordId = `plugin:${record.id}`
    if (context.signal?.aborted === true) {
      return staticResult(record, 'check-failed', '检查已取消：未完成', 'failed')
    }
    const cached = context.refresh ? undefined : this.reusableCache(recordId)
    if (cached !== undefined) {
      return {
        outcome: { recordId, cache: cached },
        skipped: { recordId: record.id, name: record.name, reason: '使用 5 分钟内的检查缓存' },
        itemStatus: 'ok',
        itemMessage: cached.detail ?? '使用缓存结果',
      }
    }
    const source = sourceOf(record)
    if (selfOf(record)) {
      return staticResult(record, 'no-source', '扩展管理器自身不参与此处更新检查，其更新需要重新打包安装')
    }
    if (record.official === true || record.availability === 'installation' || source?.kind === 'official') {
      return staticResult(record, 'no-source', '该组件随 DSH 安装提供，版本随 DSH 发行版更新，不单独检查')
    }
    if (source === undefined) {
      return staticResult(record, 'needs-source', '缺少安装来源信息，无法确定可核对的上游')
    }
    const lockfileText = source.kind === 'git' || source.kind === 'github'
      ? context.lockfile()
      : undefined
    switch (source.kind) {
      case 'npm':
        return checkNpmRecord(record, source, context)
      case 'git':
      case 'github':
        return checkGitRecord(record, source, context, lockfileText)
      case 'local-link':
        return staticResult(record, 'no-source', '本地链接安装（link:）不查询远端更新，更新由开发者负责')
      case 'local-path':
        return staticResult(record, 'no-source', '本地目录安装（file:）不查询远端更新，更新由开发者负责')
      case 'tarball':
        return staticResult(record, 'needs-source', '压缩包安装需要先确认可信的上游地址，才能检查更新')
      case 'unknown':
        return staticResult(record, 'needs-source', '安装来源不明确，无法确定可核对的上游；需要先确认来源')
      default:
        return staticResult(record, 'no-source', '该安装来源不支持远程更新检查')
    }
  }

  /** Read the profile lockfile, re-reading only when it changed on disk. */
  private readLockfile(facts: ProfileFacts | undefined): string | undefined {
    if (facts === undefined) return undefined
    const file = lockfilePath(facts)
    try {
      const mtimeMs = statSync(file).mtimeMs
      const cached = this.lockfileCache
      if (cached !== undefined && cached.dir === facts.dir && cached.mtimeMs === mtimeMs) return cached.text
      const text = readFileSync(file, 'utf8')
      this.lockfileCache = { dir: facts.dir, mtimeMs, text }
      return text
    } catch {
      this.lockfileCache = { dir: facts.dir, mtimeMs: 0, text: undefined }
      return undefined
    }
  }

  /** A fresh cached answer that still represents a definite state, if any. */
  private reusableCache(recordId: string): CheckCacheEntry | undefined {
    const cached = this.state.check(recordId)
    if (cached === undefined) return undefined
    if (!reusableStatus(cached.status)) return undefined
    const at = Date.parse(cached.checkedAt)
    if (!Number.isFinite(at) || Date.now() - at >= CACHE_TTL_MS) return undefined
    return cached
  }
}

/** One-line Chinese summary of a batch result. */
function summarize(statuses: readonly UpdateStatus[], transportCount: number): string {
  const count = (status: UpdateStatus): number => statuses.filter(item => item === status).length
  const updates = count('update-available')
  const incompatible = count('incompatible-update')
  const prerelease = count('prerelease-only')
  const latest = count('up-to-date')
  const unverifiable = count('network-error') + count('check-failed')
  const noSource = count('no-source') + count('needs-source')
  const parts = [`已检查 ${String(statuses.length)} 项插件`]
  if (updates > 0) parts.push(`${String(updates)} 项有可用更新`)
  if (incompatible > 0) parts.push(`${String(incompatible)} 项更新与当前 DSH 不兼容`)
  if (prerelease > 0) parts.push(`${String(prerelease)} 项仅有预发布版本`)
  if (latest > 0) parts.push(`${String(latest)} 项已是最新`)
  if (noSource > 0) parts.push(`${String(noSource)} 项缺少可核对的来源`)
  if (unverifiable > 0) parts.push(`${String(unverifiable)} 项无法完成检查`)
  const text = parts.join('，')
  return transportCount === 0 ? text : `${text}（${String(transportCount)} 个上游网络失败）`
}
