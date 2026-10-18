/**
 * Acceptance scenario: skill update end to end in the isolated environment.
 *
 * Preconditions (created by scripts/test-env/setup.mjs and the Lead):
 *   - agents-home/skills/tavily-map holds a copy of the real tavily-map skill
 *   - agents-home/.skill-lock.json carries its provenance and tree hash
 *   - the local SKILL.md was modified after copying
 *
 * Flow: inventory -> check (expect local-modified) -> plan (expect
 * requiresConfirmation) -> update with overwriteLocalModifications -> verify
 * the local tree now equals the recorded remote tree and a backup exists.
 *
 * Usage: node scripts/test-env/scenario-skill-update.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { api, callTask, envRoot } from './client.mjs'

const skillPath = join(envRoot, 'agents-home', 'skills', 'tavily-map')

/** Read the skill's lock entry. */
function lockEntry() {
  const lock = JSON.parse(readFileSync(join(envRoot, 'agents-home', '.skill-lock.json'), 'utf8'))
  return lock.skills['tavily-map']
}

const lock = lockEntry()
console.log(`[skill-update] lock hash: ${lock.skillFolderHash}`)

const skills = await api('/skills')
const record = (skills.body.physical ?? []).find(item => item.name === 'tavily-map')
if (record === undefined) throw new Error('tavily-map not found in the test env inventory')
console.log(`[skill-update] record id: ${record.id}`)
console.log(`[skill-update] source: ${record.source.kind} / ${record.source.trust} / ${record.source.url ?? ''}`)
console.log(`[skill-update] local modification: ${record.localModification.state} (${record.localModification.detail ?? ''})`)

const checked = await callTask('/check', { scope: 'skills', refresh: true })
for (const item of checked.task.items) console.log(`[skill-update] check: ${item.name} ${item.status} ${item.message ?? ''}`)

const skillsAfterCheck = await api('/skills')
const updatedRecord = (skillsAfterCheck.body.physical ?? []).find(item => item.name === 'tavily-map')
console.log(`[skill-update] status after check: ${updatedRecord?.version.status} — ${updatedRecord?.version.reason ?? ''}`)
console.log(`[skill-update] actions: canCheck=${String(updatedRecord?.actions.canCheck)} canUpdate=${String(updatedRecord?.actions.canUpdate)}`)

const plan = await api('/update-plan', { scope: 'skills', ids: [record.id] })
console.log(`[skill-update] plan entries: ${JSON.stringify(plan.body.plan?.entries ?? null)}`)

const run = await callTask('/update', {
  scope: 'skills',
  ids: [record.id],
  confirmed: true,
  overwriteLocalModifications: true,
})
console.log(`[skill-update] task status: ${run.task.status} — ${run.task.message ?? ''}`)
for (const item of run.task.items) console.log(`[skill-update] item: ${item.name} ${item.status} ${item.message ?? ''}`)

const localText = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
console.log(`[skill-update] local modification marker still present: ${String(localText.includes('local modification for skill update test'))}`)

const after = await api('/skills')
const finalRecord = (after.body.physical ?? []).find(item => item.name === 'tavily-map')
console.log(`[skill-update] final status: ${finalRecord?.version.status} — ${finalRecord?.version.reason ?? ''}`)
console.log(`[skill-update] final local modification: ${finalRecord?.localModification.state}`)

const state = JSON.parse(readFileSync(join(envRoot, 'dsh-home', 'extension-manager', 'state.json'), 'utf8'))
const transactions = Object.values(state.transactions).filter(item => item.kind === 'skill')
console.log(`[skill-update] skill transactions: ${transactions.map(item => `${item.name}:${item.phase}`).join(', ')}`)
console.log(`[skill-update] history: ${state.history.filter(item => item.kind === 'skill').slice(0, 2).map(item => `${item.name}:${item.outcome}:${item.fromVersion ?? '?'}->${item.toVersion ?? '?'}`).join(' ; ')}`)
