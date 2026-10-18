/**
 * Tests for the skills inventory helpers.
 *
 * Run with `node --test test/skills.test.ts` (Node 22.19+ strips types).
 * The last two tests read the real machine read-only: they verify the
 * `skills` CLI lock hashes against the installed directories and that the
 * Codex skill root is reported as not managed by DSH. They skip themselves
 * when the corresponding directory is absent.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  computeSkillFolderTreeSha,
  decideSkillUpdateStatus,
  dedupePhysicalCopies,
  describePhysicalAliases,
  discoverRoot,
  findProjectRootSync,
  findSkillLockEntry,
  formatRecordAge,
  gitBlobSha,
  githubRateLimitMessage,
  linkRuntimeCatalog,
  lockEntrySubdir,
  parseFrontmatter,
  parseGitHubRepository,
  parseGitHubTokenOutput,
  parseSkillLock,
  parseSkillMarkdown,
  readGitHeadTree,
  readGitRepository,
  readGitWorktreeStatus,
  readSkillLockFile,
  resolveLocalModificationDecision,
  resolvePhysicalOverrides,
  resolveSkillRoots,
  sameTreeSha,
  selectGitHubToken,
  skillPathKey,
  type PhysicalCopyOrdering,
  type PhysicalSkillIdentity,
  type SkillProviderSettings,
  type SkillRootSpec,
} from '../src/host/inventory/skillRoots.ts'

/** Fixture tree that a real `git write-tree` hashed to this id. */
const FIXTURE_SKILL_MD = '---\nname: fixture-skill\ndescription: fixture skill for tree hashing\n---\n\nBody\n'
const FIXTURE_NOTES_MD = 'notes\n'
const FIXTURE_TREE_SHA = '85c433b0ecf5b9272cc29f1b69021cf85f43cd0d'

