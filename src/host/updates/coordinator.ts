/**
 * Unified update/check coordinator.
 *
 * This is deliberately a thin coordination layer, not a rewrite of the update
 * engine: the existing UpdateCheckService keeps its plugin/skill checkers, and
 * UpdateExecutor keeps its plugin and skill runners, transaction machine,
 * backups and recovery. The coordinator owns the pieces that used to be spread
 * across routes/checker/executor:
 *
 *  - one admission slot for update tasks (synchronous reservation);
 *  - task creation, phase metadata, completion normalization and abort signal;
 *  - structured task lifecycle logging;
 *  - a small durable task journal so a Host restart reports interrupted tasks
 *    instead of forgetting them.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostServices, UpdateManager } from '../contracts'
import type { TaskPhase, TaskState, UpdatePlan } from '../../shared/types'
import type { CheckRequest, UpdateCheckService } from './checker'
import { errorText } from '../logs'

const JOURNAL_VERSION = 1

/** Stable error shape the HTTP layer maps to status/code. */
export class CoordinatorError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Input accepted by the update admission method. */
export interface StartUpdateInput {
  scope: 'plugins' | 'skills' | 'all'
  ids: readonly string[]
  confirmed: boolean
  overwriteLocalModifications: boolean
  workspace?: string
}

interface TaskJournal {
  version: number
  tasks: TaskState[]
}

/** Coordination facade over checks, plan/execute and the task registry. */
export class UpdateCoordinator {
  private reservation: string | undefined
  private readonly aborters = new Map<string, AbortController>()
  private readonly journalPath: string

  private readonly services: HostServices
  private readonly checks: UpdateCheckService
  private readonly updates: UpdateManager

  constructor(
    services: HostServices,
    checks: UpdateCheckService,
    updates: UpdateManager,
    journalPath: string,
  ) {
    this.services = services
    this.checks = checks
    this.updates = updates
    this.journalPath = journalPath
  }

  /** Restore the last task journal and mark tasks interrupted by a restart. */
  initialize(): void {
    const tasks = this.services.tasks
    if (!existsSync(this.journalPath)) return
    try {
      const parsed = JSON.parse(readFileSync(this.journalPath, 'utf8')) as Partial<TaskJournal>
      if (parsed.version !== JOURNAL_VERSION || !Array.isArray(parsed.tasks)) return
      tasks.restore(parsed.tasks.filter(task => typeof task?.id === 'string'))
      const interrupted = tasks.list().filter(task => task.status === 'queued' || task.status === 'running')
      for (const task of interrupted) {
        task.status = 'failed'
        task.phase = 'failed'
        task.finishedAt = new Date().toISOString()
        task.error = 'Host 已重启，任务在执行中被中断；未完成的更新事务由恢复流程处理'
        task.message = '任务中断（Host 重启）'
        for (const item of task.items) {
          if (item.status === 'pending' || item.status === 'running') {
            item.status = 'failed'
            item.message = 'Host 重启，任务中断'
          }
        }
        this.services.log.event('warn', 'task.interrupted', {
          taskId: task.id,
          extensionType: task.scope === 'skills' ? 'skill' : task.scope === 'plugins' ? 'plugin' : 'all',
          action: task.kind,
          phase: 'failed',
          status: 'failed',
          message: task.message,
        })
      }
      if (interrupted.length > 0) void this.persist()
    } catch (error) {
      this.services.log.warn('tasks.journal-unreadable', { message: errorText(error), path: this.journalPath })
    }
  }

  /** Create a check task through the existing checker (single-flight preserved there). */
  async startCheck(request: CheckRequest): Promise<TaskState> {
    const task = await this.checks.start(request)
    this.services.log.event('info', 'task.created', {
      taskId: task.id,
      extensionType: task.scope === 'skills' ? 'skill' : task.scope === 'plugins' ? 'plugin' : 'all',
      action: 'check',
      phase: 'queued',
      status: task.status,
      message: '检查更新任务已创建',
    })
    await this.persist()
    this.watchCheck(task.id)
    return task
  }

