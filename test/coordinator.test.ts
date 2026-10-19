/**
 * Coordinator tests: single update admission, task journal persistence and
 * restart reporting. The real executor/checker are replaced by narrow fakes —
 * their behaviour is covered by updater.test.ts.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { after, describe, test } from 'node:test'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error
    const candidates = []
    if (specifier.endsWith('.js')) candidates.push(specifier.slice(0, -3) + '.ts')
    else if (!/\\.[a-z0-9]+$/i.test(specifier)) candidates.push(specifier + '.ts', specifier + '/index.ts')
    for (const candidate of candidates) {
      try { return await next(candidate, context) } catch {}
    }
    throw error
  }
}
`))

const { ManagerLog } = await import('../src/host/logs.ts')
const { TaskRegistry } = await import('../src/host/tasks.ts')
const { UpdateCoordinator, CoordinatorError } = await import('../src/host/updates/coordinator.ts')
import type { HostServices, UpdateManager } from '../src/host/contracts'
import type { TaskState, UpdatePlan } from '../src/shared/types'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-em-coordinator-'))
  dirs.push(dir)
  return dir
}

function planFor(id: string): UpdatePlan {
  return {
    kind: 'plugins',
    createdAt: new Date().toISOString(),
    entries: [{
      id,
      kind: 'plugin-bundle',
      name: 'demo',
      displayName: 'Demo',
      eligible: true,
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
    }],
    excluded: [],
  } as unknown as UpdatePlan
}

function harness(options: { execute?: () => Promise<void> } = {}): {
  coordinator: InstanceType<typeof UpdateCoordinator>
  tasks: InstanceType<typeof TaskRegistry>
  journal: string
  plans: UpdatePlan[]
} {
  const dir = tempDir()
  const journal = join(dir, 'tasks.json')
  const tasks = new TaskRegistry()
  const log = new ManagerLog(join(dir, 'manager.log'))
  const plans: UpdatePlan[] = []
  const services = { tasks, log } as unknown as HostServices
  const updates = {
    plan: async (scope: 'plugins' | 'skills' | 'all', ids?: readonly string[]) => {
      const plan = planFor(ids?.[0] ?? 'plugin-bundle:web:demo')
      plans.push(plan)
      return plan
    },
    execute: async () => { await (options.execute?.() ?? Promise.resolve()) },
    recover: async () => undefined,
  } as unknown as UpdateManager
  const checks = { start: async () => { throw new Error('not used') } } as any
  const coordinator = new UpdateCoordinator(services, checks, updates, journal)
  return { coordinator, tasks, journal, plans }
}

describe('UpdateCoordinator', () => {
  test('creates one task, allows it to settle and persists the journal', async () => {
    const { coordinator, tasks, journal } = harness()
    const result = await coordinator.startUpdate({
      scope: 'plugins', ids: ['plugin-bundle:web:demo'], confirmed: true, overwriteLocalModifications: false,
    })
    assert.equal(result.plan.entries.length, 1)
    assert.equal(result.task.scope, 'plugins')
    assert.equal(result.task.phase, 'preflight')
    await new Promise(resolve => setTimeout(resolve, 40))
    const settled = tasks.get(result.task.id)
    assert.equal(settled?.status, 'done')
    assert.equal(settled?.phase, 'completed')
    const journalText = readFileSync(journal, 'utf8')
    assert.match(journalText, /"phase":"completed"/)
  })

  test('rejects a second update while the first still runs', async () => {
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => { release = resolve })
    const { coordinator } = harness({ execute: () => pending })
    const first = await coordinator.startUpdate({
      scope: 'plugins', ids: ['plugin-bundle:web:a'], confirmed: true, overwriteLocalModifications: false,
    })
    await assert.rejects(coordinator.startUpdate({
      scope: 'plugins', ids: ['plugin-bundle:web:b'], confirmed: true, overwriteLocalModifications: false,
    }), (error: unknown) => error instanceof CoordinatorError && error.status === 409)
    release?.()
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.equal(first.task.status, 'done')
  })

  test('restores the journal and marks interrupted tasks failed', () => {
    const dir = tempDir()
    const journal = join(dir, 'tasks.json')
    const interrupted: TaskState = {
      id: 'interrupted-task',
      kind: 'check',
      scope: 'plugins',
      status: 'running',
      phase: 'queued',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      total: 1,
      completed: 0,
      items: [{ id: 'plugin-bundle:web:a', name: 'A', status: 'running' }],
    }
    writeFileSync(journal, JSON.stringify({ version: 1, tasks: [interrupted] }), 'utf8')
    const tasks = new TaskRegistry()
    const log = new ManagerLog(join(dir, 'manager.log'))
    const services = { tasks, log } as unknown as HostServices
    const updates = { plan: async () => planFor('x'), execute: async () => undefined } as unknown as UpdateManager
    const coordinator = new UpdateCoordinator(services, { start: async () => interrupted } as any, updates, journal)
    coordinator.initialize()
    const restored = tasks.get('interrupted-task')
    assert.equal(restored?.status, 'failed')
    assert.equal(restored?.phase, 'failed')
    assert.match(restored?.error ?? '', /Host 已重启/)
    assert.equal(restored?.items[0]?.status, 'failed')
  })

  test('cancelling an unknown task returns undefined', () => {
    const { coordinator } = harness()
    assert.equal(coordinator.cancel('missing'), undefined)
  })
})