/** Create a temporary directory removed at the end of one test. */
function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skills-test-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Write one directory-bundle skill with a valid frontmatter. */
function writeDirectorySkill(root: string, name: string, extraFiles: Record<string, string> = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody of ${name}\n`)
  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const target = join(dir, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
  return dir
}

/** Build one root spec for discovery tests. */
function rootSpec(path: string, overrides: Partial<SkillRootSpec> = {}): SkillRootSpec {
  return { key: 'test-root', label: '测试根', path, managed: true, kind: 'custom', ...overrides }
}

/** Provider settings used by root-resolution tests. */
function settingsFor(input: { dshHome: string; agentsHome: string; customSkillDirs?: string[] }): SkillProviderSettings {
  return {
    providerName: 'filesystem',
    includeDefaultRoots: true,
    dshHome: input.dshHome,
    agentsHome: input.agentsHome,
    customSkillDirs: input.customSkillDirs ?? [],
    source: 'loader',
    notes: [],
  }
}

/** Build one physical copy identity for override/link tests. */
function identity(input: {
  id: string
  name: string
  rootKey: string
  rank?: number
  managed: boolean
  dir: string
}): PhysicalSkillIdentity {
  const manifestPath = join(input.dir, 'SKILL.md')
  return {
    id: input.id,
    name: input.name,
    rootKey: input.rootKey,
    managed: input.managed,
    realPath: manifestPath,
    manifestPath,
    dir: input.dir,
    ...(input.rank === undefined ? {} : { rank: input.rank }),
  }
}

test('parseFrontmatter reads LF and CRLF documents', () => {
  const lf = '---\nname: alpha\ndescription: first\n---\n\nBody\n'
  const parsed = parseFrontmatter(lf)
  assert.equal(parsed?.data.name, 'alpha')
  assert.equal(parsed?.body, '\nBody\n')
  const crlf = lf.replaceAll('\n', '\r\n')
  const parsedCrlf = parseFrontmatter(crlf)
  assert.equal(parsedCrlf?.data.name, 'alpha')
  assert.equal(parseFrontmatter('# no frontmatter\n'), undefined)
})

test('parseSkillMarkdown accepts valid skills and explains invalid ones', () => {
  const valid = parseSkillMarkdown(
    '---\nname: alpha\ndescription: Alpha skill\nwhenToUse: when alpha\ndisable-model-invocation: true\nuser-invocable: "no"\n---\nBody\n',
    '/skills/alpha/SKILL.md',
  )
  assert.equal(valid.ok, true)
  if (valid.ok) {
    assert.equal(valid.skill.name, 'alpha')
    assert.equal(valid.skill.whenToUse, 'when alpha')
    assert.equal(valid.skill.invocation.modelInvocable, false)
    assert.equal(valid.skill.invocation.userInvocable, false)
  }
  const cases: Array<[string, string]> = [
    ['no frontmatter at all', 'skill/missing-frontmatter'],
    ['---\nname: alpha\n---\n', 'skill/missing-description'],
    ['---\ndescription: only description\n---\n', 'skill/missing-name'],
    ['---\nname: Bad_Name\ndescription: x\n---\n', 'skill/invalid-name'],
    ['---\nname: alpha\ndescription: x\ndisableModelInvocation: true\n---\n', 'skill/invalid-invocation'],
    ['---\nname: alpha\ndescription: x\nuser-invocable: maybe\n---\n', 'skill/invalid-invocation'],
    ['---\nname: [unclosed\ndescription: x\n---\n', 'skill/invalid-yaml'],
  ]
  for (const [raw, expectedCode] of cases) {
    const result = parseSkillMarkdown(raw, '/skills/x/SKILL.md')
    assert.equal(result.ok, false, `expected failure for ${JSON.stringify(raw)}`)
    if (!result.ok) assert.equal(result.diagnostic.code, expectedCode)
  }
})

test('discoverRoot supports directory bundles, flat files and skipSystem', async (t) => {
  const dir = tempDir(t)
  writeDirectorySkill(dir, 'alpha', { 'references/notes.md': 'notes\n' })
  writeFileSync(join(dir, 'beta.md'), '---\nname: beta\ndescription: flat beta\n---\n\nBody\n')
  writeFileSync(join(dir, 'readme.txt'), 'ignored')
  mkdirSync(join(dir, 'broken'))
  writeFileSync(join(dir, 'broken', 'SKILL.md'), 'not a skill file')
  writeDirectorySkill(join(dir, '.system'), 'gamma')
  const discovery = await discoverRoot({ ...rootSpec(dir), skipSystem: true })
  assert.deepEqual(discovery.skills.map(skill => skill.name).sort(), ['alpha', 'beta'])
  const alpha = discovery.skills.find(skill => skill.name === 'alpha')
  assert.equal(alpha?.layout, 'directory')
  const beta = discovery.skills.find(skill => skill.name === 'beta')
  assert.equal(beta?.layout, 'flat-file')
  assert.equal(discovery.skills.some(skill => skill.name === 'gamma'), false)
  assert.equal(discovery.diagnostics.some(item => item.code === 'skill/missing-frontmatter'), true)
  assert.equal(discovery.complete, true)
})

test('computeSkillFolderTreeSha matches git write-tree (LF and CRLF)', async (t) => {
  const dir = tempDir(t)
  const skillDir = join(dir, 'fixture-skill')
  mkdirSync(join(skillDir, 'references'), { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), FIXTURE_SKILL_MD)
  writeFileSync(join(skillDir, 'references', 'notes.md'), FIXTURE_NOTES_MD)
  const lf = await computeSkillFolderTreeSha(skillDir)
  assert.equal(lf.error, undefined)
  assert.equal(lf.sha, FIXTURE_TREE_SHA)
  assert.equal(lf.files, 2)
  // The same content installed by a Windows tool with CRLF line endings must
  // produce the same tree id, otherwise every install would look modified.
  writeFileSync(join(skillDir, 'SKILL.md'), FIXTURE_SKILL_MD.replaceAll('\n', '\r\n'))
  writeFileSync(join(skillDir, 'references', 'notes.md'), FIXTURE_NOTES_MD.replaceAll('\n', '\r\n'))
  const crlf = await computeSkillFolderTreeSha(skillDir)
  assert.equal(crlf.sha, FIXTURE_TREE_SHA)
  // Git does not track empty directories.
  mkdirSync(join(skillDir, 'empty-dir'))
  const withEmpty = await computeSkillFolderTreeSha(skillDir)
  assert.equal(withEmpty.sha, FIXTURE_TREE_SHA)
  // Known git blob id for "hello\n" keeps the object format pinned.
  assert.equal(gitBlobSha(Buffer.from('hello\n', 'utf8')), 'ce013625030ba8dba906f756967f9e9ca394464a')
})

test('decideSkillUpdateStatus order: equal-to-remote wins, then remote-change, then local-only', () => {
  const baseline = 'a'.repeat(40)
  const remote = 'b'.repeat(40)
  const local = 'c'.repeat(40)
  // a) local == remote, even when the lock baseline is older (manager already
  // updated the copy but never rewrote ~/.agents/.skill-lock.json).
  const staleBaseline = decideSkillUpdateStatus({ localTree: remote, remoteTree: remote, baselineTree: baseline })
  assert.equal(staleBaseline.status, 'up-to-date')
  assert.equal(staleBaseline.staleBaseline, true)
  const clean = decideSkillUpdateStatus({ localTree: remote, remoteTree: remote, baselineTree: remote })
  assert.equal(clean.status, 'up-to-date')
  assert.equal(clean.staleBaseline, false)
  // b) local != remote and remote != baseline → update-available; the local
  // conflict is reported through localChanged so the planner asks for
  // confirmation.
  const conflict = decideSkillUpdateStatus({ localTree: local, remoteTree: remote, baselineTree: baseline })
  assert.equal(conflict.status, 'update-available')
  assert.equal(conflict.localChanged, true)
  assert.equal(conflict.remoteChanged, true)
  const pureUpdate = decideSkillUpdateStatus({ localTree: baseline, remoteTree: remote, baselineTree: baseline })
  assert.equal(pureUpdate.status, 'update-available')
  assert.equal(pureUpdate.localChanged, false)
  // c) local != remote but remote == baseline → local-modified only.
  const localOnly = decideSkillUpdateStatus({ localTree: local, remoteTree: baseline, baselineTree: baseline })
  assert.equal(localOnly.status, 'local-modified')
  assert.equal(localOnly.remoteChanged, false)
  // No trustworthy baseline cannot be reasoned about.
  const unknown = decideSkillUpdateStatus({ localTree: local, remoteTree: remote })
  assert.equal(unknown.status, 'check-failed')
  assert.equal(unknown.baselineKnown, false)
})

test('resolveLocalModificationDecision aligns clean copies with the cached upstream tree', () => {
  const oldBaseline = 'a'.repeat(40)
  const remote = 'b'.repeat(40)
  const local = 'c'.repeat(40)
  const now = Date.parse('2026-10-18T00:00:00Z')
  // a) manager updated the folder but ~/.agents/.skill-lock.json still records
  // the old baseline: content equal to upstream must be clean, not modified.
  const stale = resolveLocalModificationDecision({
    localTree: remote,
    remoteTree: remote,
    baselineTree: oldBaseline,
    baselineLabel: '锁记录基线',
    baselineRecordedAt: new Date(now - 21 * 86_400_000).toISOString(),
    now,
  })
  assert.equal(stale.state, 'clean')
  assert.match(stale.detail ?? '', /内容与远端一致/u)
  assert.match(stale.detail ?? '', /锁记录基线/u)
  assert.match(stale.detail ?? '', /较旧/u)
  assert.match(stale.detail ?? '', /3 周前记录/u)
  // Same baseline → clean with a plain message.
  const same = resolveLocalModificationDecision({ localTree: remote, remoteTree: remote, baselineTree: remote })
  assert.equal(same.state, 'clean')
  assert.equal(same.detail, `内容与远端一致（${remote.slice(0, 12)}）`)
  // Local edits (local != remote) still compare against the baseline.
  const edited = resolveLocalModificationDecision({ localTree: local, remoteTree: remote, baselineTree: oldBaseline })
  assert.equal(edited.state, 'modified')
  assert.match(edited.detail ?? '', /基线/u)
  // No remote observation: the recorded baseline alone decides.
  const baselineClean = resolveLocalModificationDecision({ localTree: remote, baselineTree: remote })
  assert.equal(baselineClean.state, 'clean')
  const baselineModified = resolveLocalModificationDecision({ localTree: local, baselineTree: remote })
  assert.equal(baselineModified.state, 'modified')
  // Nothing comparable → caller falls back to Git worktree state.
  assert.equal(resolveLocalModificationDecision({ localTree: local }).state, 'unknown')
  assert.equal(formatRecordAge(new Date(now - 21 * 86_400_000).toISOString(), now), '3 周前')
  assert.equal(formatRecordAge(undefined, now), '')
})

test('parseSkillLock reads the skills CLI v3 document', () => {
  const document = JSON.stringify({
    version: 3,
    skills: {
      alpha: {
        source: 'owner/repo',
        sourceType: 'github',
        sourceUrl: 'https://github.com/owner/repo.git',
        skillPath: 'skills/alpha/SKILL.md',
        skillFolderHash: 'a'.repeat(40),
      },
      broken: 'not-an-object',
    },
  })
  const parsed = parseSkillLock(document)
  assert.equal(parsed.lock?.version, 3)
  assert.equal(Object.keys(parsed.lock?.skills ?? {}).length, 1)
  assert.equal(parsed.diagnostics.some(item => item.code === 'skill-lock/invalid-entry'), true)
  assert.equal(findSkillLockEntry(parsed.lock, 'alpha')?.skillFolderHash, 'a'.repeat(40))
  assert.equal(lockEntrySubdir(findSkillLockEntry(parsed.lock, 'alpha') ?? {}), 'skills/alpha')
  const malformed = parseSkillLock('{ not json')
  assert.equal(malformed.lock, undefined)
  assert.equal(malformed.diagnostics[0]?.code, 'skill-lock/invalid-json')
  const older = parseSkillLock(JSON.stringify({ version: 2, skills: {} }))
  assert.equal(older.diagnostics.some(item => item.code === 'skill-lock/unknown-version'), true)
})

test('parseGitHubRepository accepts the URL spellings installers write', () => {
  assert.deepEqual(parseGitHubRepository('https://github.com/tavily-ai/skills.git'), { owner: 'tavily-ai', repo: 'skills' })
  assert.deepEqual(parseGitHubRepository('git@github.com:tavily-ai/skills.git'), { owner: 'tavily-ai', repo: 'skills' })
  assert.deepEqual(parseGitHubRepository('github:owner/repo'), { owner: 'owner', repo: 'repo' })
  assert.equal(parseGitHubRepository('https://gitlab.com/owner/repo'), undefined)
  assert.equal(parseGitHubRepository('not a url'), undefined)
})

test('GitHub token helpers keep the token in memory and prefer the environment', () => {
  const token = `gho_${'a'.repeat(36)}`
  assert.equal(parseGitHubTokenOutput(`  ${token}\r\n`), token)
  assert.equal(parseGitHubTokenOutput(''), undefined)
  assert.equal(parseGitHubTokenOutput('ghp_short'), undefined)
  assert.equal(parseGitHubTokenOutput('two\nlines'), undefined)
  // Environment tokens win; a lazily resolved `gh` token is only a fallback.
  assert.equal(selectGitHubToken({ GITHUB_TOKEN: '  env-token  ' }, token), 'env-token')
  assert.equal(selectGitHubToken({ GH_TOKEN: 'gh-env-token' }, token), 'gh-env-token')
  assert.equal(selectGitHubToken({ GITHUB_TOKEN: '' }, token), token)
  assert.equal(selectGitHubToken({}, undefined), undefined)
})

test('GitHub rate-limit messages distinguish anonymous exhaustion from API failure', () => {
  const now = Date.parse('2026-10-18T06:00:00Z')
  const resetEpochSeconds = Math.floor(now / 1000) + 40 * 60
  const anonymous = githubRateLimitMessage({ authenticated: false, resetEpochSeconds, now })
  assert.match(anonymous, /GitHub 匿名限额已用尽/u)
  assert.match(anonymous, /gh auth login/u)
  assert.match(anonymous, /本次结果不会显示为“最新”/u)
  const authenticated = githubRateLimitMessage({ authenticated: true, resetEpochSeconds, now })
  assert.match(authenticated, /GitHub API 限额已用尽/u)
  assert.doesNotMatch(authenticated, /匿名/u)
  assert.match(githubRateLimitMessage({ authenticated: false }), /重置时间未知/u)
})

test('gh CLI token output is accepted by the lazy fallback parser (real machine, read-only)', (t) => {
  let stdout: string
  try {
    stdout = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 8000, windowsHide: true }).trim()
  } catch {
    t.skip('gh CLI is missing or not logged in')
    return
  }
  const token = parseGitHubTokenOutput(stdout)
  assert.equal(typeof token, 'string')
  // The token itself is never asserted, printed or stored — only its shape.
  assert.equal(selectGitHubToken({}, token), stdout)
  assert.ok(stdout.length > 20)
})

test('dedupePhysicalCopies collapses Junction/symlink aliases by realpath', async (t) => {
  const dir = tempDir(t)
  const targetDir = join(dir, 'fixtures', 'junction-target-skill')
  mkdirSync(targetDir, { recursive: true })
  writeFileSync(join(targetDir, 'SKILL.md'), '---\nname: junction-demo\ndescription: junction target\n---\n\nBody\n')
  const skillsRoot = join(dir, 'agents-home', 'skills')
  mkdirSync(skillsRoot, { recursive: true })
  const aliasPath = join(skillsRoot, 'junction-demo')
  try {
    // Windows needs a Junction (no administrator privilege); POSIX uses a dir symlink.
    symlinkSync(targetDir, aliasPath, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    t.skip(`directory links are unavailable here: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const agentsRoot: SkillRootSpec = { key: 'user-agents', label: 'agents', path: skillsRoot, rank: 500, managed: true, kind: 'user-agents' }
  const targetParentRoot: SkillRootSpec = { key: 'runtime:fixtures', label: 'runtime', path: join(dir, 'fixtures'), rank: 300, managed: true, kind: 'custom', synthetic: true }
  const aliased = await discoverRoot(agentsRoot)
  const real = await discoverRoot(targetParentRoot)
  assert.equal(aliased.skills.length, 1)
  assert.equal(real.skills.length, 1)
  const aliasSkill = aliased.skills[0]
  const realSkill = real.skills[0]
  assert.ok(aliasSkill !== undefined && realSkill !== undefined)
  // Same physical manifest (realpath), different lexical paths.
  assert.equal(aliasSkill.realPath, realSkill.realPath)
  assert.notEqual(skillPathKey(aliasSkill.manifestPath), skillPathKey(realSkill.manifestPath))
  assert.equal(aliasSkill.lexicalDir, aliasPath)
  const makeOrdered = (root: SkillRootSpec, skill: typeof aliasSkill, id: string): PhysicalCopyOrdering => ({
    id,
    name: skill.name,
    rootKey: root.key,
    ...(root.rank === undefined ? {} : { rank: root.rank }),
    managed: root.managed,
    synthetic: root.synthetic === true,
    layout: skill.layout,
    realPath: skill.realPath,
    manifestPath: skill.manifestPath,
    dir: skill.dir,
  })
  const deduped = dedupePhysicalCopies([
    makeOrdered(targetParentRoot, realSkill, 'runtime:fixtures:junction-demo'),
    makeOrdered(agentsRoot, aliasSkill, 'user-agents:junction-demo'),
  ])
  assert.equal(deduped.kept.length, 1)
  assert.equal(deduped.dropped.length, 1)
  // The configured DSH root wins over the runtime-derived alias root.
  assert.equal(deduped.kept[0]?.rootKey, 'user-agents')
  assert.equal(deduped.kept[0]?.id, 'user-agents:junction-demo')
  assert.equal(deduped.dropped[0]?.copy.rootKey, 'runtime:fixtures')
  const diagnostics = describePhysicalAliases({ winner: deduped.kept[0], aliases: deduped.dropped.map(entry => entry.copy) })
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]?.code, 'skill/alias')
  assert.match(diagnostics[0]?.message ?? '', /Junction\/符号链接别名/u)
  assert.match(diagnostics[0]?.message ?? '', /别名路径/u)
  assert.match(diagnostics[0]?.message ?? '', /真实路径/u)
  assert.equal(diagnostics[0]?.detail?.realPath, aliasSkill.dir)
})

