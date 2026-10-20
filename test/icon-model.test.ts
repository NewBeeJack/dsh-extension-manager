/**
 * T18 icon safety: only embedded image data URLs may reach an `<img>`.
 * Actual image decode failures are covered by the ExtensionIcon onError path.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isSafeIconDataUrl } from '../src/client/icon-safety.ts'

describe('isSafeIconDataUrl', () => {
  test('accepts embedded png, jpeg, webp and svg data URLs', () => {
    assert.equal(isSafeIconDataUrl('data:image/png;base64,iVBORw0KGgo='), true)
    assert.equal(isSafeIconDataUrl('data:image/jpeg;base64,/9j/4AAQ'), true)
    assert.equal(isSafeIconDataUrl('data:image/webp;base64,UklGRg=='), true)
    assert.equal(isSafeIconDataUrl('data:image/svg+xml;base64,PHN2Zz4='), true)
    assert.equal(isSafeIconDataUrl(' data:image/png;base64,AAAA '), true)
  })

  test('rejects missing, empty, remote, file and non-image references', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      'C:\\plugin\\icon.svg',
      'file:///C:/plugin/icon.svg',
      'https://example.com/icon.png',
      'data:text/html;base64,PHNjcmlwdD4=',
      'data:image/png,not-base64',
      'data:image/png;base64,',
      'data:image/png;base64,%%%%',
    ]) {
      assert.equal(isSafeIconDataUrl(value), false, String(value))
    }
  })
})
