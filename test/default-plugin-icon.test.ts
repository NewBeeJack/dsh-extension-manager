/**
 * Default plugin icon resource contract: the embedded data URL must decode to
 * the checked-in 128px RGBA PNG and remain a safe local image resource.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { describe, test } from 'node:test'
import { DEFAULT_PLUGIN_ICON } from '../src/client/default-plugin-icon.ts'
import { isSafeIconDataUrl } from '../src/client/icon-safety.ts'

const PREFIX = 'data:image/png;base64,'
const asset = readFileSync(new URL('../src/client/assets/default-plugin-icon.png', import.meta.url))

describe('default plugin icon asset', () => {
  test('is a safe embedded PNG and has the expected RGBA dimensions', () => {
    assert.equal(isSafeIconDataUrl(DEFAULT_PLUGIN_ICON), true)
    assert.ok(DEFAULT_PLUGIN_ICON.startsWith(PREFIX))
    const bytes = Buffer.from(DEFAULT_PLUGIN_ICON.slice(PREFIX.length), 'base64')
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    assert.equal(bytes.readUInt32BE(16), 128)
    assert.equal(bytes.readUInt32BE(20), 128)
    assert.equal(bytes[24], 8)
    assert.equal(bytes[25], 6)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), createHash('sha256').update(asset).digest('hex'))
  })
})