test('dedupePhysicalCopies keeps unrelated copies and falls back to literal paths', () => {
  const base: PhysicalCopyOrdering = { id: 'a', name: 'alpha', rootKey: 'r1', managed: true, realPath: '/real/a/SKILL.md', manifestPath: '/m/a/SKILL.md', dir: '/real/a' }
  const other: PhysicalCopyOrdering = { id: 'b', name: 'alpha', rootKey: 'r2', managed: true, realPath: '/real/b/SKILL.md', manifestPath: '/real/b/SKILL.md', dir: '/real/b' }
  const kept = dedupePhysicalCopies([base, other])
  assert.equal(kept.kept.length, 2)
  assert.equal(kept.dropped.length, 0)
  // fail-safe: two candidates whose realpath failed use the literal manifest
  // path, so they are treated as the same physical copy.
  const failedLink: PhysicalCopyOrdering = { id: 'c', name: 'beta', rootKey: 'r1', managed: true, realPath: '', manifestPath: '/literal/beta/SKILL.md', dir: '/literal/beta' }
  const failedTarget: PhysicalCopyOrdering = { id: 'd', name: 'beta', rootKey: 'r2', managed: true, realPath: '', manifestPath: '/literal/beta/SKILL.md', dir: '/literal/beta' }
  const fallback = dedupePhysicalCopies([failedLink, failedTarget])
  assert.equal(fallback.kept.length, 1)
  assert.equal(fallback.kept[0]?.id, 'c')
  assert.equal(fallback.dropped.length, 1)
  // Configured managed roots win over runtime-derived roots even at worse rank.
  const configured: PhysicalCopyOrdering = { id: 'e', name: 'gamma', rootKey: 'user-agents', rank: 500, managed: true, realPath: '/s/gamma/SKILL.md', manifestPath: '/s/gamma/SKILL.md', dir: '/s/gamma' }
  const synthetic: PhysicalCopyOrdering = { id: 'f', name: 'gamma', rootKey: 'runtime:skills', rank: 300, managed: true, synthetic: true, realPath: '/s/gamma/SKILL.md', manifestPath: '/s/gamma/SKILL.md', dir: '/s/gamma' }
  const priority = dedupePhysicalCopies([synthetic, configured])
  assert.equal(priority.kept.length, 1)
  assert.equal(priority.kept[0]?.id, 'e')
})

