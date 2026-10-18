/**
 * Acceptance scenario: git-installed bundle update, plus real install-failure
 * recovery, in the isolated environment.
 *
 * Phase 1 (success): install the fixture repository (branch `main`, 0.1.0),
 * commit 0.1.1 upstream, check (remote branch moved), plan
 * (requiresConfirmation), update, then verify the installed version/lockfile
 * commit moved to the new commit.
 *
 * Phase 2 (failure): install 0.1.0 again, commit 0.1.1, let the checker see it,
 * then corrupt the fixture repository by deleting the new commit object. The
 * install must fail after the old bundle was removed; the executor must restore
 * the previous version from its backup.
 *
 * Usage: node scripts/test-env/scenario-git-plugin.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, callTask, envRoot } from './client.mjs'

const dshEnv = { ...process.env, DSH_HOME: join(envRoot, 'dsh-home'), DSH_AGENTS_HOME: join(envRoot, 'agents-home') }
const packageName = 'dsh-em-test-git-plugin'
const installedDir = join(envRoot, 'dsh-home', 'profiles', 'web', 'node_modules', packageName)
const lockPath = join(envRoot, 'dsh-home', 'profiles', 'web', 'pnpm-lock.yaml')
const statePath = join(envRoot, 'dsh-home', 'extension-manager', 'state.json')
const LF = String.fromCharCode(10)

/** Run the fixture preparation script and parse its JSON output. */
function prepareRepository(initialOnly = false) {
  const args = [join(import.meta.dirname, 'prepare-git-plugin.mjs')]
  if (initialOnly) args.push('--initial-only')
  const text = execFileSync(process.execPath, args, { encoding: 'utf8' })
  const start = text.indexOf('{')
  return JSON.parse(text.slice(start))
}

/** Commit a newer fixture version on the repository's main branch. */
function commitUpdate(repoPath, version) {
  const manifestPath = join(repoPath, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.version = version
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + LF)
  writeFileSync(join(repoPath, 'index.js'), [
    `export const name = ${JSON.stringify(packageName)}`,
    'export function apply() {}',
    `// fixture version ${version}`,
    '',
  ].join(LF))
  writeFileSync(join(repoPath, 'CHANGELOG.md'), `## ${version}${LF}- fixture update${LF}`)
  execFileSync('git', ['add', '-A'], { cwd: repoPath })
  execFileSync('git', ['commit', '-q', '-m', `fixture: ${version}`], { cwd: repoPath })
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoPath, encoding: 'utf8' }).trim()
}