  /** Persist/log a check task once it settles (the checker finishes it itself). */
  private watchCheck(taskId: string): void {
    const timer = setInterval(() => {
      const task = this.services.tasks.get(taskId)
      if (task === undefined || (task.status !== 'queued' && task.status !== 'running')) {
        clearInterval(timer)
        if (task !== undefined) {
          task.phase = task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled' : 'completed'
          this.services.log.event(task.status === 'failed' ? 'error' : 'info', 'task.settled', {
            taskId,
            extensionType: task.scope === 'skills' ? 'skill' : task.scope === 'plugins' ? 'plugin' : 'all',
            action: 'check',
            phase: task.status === 'failed' ? 'failed' : 'completed',
            status: task.status,
            message: task.message ?? '检查任务结束',
          })
        }
        void this.persist()
      }
    }, 1000)
    timer.unref?.()
  }

  /**
   * Admit, plan and start one update task.
   *
   * The reservation is set synchronously before planning (the old route-level
   * sentinel behavior) so duplicate requests cannot both pass the guard.
   */
  async startUpdate(input: StartUpdateInput): Promise<{ task: TaskState; plan: UpdatePlan }> {
    if (!input.confirmed) throw new CoordinatorError(400, 'confirmation-required', '更新必须在用户确认后执行')
    if (input.ids.length === 0) throw new CoordinatorError(400, 'no-targets', '没有指定要更新的项目')
    if (input.ids.length > 100) throw new CoordinatorError(400, 'too-many-targets', '单次最多更新 100 项')
    if (this.reservation !== undefined) {
      if (this.reservation === '__planning__') {
        throw new CoordinatorError(409, 'update-busy', '已有更新请求正在准备，请稍候')
      }
      const active = this.services.tasks.get(this.reservation)
      if (active !== undefined && (active.status === 'queued' || active.status === 'running')) {
        throw new CoordinatorError(409, 'update-busy', '已有更新任务正在执行，请等待完成')
      }
      this.reservation = undefined
    }
    this.reservation = '__planning__'
    try {
      const plan = await this.updates.plan(input.scope, input.ids, input.workspace)
      if (plan.entries.length === 0 && plan.excluded.length === 0) {
        throw new CoordinatorError(400, 'no-plan', '没有匹配的可更新项目')
      }
      const executable = plan.entries.filter(entry => entry.eligible
        || (entry.requiresConfirmation === true && (input.overwriteLocalModifications || plan.entries.length === 1)))
      if (executable.length === 0) {
        throw new CoordinatorError(400, 'no-eligible', plan.entries[0]?.excludedReason ?? plan.excluded[0]?.excludedReason ?? '没有可安全自动更新的项目')
      }
      const task = this.services.tasks.create({
        kind: executable.length > 1 ? 'batch-update' : 'update',
        scope: input.scope,
        items: executable.map(entry => ({
          id: entry.id,
          name: entry.displayName,
          ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
          ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
        })),
        plan,
      })
      task.phase = 'preflight'
      this.reservation = task.id
      const controller = new AbortController()
      this.aborters.set(task.id, controller)
      this.services.log.event('info', 'task.created', {
        taskId: task.id,
        extensionType: task.scope === 'skills' ? 'skill' : task.scope === 'plugins' ? 'plugin' : 'all',
        action: plan.entries.length > 1 ? 'batch-update' : 'update',
        phase: 'preflight',
        status: task.status,
        message: `更新计划已确认：${String(executable.length)} 项可执行，${String(plan.excluded.length)} 项排除`,
      })
      await this.persist()
      void this.updates.execute({
        plan,
        confirmed: true,
        overwriteLocalModifications: input.overwriteLocalModifications,
        taskId: task.id,
        signal: controller.signal,
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      }).then(() => this.finalize(task.id))
        .catch((error: unknown) => this.fail(task.id, error))
        .finally(() => {
          this.aborters.delete(task.id)
          if (this.reservation === task.id) this.reservation = undefined
        })
      return { task, plan }
    } catch (error) {
      if (this.reservation === '__planning__') this.reservation = undefined
      throw error
    }
  }