test('resolvePhysicalOverrides applies DSH root precedence', (t) => {
  const dir = tempDir(t)
  const copies = [
    identity({ id: 'project-agents:dup', name: 'dup', rootKey: 'project-agents', rank: 200, managed: true, dir: join(dir, 'project') }),
    identity({ id: 'user-agents:dup', name: 'dup', rootKey: 'user-agents', rank: 500, managed: true, dir: join(dir, 'user') }),
    identity({ id: 'external-codex:dup', name: 'dup', rootKey: 'external-codex', managed: false, dir: join(dir, 'codex') }),
    identity({ id: 'user-dsh:unique', name: 'unique', rootKey: 'user-dsh', rank: 400, managed: true, dir: join(dir, 'unique') }),
  ]
  const resolution = resolvePhysicalOverrides(copies)
  assert.equal(resolution.effective.has('project-agents:dup'), true)
  assert.equal(resolution.effective.has('user-agents:dup'), false)
  assert.equal(resolution.effective.has('external-codex:dup'), false)
  assert.equal(resolution.effective.has('user-dsh:unique'), true)
  assert.deepEqual(resolution.shadowedBy.get('user-agents:dup'), join(dir, 'project', 'SKILL.md'))
  assert.deepEqual(resolution.shadowedBy.get('external-codex:dup'), join(dir, 'project', 'SKILL.md'))
  const overridden = resolution.overriddenCopies.get('project-agents:dup') ?? []
  assert.equal(overridden.length, 1)
  assert.equal(overridden[0]?.rootKey, 'user-agents')
})

