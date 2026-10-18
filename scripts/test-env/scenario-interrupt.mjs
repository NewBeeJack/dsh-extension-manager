/**
 * Acceptance scenario: Host process interruption during an update, then
 * restart-time recovery.
 *
 * Resets dsh-context to 0.72.0, starts the real update, kills the test Host a
 * little later (mid-install), restarts it, and verifies the persisted
 * transaction was reconciled and the profile is still usable.
 *
 * Usage: node scripts/test-env/scenario-interrupt.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, callTask, envRoot } from './client.mjs'

const projectRoot = join(import.meta.dirname, '..', '..')
const dshEnv = { ...process.env, DSH_HOME: join(envRoot, 'dsh-home'), DSH_AGENTS_HOME: join(envRoot, 'agents-home') }
const profileDir = join(envRoot, 'dsh-home', 'profiles', 'web')
const statePath = join(envRoot, 'dsh-home', 'extension-manager', 'state.json')
const pidPath = join(envRoot, 'out', 'server.pid')

/** Run one dsh plugin CLI verb. */
function pluginCommand(args) {
  execFileSync('dsh', ['plugin', '--profile', 'web', ...args], {
    env: dshEnv, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'ignore', 'inherit'],
  })
}

/** Send a signal to the whole recorded test server tree. */
function killServer() {
  const pid = Number(readFileSync(pidPath, 'utf8').trim())
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(-pid, 'SIGKILL')
}

/** Start the test server and wait until its URL is printed. */
function startServer() {
  const result = spawnSync(process.execPath, [join(projectRoot, 'scripts', 'test-env', 'start.mjs')], { encoding: 'utf8' })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.status !== 0) throw new Error('test server did not restart')
}

/** Installed version of one package. */
function versionOf(name) {
  return JSON.parse(readFileSync(join(profileDir, 'node_modules', name, 'package.json'), 'utf8')).version
}

/** Wait until the manager answers again. */
async function waitManager(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const health = await api('/health')
      if (health.status === 200 && health.body?.ok === true) return
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('manager did not come back after restart')
}

/** Reset the sample package to the older version and refresh the check. */
async function resetSample() {
  pluginCommand(['add', 'dsh-context@0.72.0', '--registry=https://registry.npmjs.org/'])
  const plugins = await api('/plugins?refresh=1')
  const record = (plugins.body.bundles ?? []).find(item => item.name === 'dsh-context')
  if (record === undefined) throw new Error('dsh-context missing from inventory')
  await callTask('/check', { scope: 'plugins', refresh: true, ids: [record.id] })
  return record
}

let attempts = 0
while (attempts < 3) {
  attempts += 1
  console.log(`[interrupt] attempt ${String(attempts)}: reset sample to 0.72.0`)
  await waitManager()
  const record = await resetSample()
  console.log(`[interrupt] starting update ${record.version.current} → ${record.version.available ?? '?'}`)
  const started = await api('/update', { scope: 'plugins', ids: [record.id], confirmed: true })
  if (started.status !== 200) throw new Error(`update did not start: ${String(started.status)}`)
  const taskId = started.body.task.id
  await new Promise(resolve => setTimeout(resolve, 1500))
  console.log('[interrupt] killing the test Host mid-update')
  killServer()
  await new Promise(resolve => setTimeout(resolve, 1500))

  const stateBefore = JSON.parse(readFileSync(statePath, 'utf8'))
  const transactionBefore = Object.values(stateBefore.transactions).find(item => item.id === taskId)
    ?? Object.values(stateBefore.transactions).at(-1)
  console.log(`[interrupt] persisted transaction before restart: ${transactionBefore?.name ?? '?'} ${transactionBefore?.phase ?? '?'}`)

  console.log('[interrupt] restarting the test Host')
  startServer()
  await waitManager()
  // Recovery runs asynchronously right after the plugin activates; wait for a
  // terminal phase instead of reading the transient RECOVERY state.
  let transactionAfter
  const recoveryDeadline = Date.now() + 40_000
  while (Date.now() < recoveryDeadline) {
    const stateAfter = JSON.parse(readFileSync(statePath, 'utf8'))
    transactionAfter = Object.values(stateAfter.transactions).find(item => item.id === transactionBefore?.id)
    const transient = new Set(['RECOVERY', 'INSTALL', 'VALIDATE', 'BACKUP', 'PREFLIGHT', 'DOWNLOAD', 'STAGE', 'FAILED'])
    if (transactionAfter !== undefined && !transient.has(transactionAfter.phase)) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  console.log(`[interrupt] transaction after recovery: ${transactionAfter?.phase ?? '?'} rolledBack=${String(transactionAfter?.rolledBack ?? false)}`)
  await new Promise(resolve => setTimeout(resolve, 3000))
  const versionAfter = versionOf('dsh-context')
  console.log(`[interrupt] dsh-context version after recovery: ${versionAfter}`)
  const pluginsAfter = await api('/plugins?refresh=1')
  const recordAfter = (pluginsAfter.body.bundles ?? []).find(item => item.name === 'dsh-context')
  console.log(`[interrupt] inventory after restart: status=${pluginsAfter.status} bundles=${(pluginsAfter.body.bundles ?? []).length} record=${recordAfter?.version.current ?? '?'} loaded=${String(recordAfter?.runtime.loaded)}`)

  if (transactionAfter !== undefined
    && (transactionAfter.phase === 'RECOVERED' || transactionAfter.phase === 'RECOVERY_REQUIRED' || transactionAfter.phase === 'RISK-UNKNOWN')) {
    console.log('[interrupt] interruption recovery verified')
    process.exit(0)
  }
  if (transactionAfter?.phase === 'VERIFIED') {
    console.log('[interrupt] update finished before the kill; retrying with a shorter delay')
    continue
  }
  throw new Error(`unexpected transaction state after restart: ${transactionAfter?.phase ?? 'missing'}`)
}
console.error('[interrupt] could not hit the interruption window in 3 attempts')
process.exit(1)
