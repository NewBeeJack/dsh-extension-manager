/**
 * In-memory async task registry. Long checks and updates run as tasks; the
 * client polls one task until it finishes, so a slow registry or pnpm run
 * never blocks the UI thread or a single HTTP request for minutes.
 */
import { randomUUID } from 'node:crypto'
import type { TaskSkippedItem, TaskState, UpdatePlan } from '../shared/types'

const MAX_RETAINED = 40

/** Create, mutate and read task states. */
export class TaskRegistry {
  private readonly tasks = new Map<string, TaskState>()

  /** Create one queued task with per-item rows. */
  create(input: {
    kind: TaskState['kind']
    scope: TaskState['scope']
    items: Array<{ id: string; name: string; fromVersion?: string; toVersion?: string }>
    plan?: UpdatePlan
    /** Snapshot of candidates skipped before the task was created. */
    skipped?: TaskSkippedItem[]
  }): TaskState {
    const task: TaskState = {
      id: randomUUID(),
      kind: input.kind,
      scope: input.scope,
      status: 'queued',
      startedAt: new Date().toISOString(),
      total: input.items.length,
      completed: 0,
      items: input.items.map(item => ({ ...item, status: 'pending' })),
      ...(input.plan === undefined ? {} : { plan: input.plan }),
      ...(input.skipped === undefined ? {} : { skipped: input.skipped.map(item => ({ ...item })) }),
    }
    this.tasks.set(task.id, task)
    this.prune()
    return task
  }

  /** Replace the in-memory set with a restored snapshot (used after a Host restart). */
  restore(tasks: readonly TaskState[]): void {
    this.tasks.clear()
    for (const task of tasks) this.tasks.set(task.id, task)
    this.prune()
  }

  /** Read one task. */
  get(id: string): TaskState | undefined {
    return this.tasks.get(id)
  }

  /** Newest tasks, useful for reconnect. */
  list(): TaskState[] {
    return [...this.tasks.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Mark a task running. */
  start(id: string): void {
    this.mutate(id, task => { task.status = 'running' })
  }

  /** Mark one item running. */
  itemRunning(id: string, itemId: string): void {
    this.mutate(id, task => {
      const item = task.items.find(entry => entry.id === itemId)
      if (item !== undefined) item.status = 'running'
    })
  }

  /** Mark one item finished and advance the completed counter. */
  itemDone(id: string, itemId: string, status: 'ok' | 'failed' | 'skipped', message?: string, versions?: { from?: string; to?: string }): void {
    this.mutate(id, task => {
      const item = task.items.find(entry => entry.id === itemId)
      if (item === undefined || item.status === 'ok' || item.status === 'failed' || item.status === 'skipped') return
      item.status = status
      if (message !== undefined) item.message = message
      if (versions?.from !== undefined) item.fromVersion = versions.from
      if (versions?.to !== undefined) item.toVersion = versions.to
      task.completed += 1
    })
  }

  /** Finish a task. */
  finish(id: string, status: 'done' | 'failed' | 'cancelled', message?: string, error?: string): void {
    this.mutate(id, task => {
      task.status = status
      task.finishedAt = new Date().toISOString()
      if (message !== undefined) task.message = message
      if (error !== undefined) task.error = error
      // Anything left is marked skipped so the UI never shows a spinner forever.
      for (const item of task.items) {
        if (item.status === 'pending' || item.status === 'running') {
          item.status = status === 'cancelled' ? 'skipped' : 'failed'
          item.message ??= status === 'cancelled' ? '任务已取消' : '任务提前结束'
        }
      }
      task.completed = task.items.filter(item => item.status !== 'pending').length
    })
  }

  /** Attach transaction ids produced by a task. */
  attachTransactions(id: string, transactionIds: readonly string[]): void {
    this.mutate(id, task => { task.transactionIds = [...transactionIds] })
  }

  /** Drop old terminal tasks beyond the retention bound. */
  private prune(): void {
    if (this.tasks.size <= MAX_RETAINED) return
    const terminal = [...this.tasks.values()]
      .filter(task => task.status === 'done' || task.status === 'failed' || task.status === 'cancelled')
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    for (const task of terminal.slice(0, Math.max(0, this.tasks.size - MAX_RETAINED))) this.tasks.delete(task.id)
  }

  private mutate(id: string, change: (task: TaskState) => void): void {
    const task = this.tasks.get(id)
    if (task === undefined) return
    change(task)
  }
}
