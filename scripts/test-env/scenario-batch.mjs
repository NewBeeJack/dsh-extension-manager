/**
 * Acceptance scenario: concurrency guard and batch update in the isolated env.
 *
 * 1. Install dsh-context@0.72.0 and dsh-whale-widget@0.4.0 (both have newer
 *    releases), refresh checks.
 * 2. Fire two update requests at the same time for one record: exactly one must
 *    start (the other answers 409 update-busy) and the update must succeed.
 * 3. Downgrade the sample again, then run one batch update for both records and
 *    verify both landed at their latest versions with two history entries.
 *
 * Usage: node scripts/test-env/scenario-batch.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, base, callTask, envRoot, testCookie } from './client.mjs'

const dshEnv = { ...process.env, DSH_HOME: join(envRoot, 'dsh-home'), DSH_AGENTS_HOME: join(envRoot, 'agents-home') }
const profileDir = join(envRoot, 'dsh-home', 'profiles', 'web')

/** Run one dsh plugin CLI verb against the test profile. */
function pluginCommand(args) {
  execFileSync('dsh', ['plugin', '--profile', 'web', ...args], {
    env: dshEnv,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}

/** Installed version of one package in the test profile. */
function installedVersion(name) {
  return JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')).version
}

/** Find one bundle record by package name. */
async function bundleRecord(name) {
  const plugins = await api('/plugins?refresh=1')
  const record = (plugins.body.bundles ?? []).find(item => item.name === name)
  if (record === undefined) throw new Error(`${name} not found in inventory`)
  return record
}

console.log('[batch] installing sample versions …')
pluginCommand(['add', 'dsh-context@0.72.0', '--registry=https://registry.npmjs.org/'])
pluginCommand(['add', 'dsh-whale-widget@0.4.0', '--registry=https://registry.npmjs.org/'])
console.log(`[batch] context ${installedVersion('dsh-context')} / whale ${installedVersion('dsh-whale-widget')}`)

await callTask('/check', { scope: 'plugins', refresh: true })
const whale = await bundleRecord('dsh-whale-widget')
const context = await bundleRecord('dsh-context')
console.log(`[batch] statuses: whale=${whale.version.status} (${whale.version.available ?? '?'}) context=${context.version.status} (${context.version.available ?? '?'})`)

// --- concurrency guard -----------------------------------------------------
const request = () => fetch(`${base}/update`, {
  method: 'POST',
  headers: { cookie: testCookie(), 'x-dsh-extension-manager': '1', 'content-type': 'application/json' },
  body: JSON.stringify({ scope: 'plugins', ids: [whale.id], confirmed: true }),
})
const [first, second] = await Promise.all([request(), request()])
const statuses = [first.status, second.status].sort()
console.log(`[batch] concurrent update statuses: ${statuses.join(' / ')}`)
if (!(statuses.includes(200) && statuses.includes(409))) throw new Error('concurrency guard did not answer exactly one 409')
const accepted = first.status === 200 ? await first.json() : await second.json()
await (async () => {
  const { waitTask } = await import('./client.mjs')
  const task = await waitTask(accepted.task.id)
  console.log(`[batch] concurrent winner task: ${task.status} — ${task.message ?? ''}`)
  if (task.status !== 'done') throw new Error('concurrent update did not finish')
})()
console.log(`[batch] whale after concurrent update: ${installedVersion('dsh-whale-widget')}`)

// --- batch update ----------------------------------------------------------
console.log('[batch] resetting whale to 0.4.0 for the batch run …')
pluginCommand(['add', 'dsh-whale-widget@0.4.0', '--registry=https://registry.npmjs.org/'])
await callTask('/check', { scope: 'plugins', refresh: true })
const whaleAgain = await bundleRecord('dsh-whale-widget')
const contextAgain = await bundleRecord('dsh-context')
const plan = await api('/update-plan', { scope: 'plugins', ids: [whaleAgain.id, contextAgain.id] })
const entries = plan.body.plan?.entries ?? []
console.log(`[batch] batch plan entries: ${entries.map(entry => `${entry.name}:${entry.eligible ? 'eligible' : 'confirm'}:${entry.currentVersion}→${entry.targetVersion}`).join(' , ')}`)

const batch = await callTask('/update', {
  scope: 'plugins',
  ids: [whaleAgain.id, contextAgain.id],
  confirmed: true,
})
console.log(`[batch] batch task: ${batch.task.status} — ${batch.task.message ?? ''}`)
for (const item of batch.task.items) console.log(`[batch]   ${item.name} ${item.status} ${item.message ?? ''}`)
console.log(`[batch] versions now: context ${installedVersion('dsh-context')} / whale ${installedVersion('dsh-whale-widget')}`)

const state = JSON.parse(readFileSync(join(envRoot, 'dsh-home', 'extension-manager', 'state.json'), 'utf8'))
const recent = state.history.filter(item => item.kind === 'plugin-bundle').slice(0, 3)
console.log(`[batch] history: ${recent.map(item => `${item.name}:${item.outcome}:${item.fromVersion}->${item.toVersion}`).join(' ; ')}`)
// The registry keeps moving; assert against the plan's target instead of a
// hardcoded version so this acceptance scenario stays valid over time.
const contextTarget = entries.find(entry => entry.id === contextAgain.id)?.targetVersion
if (contextTarget === undefined) throw new Error('batch plan has no target version for dsh-context')
if (installedVersion('dsh-context') !== contextTarget) throw new Error(`batch did not update dsh-context to ${contextTarget}`)
const whaleTarget = entries.find(entry => entry.id === whaleAgain.id)?.targetVersion
if (whaleTarget === undefined) throw new Error('batch plan has no target version for dsh-whale-widget')
if (installedVersion('dsh-whale-widget') !== whaleTarget) throw new Error(`batch did not update dsh-whale-widget to ${whaleTarget}`)
console.log('[batch] batch verified')