test('linkRuntimeCatalog joins list A with list B and finds virtual skills', (t) => {
  const dir = tempDir(t)
  const managed = identity({ id: 'user-dsh:alpha', name: 'alpha', rootKey: 'user-dsh', rank: 400, managed: true, dir: join(dir, 'dsh', 'alpha') })
  const unmanaged = identity({ id: 'external-codex:alpha', name: 'alpha', rootKey: 'external-codex', managed: false, dir: join(dir, 'codex', 'alpha') })
  const catalog = {
    available: true,
    complete: true,
    observations: ['Host 全局技能层', 'Agent 会话 1'],
    errors: [],
    skills: [
      { name: 'alpha', description: 'alpha', path: managed.manifestPath, invocation: { modelInvocable: true, userInvocable: true }, provider: 'filesystem' },
      { name: 'virtual-one', description: 'runtime only', invocation: { modelInvocable: true, userInvocable: true }, provider: 'runtime' },
      { name: 'outside-root', description: 'outside', path: join(dir, 'elsewhere', 'SKILL.md'), invocation: { modelInvocable: true, userInvocable: true }, provider: 'filesystem' },
    ],
  }
  const link = linkRuntimeCatalog([managed, unmanaged], catalog)
  assert.equal(link.effective.has('user-dsh:alpha'), true)
  assert.equal(link.loaded.has('user-dsh:alpha'), true)
  assert.equal(link.effective.has('external-codex:alpha'), false)
  assert.equal(link.shadowedBy.get('external-codex:alpha'), managed.manifestPath)
  assert.deepEqual(link.virtual.map(skill => skill.name).sort(), ['outside-root', 'virtual-one'])
  assert.equal(skillPathKey(managed.manifestPath), skillPathKey(managed.manifestPath.toUpperCase()))
})

