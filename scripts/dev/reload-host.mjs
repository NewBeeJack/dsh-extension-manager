/**
 * Development helper: make the running DSH Host recompose its profile so a
 * rebuilt `lib/index.js` of this linked package is picked up.
 *
 * HMR compares loaded module files on a profile recomposition; a profile patch
 * edit is the cheapest supported trigger. This script appends one comment,
 * waits for the debounce window, and restores the exact original bytes, so the
 * user's patch file ends unchanged.
 *
 * Usage: node scripts/dev/reload-host.mjs [profile] [waitMs]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const profile = process.argv[2] ?? 'web'
const waitMs = Number(process.argv[3] ?? '7000')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const file = join(home, 'profiles', profile, 'cordis.patch.yml')

const original = readFileSync(file, 'utf8')
const probe = `\n# dsh-extension-manager reload probe ${String(Date.now())}\n`
try {
  writeFileSync(file, original + probe, 'utf8')
  await new Promise(resolve => setTimeout(resolve, waitMs))
} finally {
  writeFileSync(file, original, 'utf8')
}
console.log(`[reload] triggered recomposition via ${file}`)
