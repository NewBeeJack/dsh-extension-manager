/**
 * Task skip snapshot lifecycle: check tasks keep the skipped-item snapshot
 * across start/finish, and old tasks without the optional field restore safely.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { TaskRegistry } from '../src/host/tasks.ts'
import type { TaskState } from '../src/shared/types.ts'

const skipped = [
  {
    id: 'plugin-bundle:web:dsh-extension-manager',
    name: '扩展管理器',
    reason: '管理器自身不支持在此页面更新',
  },
  {
    id: 'plugin-bundle:web:local-demo',
    name: '本地演示插件',
    reason: '本地安装（link/路径），更新由开发者负责',
  },
]

describe('TaskRegistry skipped snapshot', () => {
  test('stores a defensive copy and keeps it through start/finish', () => {
    const tasks = new TaskRegistry()
    const task = tasks.create({
      kind: 'check',
      scope: 'plugins',
      items: [{ id: 'plugin-bundle:web:checked', name: '已检查插件' }],
      skipped,
    })
    assert.deepEqual(task.skipped, skipped)
    assert.notEqual(task.skipped, skipped)

    tasks.start(task.id)
    tasks.itemDone(task.id, 'plugin-bundle:web:checked', 'ok', '已是最新稳定版')
    tasks.finish(task.id, 'done', '已检查 1 项，0 项有更新，2 项跳过')

    const settled = tasks.get(task.id)
    assert.deepEqual(settled?.skipped, skipped)
    assert.equal(settled?.status, 'done')
    assert.equal(settled?.items.length, 1)
    assert.equal(settled?.items[0]?.status, 'ok')
    assert.equal(settled?.message, '已检查 1 项，0 项有更新，2 项跳过')
  })

  test('stores an explicit empty snapshot without creating skipped detail', () => {
    const tasks = new TaskRegistry()
    const task = tasks.create({
      kind: 'check',
      scope: 'plugins',
      items: [{ id: 'plugin-bundle:web:checked', name: '已检查插件' }],
      skipped: [],
    })
    assert.deepEqual(task.skipped, [])
  })

  test('restores legacy tasks without skipped without inventing detail', () => {
    const tasks = new TaskRegistry()
    const legacy: TaskState = {
      id: 'legacy-check',
      kind: 'check',
      scope: 'plugins',
      status: 'done',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      total: 1,
      completed: 1,
      items: [{ id: 'plugin-bundle:web:a', name: 'A', status: 'ok' }],
      message: '已检查 1 项，0 项有更新，1 项跳过',
    }
    tasks.restore([legacy])
    const restored = tasks.get('legacy-check')
    assert.equal(restored?.items.length, 1)
    assert.equal(restored?.skipped, undefined)
    assert.equal(restored?.message, '已检查 1 项，0 项有更新，1 项跳过')
  })

  test('keeps plugins and skills snapshots independent', () => {
    const tasks = new TaskRegistry()
    const plugins = tasks.create({
      kind: 'check', scope: 'plugins',
      items: [], skipped: [skipped[0]],
    })
    const skills = tasks.create({
      kind: 'check', scope: 'skills',
      items: [], skipped: [{ id: 'skill:x', name: 'Skill X', reason: 'no-source' }],
    })
    assert.equal(tasks.get(plugins.id)?.skipped?.[0]?.id, 'plugin-bundle:web:dsh-extension-manager')
    assert.equal(tasks.get(skills.id)?.skipped?.[0]?.id, 'skill:x')
  })
})