test('resolveSkillRoots orders managed roots and marks external roots unmanaged', (t) => {
  const home = tempDir(t)
  const workspace = join(home, 'project')
  mkdirSync(join(workspace, '.git'), { recursive: true })
  const custom = join(home, 'custom-skills')
  mkdirSync(custom, { recursive: true })
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
  const dshHome = join(home, '.dsh')
  const agentsHome = join(home, '.agents')
  const settings = settingsFor({ dshHome, agentsHome, customSkillDirs: [custom] })
  const resolution = resolveSkillRoots({ workspacePath: workspace, dshHome, userHome: home, settings })
  const byKey = new Map(resolution.roots.map(root => [root.key, root]))
  assert.equal(resolution.projectRoot, workspace)
  assert.deepEqual([...byKey.keys()].slice(0, 4), ['project-dsh', 'project-agents', 'custom:custom-skills', 'user-dsh'])
  assert.equal(byKey.get('project-dsh')?.rank, 100)
  assert.equal(byKey.get('user-agents')?.rank, 500)
  assert.equal(byKey.get('external-codex')?.managed, false)
  assert.equal(byKey.get('external-claude')?.managed, false)
  assert.equal(byKey.has('external-cursor'), false)
  // Two identities pointing at the same directory are merged, keeping the
  // higher-priority identity (the workspace itself is the user home here).
  const deduped = resolveSkillRoots({ workspacePath: home, dshHome, userHome: home, settings: settingsFor({ dshHome, agentsHome }) })
  assert.equal(deduped.roots.some(root => root.key === 'project-dsh'), true)
  assert.equal(deduped.roots.some(root => root.key === 'user-dsh'), false)
  assert.equal(deduped.diagnostics.some(item => item.code === 'skill-root/duplicate'), true)
})

