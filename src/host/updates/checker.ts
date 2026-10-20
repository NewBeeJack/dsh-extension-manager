/**
 * Update-check orchestration: selects records that have a trustworthy source,
 * runs the plugin and skill checkers under one task, and persists the answers
 * into the durable check cache.
 *
 * The cache TTL applies per record: an answer younger than `CHECK_TTL_MS` is
 * reused unless the user explicitly asks for a refresh. A stale answer is
 * never presented as "up to date" — the record's version status simply stays
 * `unchecked` until a check runs.
 */
import type {
  CheckBatchResult,
  HostServices,
  PluginUpdateChecker,
  SkillUpdateChecker,
} from '../contracts'
import type { CheckCacheEntry } from '../state'
import type { PluginBundleRecord, SkillRecord, TaskSkippedItem, TaskState } from '../../shared/types'
import { errorText } from '../logs'

/** How long a cached answer is considered fresh. */
export const CHECK_TTL_MS = 5 * 60 * 1000

/** Everything one check run needs. */
export interface CheckRequest {
  scope: 'plugins' | 'skills' | 'all'
  ids?: readonly string[]
  refresh?: boolean
  workspace?: string
}

/** Facade over the two checkers and the durable cache. */
export class UpdateCheckService {
  private readonly services: HostServices
  private readonly pluginChecker: PluginUpdateChecker
  private readonly skillChecker: SkillUpdateChecker
  private running: string | undefined

  constructor(services: HostServices, pluginChecker: PluginUpdateChecker, skillChecker: SkillUpdateChecker) {
    this.services = services
    this.pluginChecker = pluginChecker
    this.skillChecker = skillChecker
  }

  /** The id of the active check task, when one is running. */
  activeTask(): string | undefined {
    return this.running
  }

  /**
   * Create the task and start checking in the background. The caller returns
   * the task state immediately so the HTTP request stays short.
   */
  async start(request: CheckRequest): Promise<TaskState> {
    const { services } = this
    if (this.running !== undefined) {
      const active = services.tasks.get(this.running)
      if (active !== undefined && (active.status === 'queued' || active.status === 'running')) return active
      this.running = undefined
    }
    const wanted = new Set(request.ids ?? [])
    const pluginRecords: PluginBundleRecord[] = []
    const skillRecords: SkillRecord[] = []
    const skipped: TaskSkippedItem[] = []
    if (request.scope === 'plugins' || request.scope === 'all') {
      const inventory = await services.plugins.scan()
      for (const record of inventory.bundles) {
        if (wanted.size > 0 && !wanted.has(record.id)) continue
        if (!record.actions.canCheck) {
          skipped.push({ id: record.id, name: record.displayName, reason: record.actions.updateBlockedReason ?? '没有可核对的远端来源' })
          continue
        }
        const cached = services.state.check(`plugin:${record.id}`)
        if (request.refresh !== true && cached !== undefined && isFresh(cached.checkedAt)) {
          skipped.push({ id: record.id, name: record.displayName, reason: '使用 5 分钟内的检查缓存' })
          continue
        }
        pluginRecords.push(record)
      }
    }
    if (request.scope === 'skills' || request.scope === 'all') {
      const inventory = await services.skills.scan({ ...(request.workspace === undefined ? {} : { workspace: request.workspace }) })
      for (const record of inventory.physical) {
        if (wanted.size > 0 && !wanted.has(record.id)) continue
        if (!record.actions.canCheck) {
          skipped.push({ id: record.id, name: record.displayName, reason: record.actions.updateBlockedReason ?? '没有可核对的远端来源' })
          continue
        }
        const cached = services.state.check(`skill:${record.id}`)
        if (request.refresh !== true && cached !== undefined && isFresh(cached.checkedAt)) {
          skipped.push({ id: record.id, name: record.displayName, reason: '使用 5 分钟内的检查缓存' })
          continue
        }
        skillRecords.push(record)
      }
    }
    const task = services.tasks.create({
      kind: 'check',
      scope: request.scope,
      items: [...pluginRecords, ...skillRecords].map(record => ({
        id: record.id,
        name: record.displayName,
        ...(record.version.current === undefined ? {} : { fromVersion: record.version.current }),
      })),
      skipped,
    })
    if (pluginRecords.length === 0 && skillRecords.length === 0) {
      services.tasks.start(task.id)
      const cacheOnly = skipped.length > 0 && skipped.every(item => item.reason === '使用 5 分钟内的检查缓存')
      const noCheckMessage = skipped.length === 0
        ? '没有可检查的项目'
        : cacheOnly
          ? `已使用缓存结果（${String(skipped.length)} 项），没有需要重新检查的项目`
          : `没有可检查的项目（${String(skipped.length)} 项跳过）`
      services.tasks.finish(task.id, 'done', noCheckMessage)
      return task
    }
    this.running = task.id
    void this.run(task.id, pluginRecords, skillRecords, skipped, request).finally(() => {
      if (this.running === task.id) this.running = undefined
    })
    return task
  }

