/**
 * Prepare a stale-but-real skill fixture for the isolated update scenario.
 *
 * Uses the codeload archive of an older revision of `skills/tavily-map` from
 * the public tavily-ai/skills repository. The old folder's git tree sha is
 * computed locally with git plumbing (no GitHub API call, so the fixture is
 * independent of the anonymous rate limit); the latest remote tree sha is the
 * one recorded by the real local skill lock.
 *
 * Usage: node scripts/test-env/prepare-stale-skill.mjs
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { envRoot } from './client.mjs'

const repo = 'tavily-ai/skills'
const skillPath = 'skills/tavily-map'
const olderCommit = '0ea2d76840'
/** Latest remote tree sha of the skill folder (from the real machine's lock). */
const latestTree = '371b07b3a6885fc61686160d5cee5101d7a863a0'
const headers = { 'user-agent': 'dsh-extension-manager-test' }
const LF = String.fromCharCode(10)

const outDir = join(envRoot, 'out')
mkdirSync(outDir, { recursive: true })
const archivePath = join(outDir, 'stale-skill.tgz')

/** Download the codeload archive once and cache it. */
async function ensureArchive() {
  if (existsSync(archivePath) && readFileSync(archivePath).byteLength > 10_000) return
  const response = await fetch(`https://codeload.github.com/${repo}/tar.gz/${olderCommit}`, { headers })
  if (!response.ok) throw new Error(`codeload ${String(response.status)}`)
  writeFileSync(archivePath, Buffer.from(await response.arrayBuffer()))
}

/** Extract the archive into a fresh directory and return the skill folder. */
function extractArchive() {
  const temp = mkdtempSync(join(tmpdir(), 'dsh-em-stale-'))
  // This tar is MSYS GNU tar on Windows: forward slashes avoid path mangling.
  const posix = (value) => value.split(String.fromCharCode(92)).join('/')
  execFileSync('tar', [
    '-xzf', 'stale-skill.tgz', '--strip-components=2',
    '-C', posix(temp), `skills-${olderCommit}/${skillPath}`,
  ], { cwd: outDir, stdio: 'inherit' })
  // Two stripped components leave the skill folder itself as the top entry.
  return join(temp, 'tavily-map')
}

/** Compute the git tree sha of one directory (the same hash GitHub reports). */
function folderTreeSha(dir) {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-em-hash-'))
  try {
    cpSync(dir, join(scratch, 'skill'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: scratch })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: scratch })
    execFileSync('git', ['config', 'core.fileMode', 'false'], { cwd: scratch })
    execFileSync('git', ['add', '-A'], { cwd: scratch })
    const rootTree = execFileSync('git', ['write-tree'], { cwd: scratch, encoding: 'utf8' }).trim()
    return execFileSync('git', ['rev-parse', `${rootTree}:skill`], { cwd: scratch, encoding: 'utf8' }).trim()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

await ensureArchive()
const extracted = extractArchive()
const target = join(envRoot, 'agents-home', 'skills', 'tavily-map')
rmSync(target, { recursive: true, force: true })
cpSync(extracted, target, { recursive: true })
rmSync(extracted, { recursive: true, force: true })
console.log(`[stale-skill] installed older revision into ${target}`)

const oldTree = folderTreeSha(target)
console.log(`[stale-skill] stale tree  ${oldTree}`)
console.log(`[stale-skill] latest tree ${latestTree}`)
if (oldTree === latestTree) throw new Error('older revision unexpectedly equals the latest tree')

const lockPath = join(envRoot, 'agents-home', '.skill-lock.json')
const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
lock.skills['tavily-map'] = {
  source: repo,
  sourceType: 'github',
  sourceUrl: `https://github.com/${repo}.git`,
  skillPath: `${skillPath}/SKILL.md`,
  skillFolderHash: oldTree,
  installedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
writeFileSync(lockPath, JSON.stringify(lock, undefined, 2), 'utf8')
console.log('[stale-skill] lock baseline updated to the stale tree')

const skillMd = join(target, 'SKILL.md')
writeFileSync(skillMd, `${readFileSync(skillMd, 'utf8')}${LF}<!-- local modification for skill update test -->${LF}`, 'utf8')
console.log('[stale-skill] local SKILL.md modified to create the conflict')
