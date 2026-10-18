/**
 * Skill update checking.
 *
 * A skill copy is updated when the *folder* it was installed from changed.
 * Two provenance styles are supported:
 *   - `skills` CLI installs recorded in `~/.agents/.skill-lock.json`, whose
 *     `skillFolderHash` is the upstream GitHub tree id of the skill folder;
 *   - skills living inside a local git checkout, where the committed tree of
 *     the skill subdirectory is compared with the remote one.
 *
 * The remote side is read through the GitHub trees API (one recursive tree per
 * repository and ref), so changes elsewhere in a monorepo can never raise a
 * false update. Local content is hashed with the same git object algorithm the
 * inventory uses; text files are compared in canonical LF form. Network
 * failures, missing refs and unauthenticated rate limits are surfaced as such
 * and are never rendered as "up to date".
 */
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillRecord, UpdateStatus } from '../../shared/types'
import type { CheckBatchResult, CheckOutcome, SkillUpdateChecker } from '../contracts'
import type { CheckCacheEntry, ManagerState, SkillSourceAssociation } from '../state'
import type { ManagerLog } from '../logs'
import {
  computeSkillFolderTreeSha,
  decideSkillUpdateStatus,
  findSkillLockEntry,
  findGitRepository,
  githubRateLimitMessage,
  lockEntrySubdir,
  parseGitHubRepository,
  parseGitHubTokenOutput,
  readGitHeadTree,
  readGitRepository,
  readGitWorktreeStatus,
  readSkillLockFile,
  relativePosix,
  resolveHomeRoot,
  sameTreeSha,
  selectGitHubToken,
  shortTreeSha,
  type GitHubRepositoryRef,
  type SkillLockEntry,
  type SkillLockFile,
} from '../inventory/skillRoots'

/** How many skill checks may run at the same time. */
const CONCURRENCY = 4
/** Per-request timeout; the batch as a whole is not time-boxed. */
const REQUEST_TIMEOUT_MS = 12_000
/** Maximum files hashed for one local skill folder. */
const MAX_FOLDER_FILES = 4000
const USER_AGENT = 'dsh-extension-manager'
const GITHUB_API = 'https://api.github.com'

/** One remote folder identity. */
interface FolderTreeLookup {
  treeSha: string
  /** Recursive entries by path (trees only) — used to find monorepo subdirs. */
  entries: Map<string, string>
  truncated: boolean
}

/** Transport-level result of one GitHub API request. */
type ApiResult =
  | { ok: true; body: unknown }
  | { ok: false; kind: 'network' | 'rate-limit' | 'not-found' | 'http' | 'aborted'; message: string }

/** A skill record plus everything the checker resolved for it. */
interface CheckTarget {
  record: SkillRecord
  installDir: string
  repository: GitHubRepositoryRef
  subdir: string
  ref?: string
  /** Locally known upstream baseline (lock folder hash / confirmed tree). */
  expectedTree?: string
  /** Association confirmed through the HTTP API, when present. */
  association?: SkillSourceAssociation
  lockEntry?: SkillLockEntry
}

/** One skipped record with a Chinese reason. */
interface SkippedRecord {
  recordId: string
  name: string
  reason: string
}

/** Timeout for the lazy `gh auth token` probe. */
const GH_TOKEN_TIMEOUT_MS = 8000

/**
 * Resolve the GitHub token used for API calls.
 *
 * `GITHUB_TOKEN` / `GH_TOKEN` win when set. Otherwise this process asks the
 * already-authenticated `gh` CLI **once, lazily** (`gh auth token`, 8 s) so an
 * owner with a keyring login is not stuck on the anonymous 60/h limit. The
 * token lives only in memory: it is never logged, persisted or put in errors.
 * A missing or logged-out `gh` falls back to anonymous requests silently.
 */
let ghTokenPromise: Promise<string | undefined> | undefined

function resolveGitHubToken(): Promise<string | undefined> {
  const fromEnv = selectGitHubToken(process.env)
  if (fromEnv !== undefined) return Promise.resolve(fromEnv)
  ghTokenPromise ??= readGhCliToken()
  return ghTokenPromise
}

