/**
 * Acceptance scenario: npm plugin local-modification conflict handling.
 *
 * Drives the isolated env through: downgrade dsh-whale-widget to 0.4.0 →
 * edit one installed file → refresh check → plan must flag the conflict
 * (eligible=false, requiresConfirmation=true) → update without overwrite must
 * be blocked → update with overwriteLocalModifications=true succeeds and the
 * backup keeps the modified copy.
 *
 * Usage: node scripts/test-env/scenario-plugin-localmod.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, callTask, envRoot } from './client.mjs'

const profileDir = join(envRoot, 'dsh-home', 'profiles', 'web')
const packageDir = join(profileDir, 'node_modules', 'dsh-whale-widget')

/** Install one exact registry version into the test profile. */
function installVersion(version) {
  execFileSync('dsh', ['plugin', '--profile', 'web', 'add', `dsh-whale-widget@${version}`, '--registry=https://registry.npmjs.org/'], {
    env: { ...process.env, DSH_HOME: join(envRoot, 'dsh-home'), DSH_AGENTS_HOME: join(envRoot, 'agents-home') },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}

console.log('[localmod] downgrading to 0.4.0 …')
installVersion('0.4.0')
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const mainFile = join(packageDir, manifest.main ?? 'index.js')
writeFileSync(mainFile, `${readFileSync(mainFile, 'utf8')}\n// local modification for conflict test\n`, 'utf8')
console.log('[localmod] edited', mainFile)

const plugins = await api('/plugins?refresh=1')
const record = (plugins.body.bundles ?? []).find(item => item.name === 'dsh-whale-widget')
if (record === undefined) throw new Error('dsh-whale-widget not in inventory')
console.log(`[localmod] current ${record.version.current}`)

const checked = await callTask('/check', { scope: 'plugins', refresh: true, ids: [record.id] })
for (const item of checked.task.items) console.log(`[localmod] check: ${item.name} ${item.status} ${item.message ?? ''}`)

const plan = await api('/update-plan', { scope: 'plugins', ids: [record.id] })
const entry = plan.body.plan?.entries?.[0]
console.log(`[localmod] plan entry: eligible=${String(entry?.eligible)} requiresConfirmation=${String(entry?.requiresConfirmation)} target=${entry?.targetVersion ?? ''}`)
console.log(`[localmod] risk: ${entry?.risk ?? ''}`)
if (entry?.eligible !== false || entry?.requiresConfirmation !== true) throw new Error('plan did not flag the local modification')

const blockedRun = await callTask('/update', { scope: 'plugins', ids: [record.id], confirmed: true })
console.log(`[localmod] update without overwrite: ${blockedRun.task.status} — ${blockedRun.task.message ?? ''}`)
for (const item of blockedRun.task.items) console.log(`[localmod]   ${item.name} ${item.status} ${item.message ?? ''}`)

const versionAfterBlocked = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version
console.log(`[localmod] version after blocked attempt: ${versionAfterBlocked}`)
if (versionAfterBlocked !== '0.4.0') throw new Error('blocked update changed the installed version')
const stillModified = readFileSync(mainFile, 'utf8').includes('local modification for conflict test')
console.log(`[localmod] local edit preserved after blocked attempt: ${String(stillModified)}`)
if (!stillModified) throw new Error('blocked update overwrote the local modification')

const run = await callTask('/update', {
  scope: 'plugins',
  ids: [record.id],
  confirmed: true,
  overwriteLocalModifications: true,
})
console.log(`[localmod] update with overwrite: ${run.task.status} — ${run.task.message ?? ''}`)
for (const item of run.task.items) console.log(`[localmod]   ${item.name} ${item.status} ${item.message ?? ''}`)

const finalVersion = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version
const markerGone = !readFileSync(mainFile, 'utf8').includes('local modification for conflict test')
console.log(`[localmod] final version ${finalVersion}; local marker removed: ${String(markerGone)}`)
console.log(`[localmod] backups: ${execFileSync('powershell', ['-NoProfile', '-Command', `(Get-ChildItem -LiteralPath '${join(envRoot, 'dsh-home', 'extension-manager', 'backups')}' -Directory | Measure-Object).Count`], { encoding: 'utf8' }).trim()}`)

const state = JSON.parse(readFileSync(join(envRoot, 'dsh-home', 'extension-manager', 'state.json'), 'utf8'))
const pluginTransactions = Object.values(state.transactions).filter(item => item.kind === 'plugin-bundle')
console.log(`[localmod] plugin transactions: ${pluginTransactions.map(item => `${item.name}:${item.phase}:${item.previousVersion ?? '?'}→${item.targetVersion ?? '?'}`).join(' ; ')}`)
console.log(`[localmod] blocked history: ${state.history.filter(item => item.outcome === 'blocked').slice(0, 2).map(item => `${item.name}:${item.message}`).join(' ; ')}`)
if (!existsSync(packageDir)) throw new Error('package directory missing')