/** Run one dsh plugin CLI verb against the test profile. */
function pluginCommand(args) {
  return execFileSync('dsh', ['plugin', '--profile', 'web', ...args], {
    env: dshEnv,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
}

/** Wait until a package directory reports the given version. */
async function waitVersion(expected, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const manifest = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8'))
      if (manifest.version === expected) return true
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return false
}

/** Reinstall the fixture through the profile's package manager. */
async function installAt(spec, version) {
  try { pluginCommand(['remove', packageName]) } catch {}
  pluginCommand(['add', spec])
  if (!await waitVersion(version)) throw new Error(`fixture did not install at ${version}`)
}

/** Read the last commit hash recorded in the profile lockfile. */
function lockfileCommit() {
  const text = readFileSync(lockPath, 'utf8')
  return [...text.matchAll(/[0-9a-f]{40}/gu)].map(match => match[0]).at(-1)
}

/** Read one bundle record from the manager API. */
async function bundleRecord() {
  const plugins = await api('/plugins?refresh=1')
  const record = (plugins.body.bundles ?? []).find(item => item.name === packageName)
  if (record === undefined) throw new Error('git fixture bundle not found in inventory')
  return record
}

// ---------------------------------------------------------------- phase 1
const fixture = prepareRepository(true)
console.log(`[git] repo ${fixture.repoDir} initial ${fixture.initialCommit.slice(0, 10)}`)
await installAt(fixture.branchSpec, '0.1.0')
const record = await bundleRecord()
console.log(`[git] record: ${record.version.current} source=${record.source.kind}/${record.source.trust} spec=${record.source.spec}`)
console.log(`[git] actions: canCheck=${String(record.actions.canCheck)} canUpdate=${String(record.actions.canUpdate)}`)

const updateCommit = commitUpdate(fixture.repoDir, '0.1.1')
console.log(`[git] upstream committed ${updateCommit.slice(0, 10)}`)

const checked = await callTask('/check', { scope: 'plugins', refresh: true, ids: [record.id] })
for (const item of checked.task.items) console.log(`[git] check: ${item.name} ${item.status} ${item.message ?? ''}`)

const afterCheck = await bundleRecord()
console.log(`[git] status: ${afterCheck.version.status} — ${afterCheck.version.reason ?? ''}`)
console.log(`[git] availableCommit: ${String(afterCheck.version.availableCommit).slice(0, 10)}`)

const plan = await api('/update-plan', { scope: 'plugins', ids: [record.id] })
const entry = plan.body.plan?.entries?.[0]
console.log(`[git] plan: eligible=${String(entry?.eligible)} requiresConfirmation=${String(entry?.requiresConfirmation)} target=${entry?.targetVersion ?? ''}`)
console.log(`[git] risk: ${entry?.risk ?? ''}`)

const run = await callTask('/update', {
  scope: 'plugins',
  ids: [record.id],
  confirmed: true,
  overwriteLocalModifications: true,
})
console.log(`[git] update: ${run.task.status} — ${run.task.message ?? ''}`)
for (const item of run.task.items) console.log(`[git]   ${item.name} ${item.status} ${item.message ?? ''}`)

const finalVersion = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version
const installedCommit = lockfileCommit()
const afterUpdate = await bundleRecord()
console.log(`[git] installed ${finalVersion}; lockfile commit ${String(installedCommit).slice(0, 10)} (expected ${updateCommit.slice(0, 10)})`)
console.log(`[git] runtime after update: enabled=${String(afterUpdate.runtime.enabled)} loaded=${String(afterUpdate.runtime.loaded)}`)
if (finalVersion !== '0.1.1') throw new Error(`git update did not install 0.1.1 (got ${finalVersion})`)
if (installedCommit !== updateCommit) throw new Error('lockfile commit does not match the target commit')

// ---------------------------------------------------------------- phase 2
console.log('[git] — phase 2: real install-failure recovery —')
const fixture2 = prepareRepository(true)
await installAt(fixture2.branchSpec, '0.1.0')
const record2 = await bundleRecord()
const targetCommit = commitUpdate(fixture2.repoDir, '0.1.1')
await callTask('/check', { scope: 'plugins', refresh: true, ids: [record2.id] })

const objectPath = join(fixture2.repoDir, '.git', 'objects', targetCommit.slice(0, 2), targetCommit.slice(2))
if (!existsSync(objectPath)) throw new Error(`target commit object not found at ${objectPath}`)
rmSync(objectPath, { force: true })
console.log(`[git] corrupted repository by deleting commit object ${targetCommit.slice(0, 10)}`)

const failedRun = await callTask('/update', {
  scope: 'plugins',
  ids: [record2.id],
  confirmed: true,
  overwriteLocalModifications: true,
})
console.log(`[git] failing update task: ${failedRun.task.status} — ${failedRun.task.message ?? ''}`)
for (const item of failedRun.task.items) console.log(`[git]   ${item.name} ${item.status} ${item.message ?? ''}`)

const recoveredVersion = JSON.parse(readFileSync(join(installedDir, 'package.json'), 'utf8')).version
const state = JSON.parse(readFileSync(statePath, 'utf8'))
const gitTransactions = Object.values(state.transactions).filter(item => item.name === packageName)
console.log(`[git] transactions: ${gitTransactions.map(item => `${item.phase}${item.rolledBack === true ? '(rolledBack)' : ''}`).join(' , ')}`)
console.log(`[git] history: ${state.history.filter(item => item.name === packageName).slice(0, 6).map(item => `${item.action}:${item.outcome}:${item.message}`).join(' ; ')}`)
if (recoveredVersion !== '0.1.0') throw new Error(`recovery did not restore 0.1.0 (got ${recoveredVersion})`)
console.log('[git] recovery verified: previous version is installed again')