/** Run `gh auth token` with a hard timeout; any failure means "anonymous". */
function readGhCliToken(): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    try {
      execFile(
        'gh',
        ['auth', 'token'],
        { timeout: GH_TOKEN_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          if (error !== null) {
            resolvePromise(undefined)
            return
          }
          resolvePromise(parseGitHubTokenOutput(stdout ?? ''))
        },
      )
    } catch {
      resolvePromise(undefined)
    }
  })
}

/** Merge the caller signal with one request timeout. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Render a human reason for one failed GitHub request. */
function apiFailureMessage(
  status: number,
  headers: Headers,
  body: unknown,
  authenticated: boolean,
): { kind: 'rate-limit' | 'not-found' | 'http'; message: string } {
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  if ((status === 403 || status === 429) && remaining === '0') {
    const resetAt = reset === null ? undefined : Number(reset)
    return {
      kind: 'rate-limit',
      message: githubRateLimitMessage({
        authenticated,
        ...(resetAt === undefined || !Number.isFinite(resetAt) ? {} : { resetEpochSeconds: resetAt }),
      }),
    }
  }
  if (status === 404) return { kind: 'not-found', message: 'GitHub 上找不到该仓库、分支或目录（可能已删除或改名）' }
  const detail = typeof body === 'object' && body !== null && 'message' in body && typeof (body as { message: unknown }).message === 'string'
    ? (body as { message: string }).message
    : ''
  return { kind: 'http', message: `GitHub API 返回 HTTP ${String(status)}${detail === '' ? '' : `：${detail}`}` }
}

/** Read one GitHub API JSON document with timeout and rate-limit handling. */
async function requestJson(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<ApiResult> {
  const token = await resolveGitHubToken()
  const authenticated = token !== undefined
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': USER_AGENT,
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      signal: requestSignal(signal, timeoutMs),
    })
  } catch (error) {
    if (signal?.aborted === true) return { ok: false, kind: 'aborted', message: '检查已取消' }
    const message = error instanceof Error ? error.message : String(error)
    const timeout = /abort|timeout/iu.test(message)
    return {
      ok: false,
      kind: 'network',
      message: timeout
        ? `GitHub API 请求超时（${String(Math.round(timeoutMs / 1000))} 秒）`
        : `无法访问 GitHub API：${message}`,
    }
  }
  let body: unknown
  const text = await response.text().catch(() => '')
  if (text !== '') {
    try {
      body = JSON.parse(text)
    } catch {
      body = undefined
    }
  }
  if (!response.ok) {
    const failure = apiFailureMessage(response.status, response.headers, body, authenticated)
    return { ok: false, kind: failure.kind, message: failure.message }
  }
  return { ok: true, body }
}