  /** Run both checkers, stream per-item progress, then persist every answer. */
  private async run(
    taskId: string,
    pluginRecords: readonly PluginBundleRecord[],
    skillRecords: readonly SkillRecord[],
    skipped: TaskSkippedItem[],
    request: CheckRequest,
  ): Promise<void> {
    const { services } = this
    services.tasks.start(taskId)
    const outcomes: CheckCacheEntry[] = []
    const transportErrors: string[] = []
    const onItem = (recordId: string, status: 'running' | 'ok' | 'failed', message?: string): void => {
      if (status === 'running') services.tasks.itemRunning(taskId, recordId)
      else services.tasks.itemDone(taskId, recordId, status === 'ok' ? 'ok' : 'failed', message)
    }
    try {
      if (pluginRecords.length > 0) {
        const result: CheckBatchResult = await this.pluginChecker.check(pluginRecords, {
          refresh: request.refresh === true,
          onItem,
        })
        outcomes.push(...result.outcomes.map(outcome => outcome.cache))
        transportErrors.push(...result.transportErrors.map(item => `${item.source}: ${item.message}`))
      }
      if (skillRecords.length > 0) {
        const result: CheckBatchResult = await this.skillChecker.check(skillRecords, {
          refresh: request.refresh === true,
          onItem,
        })
        outcomes.push(...result.outcomes.map(outcome => outcome.cache))
        transportErrors.push(...result.transportErrors.map(item => `${item.source}: ${item.message}`))
      }
      if (outcomes.length > 0) await services.state.setChecks(outcomes)
      const now = new Date().toISOString()
      // Merge with the existing record: a skills-only check must not erase the
      // plugin check timestamp (patchSettings replaces the whole block).
      const previous = services.state.get().settings.lastCheckAt ?? {}
      await services.state.patchSettings({
        lastCheckAt: {
          ...previous,
          ...(request.scope === 'plugins' || request.scope === 'all' ? { plugins: now } : {}),
          ...(request.scope === 'skills' || request.scope === 'all' ? { skills: now } : {}),
        },
      })
      services.plugins.invalidate()
      services.skills.invalidate()
      const updatedAvailable = outcomes.filter(outcome =>
        outcome.status === 'update-available' || outcome.status === 'incompatible-update' || outcome.status === 'prerelease-only').length
      const failed = outcomes.filter(outcome => outcome.status === 'network-error' || outcome.status === 'check-failed').length
      const summary = `已检查 ${String(outcomes.length)} 项，${String(updatedAvailable)} 项有更新`
        + (skipped.length > 0 ? `，${String(skipped.length)} 项跳过` : '')
        + (transportErrors.length > 0 ? `，${String(transportErrors.length)} 个来源网络失败` : '')
      services.tasks.finish(taskId, failed > 0 && failed === outcomes.length ? 'failed' : 'done',
        transportErrors.length > 0 ? `${summary}；${transportErrors.slice(0, 3).join('；')}` : summary)
      services.log.info('check.completed', { scope: request.scope, checked: outcomes.length, skipped: skipped.length, updates: updatedAvailable, failed })
    } catch (error) {
      services.log.error('check.failed', { message: errorText(error) })
      services.tasks.finish(taskId, 'failed', '检查更新失败', errorText(error))
    }
  }

  /** Read the newest completed check time for one scope. */
  lastCheckAt(scope: 'plugins' | 'skills'): string | undefined {
    return this.services.state.get().settings.lastCheckAt?.[scope]
  }
}

/** Whether an ISO timestamp is inside the freshness window. */
export function isFresh(iso: string | undefined, ttlMs = CHECK_TTL_MS): boolean {
  if (iso === undefined) return false
  const at = Date.parse(iso)
  return Number.isFinite(at) && Date.now() - at < ttlMs
}