test('findProjectRootSync walks up to the nearest .git ancestor', (t) => {
  const root = tempDir(t)
  mkdirSync(join(root, '.git'))
  const nested = join(root, 'a', 'b')
  mkdirSync(nested, { recursive: true })
  assert.equal(findProjectRootSync(nested), root)
  const orphanParent = tempDir(t)
  const orphan = join(orphanParent, 'no-git', 'deep')
  mkdirSync(orphan, { recursive: true })
  assert.equal(findProjectRootSync(orphan), orphan)
})

test('git provenance helpers read a real repository', async (t) => {
  const dir = tempDir(t)
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
  } catch {
    t.skip('git is not installed')
    return
  }
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'skills', 'alpha', 'references'), { recursive: true })
  writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), FIXTURE_SKILL_MD)
  writeFileSync(join(repo, 'skills', 'alpha', 'references', 'notes.md'), FIXTURE_NOTES_MD)
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo })
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo })
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example/skills.git'], { cwd: repo })
  execFileSync('git', ['add', '-A'], { cwd: repo })
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repo })
  const info = readGitRepository(join(repo, 'skills', 'alpha'))
  assert.equal(info?.root, repo)
  assert.equal(info?.remoteUrl, 'https://github.com/example/skills.git')
  assert.equal(info?.branch, 'main')
  const headTree = await readGitHeadTree(repo, 'skills/alpha')
  assert.equal(headTree.sha, FIXTURE_TREE_SHA)
  const clean = await readGitWorktreeStatus(repo, join(repo, 'skills', 'alpha'))
  assert.equal(clean.state, 'clean')
  writeFileSync(join(repo, 'skills', 'alpha', 'SKILL.md'), `${FIXTURE_SKILL_MD}\nextra\n`)
  const dirty = await readGitWorktreeStatus(repo, join(repo, 'skills', 'alpha'))
  assert.equal(dirty.state, 'modified')
})

