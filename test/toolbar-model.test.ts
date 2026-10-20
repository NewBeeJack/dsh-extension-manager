/**
 * Toolbar label contract: full-width Chinese parentheses, dynamic integer N,
 * no badge split, no thousand separators or suffix.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { checkTaskIsComplete, formatUpdateAllLabel } from '../src/client/model.ts'
import type { TaskState } from '../src/shared/types.ts'

describe('checkTaskIsComplete', () => {
  const base: Pick<TaskState, 'status' | 'items' | 'message'> = {
    status: 'done',
    items: [{ id: 'a', name: 'A', status: 'failed' }, { id: 'b', name: 'B', status: 'ok' }],
  }
  test('rejects failed, partial and incomplete tasks', () => {
    assert.equal(checkTaskIsComplete(base), false)
    assert.equal(checkTaskIsComplete({ ...base, status: 'failed' }), false)
    assert.equal(checkTaskIsComplete({ ...base, status: 'running' }), false)
    assert.equal(checkTaskIsComplete({ ...base, items: [{ id: 'a', name: 'A', status: 'ok' }], message: '检查完成；来源网络失败' }), false)
  })
  test('accepts a done task with all attempted items ok', () => {
    assert.equal(checkTaskIsComplete({ ...base, items: [{ id: 'a', name: 'A', status: 'ok' }], message: '已检查 1 项' }), true)
    assert.equal(checkTaskIsComplete({ status: 'done', items: [], message: '没有需要重新检查的项目' }), true)
  })
})

describe('formatUpdateAllLabel', () => {
  test('keeps the exact update-all wording and full-width brackets', () => {
    assert.equal(formatUpdateAllLabel(1), '更新全部（1）')
    assert.equal(formatUpdateAllLabel(2), '更新全部（2）')
    assert.equal(formatUpdateAllLabel(12), '更新全部（12）')
  })

  test('never produces a separate badge or suffix', () => {
    for (const count of [0, 1, 2, 12, 999]) {
      const label = formatUpdateAllLabel(count)
      assert.match(label, /^更新全部（\d+）$/u)
      assert.equal(label.includes('项'), false)
      assert.equal(label.includes('('), false)
      assert.equal(label.includes(')'), false)
    }
  })
})