/** Resolve the default branch of one repository. */
async function fetchDefaultBranch(
  repository: GitHubRepositoryRef,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{ ok: true; branch: string } | { ok: false; kind: 'network' | 'rate-limit' | 'not-found' | 'http' | 'aborted'; message: string }> {
  const result = await requestJson(`${GITHUB_API}/repos/${repository.owner}/${repository.repo}`, signal, timeoutMs)
  if (!result.ok) return result
  const branch = typeof result.body === 'object' && result.body !== null
    ? (result.body as { default_branch?: unknown }).default_branch
    : undefined
  if (typeof branch !== 'string' || branch === '') {
    return { ok: false, kind: 'http', message: 'GitHub 仓库信息中没有默认分支字段' }
  }
  return { ok: true, branch }
}

/** Fetch the recursive tree of one repository at one ref. */
async function fetchRepoTree(
  repository: GitHubRepositoryRef,
  ref: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  cache: Map<string, { ok: true; tree: FolderTreeLookup } | { ok: false; kind: 'network' | 'rate-limit' | 'not-found' | 'http' | 'aborted'; message: string }>,
): Promise<{ ok: true; tree: FolderTreeLookup } | { ok: false; kind: 'network' | 'rate-limit' | 'not-found' | 'http' | 'aborted'; message: string }> {
  const key = `${repository.owner}/${repository.repo}@${ref}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const result = await requestJson(
    `${GITHUB_API}/repos/${repository.owner}/${repository.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    signal,
    timeoutMs,
  )
  if (!result.ok) {
    const failure = { ok: false as const, kind: result.kind, message: result.message }
    cache.set(key, failure)
    return failure
  }
  const record = typeof result.body === 'object' && result.body !== null ? result.body as Record<string, unknown> : {}
  const sha = typeof record.sha === 'string' ? record.sha : ''
  const entries = new Map<string, string>()
  const rawTree = record.tree
  if (Array.isArray(rawTree)) {
    for (const item of rawTree) {
      if (typeof item !== 'object' || item === null) continue
      const entry = item as Record<string, unknown>
      if (entry.type !== 'tree' || typeof entry.path !== 'string' || typeof entry.sha !== 'string') continue
      entries.set(entry.path, entry.sha)
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(sha)) {
    const failure = { ok: false as const, kind: 'http' as const, message: 'GitHub tree 响应缺少合法的 sha 字段' }
    cache.set(key, failure)
    return failure
  }
  const tree: FolderTreeLookup = {
    treeSha: sha,
    entries,
    truncated: record.truncated === true,
  }
  const success = { ok: true as const, tree }
  cache.set(key, success)
  return success
}

/** Everything needed to resolve one remote folder identity. */
interface RemoteFolderRequest {
  repository: GitHubRepositoryRef
  /** Repository-relative directory; empty string means the repository root. */
  subdir: string
  ref?: string
  signal?: AbortSignal
  timeoutMs?: number
}

/** Per-run GitHub caches shared by all records of the same repository. */
interface GitHubCaches {
  defaultBranches: Map<string, string>
  trees: Map<string, { ok: true; tree: FolderTreeLookup } | { ok: false; kind: 'network' | 'rate-limit' | 'not-found' | 'http' | 'aborted'; message: string }>
}

/** Resolve the upstream tree id of one skill folder. */
async function resolveFolderTreeSha(
  request: RemoteFolderRequest,
  caches: GitHubCaches,
): Promise<{ ok: true; treeSha: string; truncated: boolean } | { ok: false; kind: 'network' | 'rate-limit' | 'not-found' | 'http' | 'aborted'; message: string }> {
  const timeoutMs = request.timeoutMs ?? REQUEST_TIMEOUT_MS
  const repoKey = `${request.repository.owner}/${request.repository.repo}`
  let ref = request.ref
  if (ref === undefined || ref === '') {
    const cachedBranch = caches.defaultBranches.get(repoKey)
    if (cachedBranch !== undefined) {
      ref = cachedBranch
    } else {
      const branch = await fetchDefaultBranch(request.repository, request.signal, timeoutMs)
      if (!branch.ok) return branch
      caches.defaultBranches.set(repoKey, branch.branch)
      ref = branch.branch
    }
  }
  const tree = await fetchRepoTree(request.repository, ref, request.signal, timeoutMs, caches.trees)
  if (!tree.ok) return tree
  if (request.subdir === '') return { ok: true, treeSha: tree.tree.treeSha, truncated: tree.tree.truncated }
  const sha = tree.tree.entries.get(request.subdir)
  if (sha === undefined) {
    return {
      ok: false,
      kind: 'not-found',
      message: `GitHub 仓库 ${repoKey}@${ref} 中找不到技能目录「${request.subdir}」（可能已被移动或删除）`,
    }
  }
  return { ok: true, treeSha: sha, truncated: tree.tree.truncated }
}

/**
 * Verify one user-confirmed repository association: resolve the remote folder
 * tree id and compare it with the locally computed baseline. Used by the
 * inventory's `/skill-source` handler.
 */
export async function verifyRemoteSkillFolder(input: {
  repository: GitHubRepositoryRef
  subdir: string
  ref?: string
  expectedTree?: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<{ ok: boolean; tree?: string; message: string }> {
  const caches: GitHubCaches = { defaultBranches: new Map(), trees: new Map() }
  const lookup = await resolveFolderTreeSha(
    {
      repository: input.repository,
      subdir: input.subdir,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    },
    caches,
  )
  if (!lookup.ok) return { ok: false, message: lookup.message }
  if (input.expectedTree !== undefined && !sameTreeSha(lookup.treeSha, input.expectedTree)) {
    return {
      ok: false,
      tree: lookup.treeSha,
      message: `远端目录 tree ${shortTreeSha(lookup.treeSha)} 与本地内容 ${shortTreeSha(input.expectedTree)} 不一致（可能是本地定制版本）`,
    }
  }
  return { ok: true, tree: lookup.treeSha, message: '远端目录内容与本地基线一致' }
}

/** Resolve the agent-home lock file for this host process. */
function agentsHome(): string {
  return resolveHomeRoot(undefined, 'DSH_AGENTS_HOME', join(homedir(), '.agents'))
}

/** Find the repository-relative directory of a local copy inside its git repo. */
function gitSubdir(installDir: string): { git: ReturnType<typeof readGitRepository>; subdir: string } | undefined {
  const located = findGitRepository(installDir)
  if (located === undefined) return undefined
  const git = readGitRepository(installDir)
  if (git === undefined) return undefined
  return { git, subdir: relativePosix(git.root, installDir) }
}

/** The skill update checker behind `SkillUpdateCheckerImpl`. */
export class SkillUpdateCheckerImpl implements SkillUpdateChecker {
  protected readonly ctx: Context
  protected readonly state: ManagerState
  protected readonly log: ManagerLog

  constructor(ctx: Context, state: ManagerState, log: ManagerLog) {
    this.ctx = ctx
    this.state = state
    this.log = log
  }

  /**
   * Check a batch of physical skill records. Outcomes are written under the
   * `skill:<record id>` cache keys the inventory reads back.
   */
  async check(
    records: readonly SkillRecord[],
    options: { refresh?: boolean; signal?: AbortSignal; onItem?: (recordId: string, status: 'running' | 'ok' | 'failed', message?: string) => void },
  ): Promise<CheckBatchResult> {
    void options.refresh
    const signal = options.signal
    const skipped: SkippedRecord[] = []
    const transportErrors: Array<{ source: string; message: string }> = []
    const outcomes: CheckOutcome[] = []
    const lockHome = agentsHome()
    const lockRead = await readSkillLockFile(lockHome)
    this.log.info('skills.check.start', {
      records: records.length,
      lockFile: lockRead.path,
      lockEntries: Object.keys(lockRead.lock?.skills ?? {}).length,
      ...(lockRead.error === undefined ? {} : { lockError: lockRead.error }),
    })
    const targets: CheckTarget[] = []
    const order = new Map<string, number>()
    for (const [index, record] of records.entries()) {
      order.set(record.id, index)
      if (signal?.aborted === true) {
        skipped.push({ recordId: record.id, name: record.name, reason: '检查已取消' })
        continue
      }
      const target = this.prepareTarget(record, lockRead.lock, skipped)
      if (target !== undefined) targets.push(target)
    }
    const caches: GitHubCaches = { defaultBranches: new Map(), trees: new Map() }
    let nextIndex = 0
    const worker = async (): Promise<void> => {
      while (true) {
        if (signal?.aborted === true) return
        const index = nextIndex
        nextIndex += 1
        const target = targets[index]
        if (target === undefined) return
        options.onItem?.(target.record.id, 'running')
        try {
          const result = await this.checkTarget(target, caches, transportErrors, signal)
          outcomes.push(result)
          const message = result.cache.detail
          options.onItem?.(target.record.id, 'ok', message)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const cache: CheckCacheEntry = {
            recordId: `skill:${target.record.id}`,
            status: 'check-failed',
            checkedAt: new Date().toISOString(),
            detail: `检查失败：${message}`,
          }
          outcomes.push({ recordId: target.record.id, cache })
          options.onItem?.(target.record.id, 'failed', cache.detail)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, targets.length)) }, () => worker()))
    if (signal?.aborted === true) {
      for (const target of targets.slice(nextIndex)) {
        skipped.push({ recordId: target.record.id, name: target.record.name, reason: '检查已取消' })
      }
    }
    outcomes.sort((left, right) => (order.get(left.recordId) ?? 0) - (order.get(right.recordId) ?? 0))
    const updates = outcomes.filter(outcome => outcome.cache.status === 'update-available').length
    const failed = outcomes.filter(outcome => outcome.cache.status === 'network-error' || outcome.cache.status === 'check-failed').length
    const localModified = outcomes.filter(outcome => outcome.cache.status === 'local-modified').length
    const summary = `已检查 ${String(outcomes.length)} 个技能，${String(updates)} 个有更新`
      + (silentCount(localModified) === '' ? '' : `，${silentCount(localModified)} 个本地已修改`)
      + (skipped.length > 0 ? `，${String(skipped.length)} 个跳过` : '')
      + (transportErrors.length > 0 ? `，${String(transportErrors.length)} 个来源网络失败` : '')
      + (signal?.aborted === true ? '（已取消）' : '')
    this.log.info('skills.check.completed', {
      checked: outcomes.length,
      updates,
      failed,
      localModified,
      skipped: skipped.length,
      transportErrors: transportErrors.length,
    })
    return { outcomes, skipped, transportErrors, message: summary }
  }

  /** Resolve provenance and the remote folder for one record, or skip it. */
  private prepareTarget(record: SkillRecord, lock: SkillLockFile | undefined, skipped: SkippedRecord[]): CheckTarget | undefined {
    const skip = (reason: string): undefined => {
      skipped.push({ recordId: record.id, name: record.name, reason })
      return undefined
    }
    if (record.actions.canCheck !== true) return skip(record.actions.updateBlockedReason ?? '没有可核对的远端来源')
    const installDir = record.paths.installDir
      ?? (record.paths.manifestPath === undefined ? undefined : record.paths.manifestPath.replace(/[\\/][^\\/]+$/u, ''))
    if (installDir === undefined || installDir === '') return skip('记录没有本地物理目录')
    const association = this.state.skillSource(`skill:${record.id}`)
    const lockEntry = record.source.kind === 'skill-lock' ? findSkillLockEntry(lock, record.name) : undefined
    const localGit = gitSubdir(installDir)
    if (association !== undefined) {
      const repository = parseGitHubRepository(association.url)
      if (repository === undefined) return skip('用户确认的来源不是 GitHub 仓库')
      const subdir = association.subdir ?? localGit?.subdir ?? ''
      return {
        record,
        installDir,
        repository,
        subdir,
        ...(association.ref === undefined ? {} : { ref: association.ref }),
        ...(association.baseline?.tree === undefined ? {} : { expectedTree: association.baseline.tree }),
        association,
      }
    }
    if (record.source.kind === 'skill-lock') {
      if (lockEntry === undefined) return skip('锁文件里找不到该技能的记录')
      const repository = lockEntry.sourceUrl === undefined ? undefined : parseGitHubRepository(lockEntry.sourceUrl)
      if (repository === undefined) return skip('锁文件记录的来源不是 GitHub 仓库')
      const subdir = lockEntrySubdir(lockEntry) ?? ''
      return {
        record,
        installDir,
        repository,
        subdir,
        ...(lockEntry.skillFolderHash === undefined ? {} : { expectedTree: lockEntry.skillFolderHash }),
        lockEntry,
      }
    }
    if (record.source.kind === 'skill-git') {
      const repository = record.source.url === undefined ? undefined : parseGitHubRepository(record.source.url)
      if (repository === undefined) return skip('该 Git 来源不是 GitHub 仓库，暂不支持远端比较')
      const subdir = record.source.subdir ?? localGit?.subdir ?? ''
      return {
        record,
        installDir,
        repository,
        subdir,
        ...(record.source.ref === undefined ? {} : { ref: record.source.ref }),
      }
    }
    return skip('该技能没有可核对的远端来源')
  }

  /** Check one record: local baseline, local modification, remote tree. */
  private async checkTarget(
    target: CheckTarget,
    caches: GitHubCaches,
    transportErrors: Array<{ source: string; message: string }>,
    signal: AbortSignal | undefined,
  ): Promise<CheckOutcome> {
    const { record } = target
    const cachePrefix = `skill:${record.id}`
    const checkedAt = new Date().toISOString()
    const computed = await computeSkillFolderTreeSha(target.installDir, {
      maxFiles: MAX_FOLDER_FILES,
      ...(signal === undefined ? {} : { signal }),
    })
    if (computed.error !== undefined) {
      return {
        recordId: record.id,
        cache: {
          recordId: cachePrefix,
          status: 'check-failed',
          checkedAt,
          detail: `无法读取本地技能目录：${computed.error}`,
        },
      }
    }
    let baselineTree = target.expectedTree
    let localModified = false
    if (baselineTree !== undefined) {
      localModified = !sameTreeSha(computed.sha, baselineTree)
    } else {
      const localGit = findGitRepository(target.installDir)
      if (localGit !== undefined) {
        const head = await readGitHeadTree(localGit.root, target.subdir, {
          ...(signal === undefined ? {} : { signal }),
        })
        if (head.sha !== undefined) baselineTree = head.sha
        const status = await readGitWorktreeStatus(localGit.root, target.installDir, {
          ...(signal === undefined ? {} : { signal }),
        })
        if (status.state === 'modified') localModified = true
      }
    }
    const remote = await resolveFolderTreeSha(
      {
        repository: target.repository,
        subdir: target.subdir,
        ...(target.ref === undefined ? {} : { ref: target.ref }),
        ...(signal === undefined ? {} : { signal }),
      },
      caches,
    )
    if (!remote.ok) {
      const status: UpdateStatus = remote.kind === 'network' || remote.kind === 'rate-limit' || remote.kind === 'aborted'
        ? 'network-error'
        : 'check-failed'
      if (remote.kind !== 'aborted') {
        transportErrors.push({ source: `GitHub API · ${target.repository.owner}/${target.repository.repo}`, message: remote.message })
      }
      return {
        recordId: record.id,
        cache: {
          recordId: cachePrefix,
          status,
          checkedAt,
          ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
          detail: remote.message,
        },
      }
    }
    const channel = 'commit' as const
    const baselineText = baselineTree === undefined ? '未知（没有可信本地基线）' : shortTreeSha(baselineTree)
    // Decision order (see `decideSkillUpdateStatus`): content equal to upstream
    // wins; a changed remote is an update even when the local copy was edited;
    // only a purely local change is reported as `local-modified`.
    const decision = decideSkillUpdateStatus({
      localTree: computed.sha,
      remoteTree: remote.treeSha,
      ...(baselineTree === undefined ? {} : { baselineTree }),
      ...(localModified ? { localModified: true } : {}),
    })
    if (decision.status === 'check-failed') {
      return {
        recordId: record.id,
        cache: {
          recordId: cachePrefix,
          status: 'check-failed',
          checkedAt,
          ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
          detail: '无法建立本地基线（既没有锁文件哈希，也不在 Git 仓库中），不能可靠判断是否有更新。',
        },
      }
    }
    if (decision.status === 'up-to-date') {
      return {
        recordId: record.id,
        cache: {
          recordId: cachePrefix,
          status: 'up-to-date',
          checkedAt,
          ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
          // Kept so the inventory can align `localModification` with this
          // observation: local content equal to the recorded upstream tree is
          // clean even when the lock baseline is older.
          availableTree: remote.treeSha,
          detail: decision.staleBaseline
            ? `本地内容与远端一致（tree ${shortTreeSha(remote.treeSha)}）；锁记录基线 ${baselineText} 较旧（更新后未回写来源基线）`
            : `本地内容与远端技能目录一致（tree ${shortTreeSha(remote.treeSha)}）`,
        },
      }
    }
    if (decision.status === 'update-available') {
      return {
        recordId: record.id,
        cache: {
          recordId: cachePrefix,
          status: 'update-available',
          checkedAt,
          ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
          availableTree: remote.treeSha,
          channel,
          detail: decision.localChanged
            ? `远端技能目录已变化（tree ${shortTreeSha(remote.treeSha)}，基线 ${baselineText}）；本地内容也有改动，更新会覆盖本地修改，需要显式确认。`
            : `远端技能目录 tree ${shortTreeSha(remote.treeSha)} 与本地基线 ${baselineText} 不同`,
        },
      }
    }
    // `local-modified`: the remote still serves the recorded baseline; the
    // availableTree lets the planner re-apply that version over local edits.
    return {
      recordId: record.id,
      cache: {
        recordId: cachePrefix,
        status: 'local-modified',
        checkedAt,
        ...(record.version.current === undefined ? {} : { currentVersion: record.version.current }),
        availableTree: remote.treeSha,
        channel,
        detail: localModified
          ? `本地内容与记录基线 ${baselineText} 不同；远端仍是记录版本（tree ${shortTreeSha(remote.treeSha)}），覆盖后可回到该版本，需要显式确认。`
          : `本地内容与远端不一致（可能因行尾或文件模式差异）；远端仍是记录版本（tree ${shortTreeSha(remote.treeSha)}），需要显式确认后才能覆盖。`,
      },
    }
  }
}

/** Render a count clause only when the count is non-zero. */
function silentCount(count: number): string {
  return count === 0 ? '' : String(count)
}
