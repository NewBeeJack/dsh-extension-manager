/**
 * V02 path semantics: installDir is the directory field; manifestPath may
 * supply its parent; resolvedPath is a link/file target and must never be
 * silently treated as an installation directory.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { manifestParentDirectory, recordInstallDirectory } from '../src/client/model.ts'
import type { ExtensionRecord } from '../src/client/model.ts'

const plugin = {
  kind: 'plugin-bundle',
  paths: {},
} as unknown as ExtensionRecord
const skill = {
  kind: 'skill',
  layout: 'directory',
  paths: {},
} as unknown as ExtensionRecord
const virtualSkill = {
  kind: 'skill',
  layout: 'virtual',
  paths: {},
} as unknown as ExtensionRecord

describe('recordInstallDirectory', () => {
  test('prefers the explicit installation directory', () => {
    assert.equal(recordInstallDirectory({ ...plugin, paths: { installDir: 'C:\\pkg' } }), 'C:\\pkg')
  })

  test('does not treat resolvedPath as a directory', () => {
    assert.equal(recordInstallDirectory({ ...plugin, paths: { resolvedPath: 'C:\\link\\entry.js' } }), undefined)
  })

  test('uses the parent of a verified manifest path when installDir is absent', () => {
    assert.equal(
      recordInstallDirectory({ ...plugin, paths: { manifestPath: 'C:\\pkg\\package.json' } }),
      'C:\\pkg',
    )
    assert.equal(
      recordInstallDirectory({ ...skill, paths: { manifestPath: 'C:\\skills\\demo\\SKILL.md' } }),
      'C:\\skills\\demo',
    )
    assert.equal(
      recordInstallDirectory({ ...skill, paths: { manifestPath: 'C:/skills/demo/SKILL.md' } }),
      'C:/skills/demo',
    )
  })

  test('virtual skills have no independent installation directory', () => {
    assert.equal(recordInstallDirectory({ ...virtualSkill, paths: { installDir: 'C:\\virtual' } }), undefined)
  })
})

describe('manifestParentDirectory', () => {
  test('handles Windows and POSIX separators without inventing a parent', () => {
    assert.equal(manifestParentDirectory('C:\\a\\b\\SKILL.md'), 'C:\\a\\b')
    assert.equal(manifestParentDirectory('/a/b/SKILL.md'), '/a/b')
    assert.equal(manifestParentDirectory('SKILL.md'), undefined)
    assert.equal(manifestParentDirectory(''), undefined)
  })
})