  /** Request cancellation. Only pre-install phases can stop safely. */
  cancel(taskId: string): TaskState | undefined {
    const task = this.services.tasks.get(taskId)
    if (task === undefined) return undefined
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') return task
    const controller = this.aborters.get(taskId)
    if (controller === undefined) {
      task.phase = 'cancelling'
      task.message = '取消请求已记录，但任务当前不在本进程的执行槽中'
      return task
    }
    controller.abort()
    task.phase = 'cancelling'
    task.message = '已请求取消；安装已进入不可中断阶段时会在校验完成后说明'
    this.services.log.event('warn', 'task.cancel-requested', {
      taskId,
      action: task.kind,
      phase: 'cancelling',
      status: task.status,
      message: task.message,
    })
    void this.persist()
    return task
  }

  /** Reconcile transactions after a Host restart; called once from index.ts. */
  async recover(): Promise<void> {
    this.services.log.event('info', 'recovery.start', { action: 'recover', phase: 'recovering', status: 'running', message: '开始对账未完成更新事务' })
    try {
      await this.updates.recover?.()
      this.services.log.event('info', 'recovery.completed', { action: 'recover', phase: 'completed', status: 'done', message: '更新事务对账完成' })
    } catch (error) {
      this.services.log.event('error', 'recovery.failed', { action: 'recover', phase: 'recovery_required', status: 'failed', message: errorText(error), errorCode: 'RECOVERY_REQUIRED' })
      throw error
    } finally {
      void this.persist()
    }
  }

  private phaseFor(task: TaskState): TaskPhase {
    if (task.status === 'cancelled') return 'cancelled'
    if (task.status === 'failed') return 'failed'
    if (task.status === 'done') {
      const needsRestart = task.items.some(item => item.status === 'ok' && /重启/.test(item.message ?? ''))
      return needsRestart ? 'pending_restart' : 'completed'
    }
    return 'install'
  }

  private finalize(taskId: string): void {
    const task = this.services.tasks.get(taskId)
    if (task === undefined) return
    if (task.status === 'queued' || task.status === 'running') {
      const failed = task.items.filter(item => item.status === 'failed').length
      this.services.tasks.finish(taskId, failed > 0 ? 'failed' : 'done', failed > 0 ? `${String(failed)} 项更新失败` : '更新流程完成')
    }
    task.phase = this.phaseFor(task)
    this.services.log.event(task.status === 'failed' ? 'error' : 'info', 'task.settled', {
      taskId,
      extensionType: task.scope === 'skills' ? 'skill' : task.scope === 'plugins' ? 'plugin' : 'all',
      action: task.kind,
      phase: task.phase,
      status: task.status,
      message: task.message ?? task.error ?? '任务结束',
      ...(task.error === undefined ? {} : { errorCode: 'UPDATE_FAILED' }),
    })
    void this.persist()
  }

  private fail(taskId: string, error: unknown): void {
    const task = this.services.tasks.get(taskId)
    if (task === undefined) return
    const message = errorText(error)
    if (task.status === 'queued' || task.status === 'running') {
      this.services.tasks.finish(taskId, 'failed', '更新失败', message)
    }
    task.phase = 'failed'
    this.services.log.event('error', 'task.failed', {
      taskId,
      extensionType: task.scope === 'skills' ? 'skill' : task.scope === 'plugins' ? 'plugin' : 'all',
      action: task.kind,
      phase: 'failed',
      status: 'failed',
      message,
      errorCode: 'UPDATE_FAILED',
    })
    void this.persist()
  }

  /** Write the current task snapshot; failures only log. */
  private async persist(): Promise<void> {
    try {
      const journal: TaskJournal = { version: JOURNAL_VERSION, tasks: this.services.tasks.list() }
      mkdirSync(dirname(this.journalPath), { recursive: true })
      const temp = `${this.journalPath}.tmp`
      writeFileSync(temp, JSON.stringify(journal), 'utf8')
      renameSync(temp, this.journalPath)
    } catch (error) {
      this.services.log.warn('tasks.journal-write-failed', { message: errorText(error), path: this.journalPath })
    }
  }
}