test('real machine: tavily-* lock folder hashes match computed git trees', async (t) => {
  const agentsHome = process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  const lockRead = await readSkillLockFile(agentsHome)
  if (lockRead.lock === undefined) {
    t.skip(`no skills lock file at ${lockRead.path}`)
    return
  }
  const entries = Object.entries(lockRead.lock.skills)
  const tavily = entries.filter(([name]) => name.startsWith('tavily-'))
  assert.equal(tavily.length, 8, 'the machine\'s skills lock file should contain the eight tavily skills')
  for (const [name, entry] of tavily) {
    assert.equal(typeof entry.skillFolderHash, 'string', `${name} must record a skillFolderHash`)
    assert.equal(lockEntrySubdir(entry), `skills/${name}`)
    const dir = join(agentsHome, 'skills', name)
    const computed = await computeSkillFolderTreeSha(dir)
    assert.equal(computed.error, undefined, `${name}: ${computed.error ?? ''}`)
    assert.equal(computed.sha, entry.skillFolderHash, `${name} installed directory must match the lock folder hash`)
    assert.equal(sameTreeSha(computed.sha, entry.skillFolderHash), true)
  }
})

test('real machine: Codex skills are installed but unmanaged by DSH', async (t) => {
  const home = homedir()
  const codexRoot = join(home, '.codex', 'skills')
  if (!existsSync(codexRoot)) {
    t.skip(`no Codex skills root at ${codexRoot}`)
    return
  }
  const dshHome = join(home, '.dsh')
  const agentsHome = join(home, '.agents')
  const settings = settingsFor({ dshHome, agentsHome })
  const resolution = resolveSkillRoots({ workspacePath: home, dshHome, userHome: home, settings })
  const external = resolution.roots.find(root => root.key === 'external-codex')
  assert.equal(external?.managed, false)
  const discovery = await discoverRoot(external ?? { key: 'external-codex', label: 'Codex', path: codexRoot, managed: false, kind: 'external' })
  const knowledge = discovery.skills.find(skill => skill.name === 'knowledge-maintainer')
  assert.ok(knowledge !== undefined, 'Codex skills root should contain knowledge-maintainer')
  assert.equal(knowledge?.layout, 'directory')
  // The same skill is installed for DSH under <DSH_HOME>/skills; DSH loads the
  // managed copy and the Codex copy stays non-effective.
  const dshRoot = join(dshHome, 'skills')
  if (existsSync(join(dshRoot, 'knowledge-maintainer', 'SKILL.md'))) {
    const managed = identity({ id: 'user-dsh:knowledge-maintainer', name: 'knowledge-maintainer', rootKey: 'user-dsh', rank: 400, managed: true, dir: join(dshRoot, 'knowledge-maintainer') })
    const unmanaged = identity({ id: 'external-codex:knowledge-maintainer', name: 'knowledge-maintainer', rootKey: 'external-codex', managed: false, dir: join(codexRoot, 'knowledge-maintainer') })
    const overrides = resolvePhysicalOverrides([managed, unmanaged])
    assert.equal(overrides.effective.has('user-dsh:knowledge-maintainer'), true)
    assert.equal(overrides.shadowedBy.has('external-codex:knowledge-maintainer'), true)
    const link = linkRuntimeCatalog([managed, unmanaged], {
      available: true,
      complete: true,
      observations: ['Host 全局技能层'],
      errors: [],
      skills: [{ name: 'knowledge-maintainer', description: 'x', path: managed.manifestPath, invocation: { modelInvocable: true, userInvocable: true }, provider: 'filesystem' }],
    })
    assert.equal(link.loaded.has('user-dsh:knowledge-maintainer'), true)
    assert.equal(link.loaded.has('external-codex:knowledge-maintainer'), false)
    assert.equal(link.shadowedBy.get('external-codex:knowledge-maintainer'), managed.manifestPath)
  }
})
