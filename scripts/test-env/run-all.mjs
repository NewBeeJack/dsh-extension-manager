/**
 * Acceptance runner: replays every isolated-environment scenario in order and
 * writes one log per scenario plus a summary.
 *
 * The isolated environment (scripts/test-env/setup.mjs + start.mjs) must be
 * running on port 3099. Real-profile checks in this runner are read-only.
 *
 * Usage: node scripts/test-env/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { envRoot } from './client.mjs'

const here = import.meta.dirname
const projectRoot = join(here, '..', '..')
const resultsDir = join(envRoot, '..', 'acceptance')
mkdirSync(resultsDir, { recursive: true })

const steps = [
  { name: 'prepare-stale-skill', script: 'prepare-stale-skill.mjs', args: [] },
  { name: 'scenario-plugin-localmod', script: 'scenario-plugin-localmod.mjs', args: [] },
  { name: 'scenario-git-plugin', script: 'scenario-git-plugin.mjs', args: [] },
  { name: 'scenario-batch', script: 'scenario-batch.mjs', args: [] },
  { name: 'scenario-interrupt', script: 'scenario-interrupt.mjs', args: [] },
  { name: 'prepare-stale-skill-again', script: 'prepare-stale-skill.mjs', args: [] },
  { name: 'scenario-skill-update', script: 'scenario-skill-update.mjs', args: [] },
]

const summary = []
for (const step of steps) {
  const startedAt = new Date().toISOString()
  console.log(`\n[acceptance] running ${step.name} …`)
  const result = spawnSync(process.execPath, [join(here, step.script), ...step.args], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const log = `# ${step.name}${String.fromCharCode(10)}# started ${startedAt}${String.fromCharCode(10)}# exit ${String(result.status)}${String.fromCharCode(10)}${String.fromCharCode(10)}${result.stdout ?? ''}${String.fromCharCode(10)}${result.stderr ?? ''}`
  writeFileSync(join(resultsDir, `${step.name}.log`), log, 'utf8')
  const passed = result.status === 0
  summary.push({ name: step.name, passed, exit: result.status })
  console.log(`[acceptance] ${step.name}: ${passed ? 'PASS' : `FAIL (exit ${String(result.status)})`}`)
  if (!passed) {
    console.error((result.stdout ?? '').slice(-2500))
    console.error((result.stderr ?? '').slice(-2500))
    break
  }
}

writeFileSync(join(resultsDir, 'summary.json'), JSON.stringify({ at: new Date().toISOString(), summary }, undefined, 2), 'utf8')
console.log(`\n[acceptance] summary written to ${join(resultsDir, 'summary.json')}`)
for (const item of summary) console.log(` - ${item.passed ? 'PASS' : 'FAIL'} ${item.name}`)
process.exit(summary.every(item => item.passed) && summary.length === steps.length ? 0 : 1)
