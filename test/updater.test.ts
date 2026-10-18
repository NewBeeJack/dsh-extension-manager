/**
 * Tests for the safe update engine: transaction state machine, verified
 * backups and restore, npm tarball / GitHub archive parsing, git tree hashing,
 * Windows-style filesystem retries, plan decisions, and end-to-end plugin and
 * skill updates against isolated temporary directories.
 *
 * Run with: node --test test/updater.test.ts
 *
 * Node's native TypeScript runner requires explicit file extensions for
 * relative imports, while the source tree uses the bundler-style extensionless
 * / `.js` specifiers TypeScript checks. A tiny resolve hook maps the source
 * tree's specifiers onto the `.ts` files without changing the sources.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { after, describe, test } from 'node:test'
import { gzipSync } from 'node:zlib'

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (error) {
    if (!specifier.startsWith('.') && !specifier.startsWith('/')) throw error
    const candidates = []
    if (specifier.endsWith('.js')) candidates.push(specifier.slice(0, -3) + '.ts')
    else if (!/\\.[a-z0-9]+$/i.test(specifier)) candidates.push(specifier + '.ts', specifier + '/index.ts')
    for (const candidate of candidates) {
      try { return await next(candidate, context) } catch {}
    }
    throw error
  }
}
`))

const tarball = await import('../src/host/updates/tarball.ts')
const backup = await import('../src/host/updates/backup.ts')
const executorModule = await import('../src/host/updates/executor.ts')
const stateModule = await import('../src/host/state.ts')
const logsModule = await import('../src/host/logs.ts')
const tasksModule = await import('../src/host/tasks.ts')

const { UpdateExecutor, UpdateTransaction, planPluginEntry, planSkillEntry, verifyTarballIntegrity, withInstallLock, buildGitTargetSpec } = executorModule
const { BackupManager, hashTree, compareTreeManifests, retryFs, removeTree, writeFileAtomicSafe } = backup
const { readTarArchive, readNpmTarball, extractArchive, compareExtractedFiles, gitTreeHashForEntries, entriesUnder, archiveRoot } = tarball

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Every temporary directory this run created; removed in one `after` hook. */
const temporaryRoots: string[] = []

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `dsh-em-${label}-`))
  temporaryRoots.push(dir)
  return dir
}

after(() => {
  for (const dir of temporaryRoots) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked file on Windows must never fail the suite.
    }
  }
})

function octal(value: number, width: number): string {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

interface TarFixtureEntry {
  path: string
  content?: string | Buffer
  mode?: number
  type?: 'file' | 'dir' | 'symlink'
  linkTarget?: string
}

/** Build a ustar archive (no compression) with controlled modes. */
function buildTar(entries: readonly TarFixtureEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const data = entry.type === 'symlink' || entry.type === 'dir'
      ? Buffer.alloc(0)
      : Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? '', 'utf8')
    const type = entry.type ?? 'file'
    const typeflag = type === 'dir' ? '5' : type === 'symlink' ? '2' : '0'
    const name = type === 'dir' && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path
    const header = Buffer.alloc(512)
    if (Buffer.byteLength(name) > 100) throw new Error(`fixture path too long for this writer: ${name}`)
    header.write(name, 0, 100, 'utf8')
    header.write(octal(entry.mode ?? (type === 'dir' ? 0o755 : 0o644), 8), 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(octal(data.byteLength, 12), 124, 12, 'ascii')
    header.write(octal(0, 12), 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write(typeflag, 156, 1, 'ascii')
    if (entry.linkTarget !== undefined) header.write(entry.linkTarget, 157, 100, 'utf8')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    blocks.push(header)
    if (data.byteLength > 0) {
      blocks.push(data)
      const remainder = data.byteLength % 512
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder))
    }
  }
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

interface NpmPackageFixtureOptions {
  dshBundle?: boolean
  files?: Record<string, string>
}

/** Build a minimal npm packument tarball for one package version. */
function makeNpmTarball(name: string, version: string, options: NpmPackageFixtureOptions = {}): Buffer {
  const manifest: Record<string, unknown> = { name, version }
  if (options.dshBundle !== false) manifest.dsh = { bundle: { patch: './cordis.patch.yml' } }
  const files: TarFixtureEntry[] = [
    { path: 'package/package.json', content: `${JSON.stringify(manifest, undefined, 2)}\n` },
    { path: 'package/cordis.patch.yml', content: '- insert: []\n' },
    { path: 'package/index.js', content: 'export const version = "1"\n' },
  ]
  for (const [path, content] of Object.entries(options.files ?? {})) {
    files.push({ path: `package/${path}`, content })
  }
  return buildTar(files)
}

/** sha256 of one buffer, used to build npm `dist.integrity` values. */
function sha512Base64(data: Buffer): string {
  return `sha512-${createHash('sha512').update(data).digest('base64')}`
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Write a minimal pnpm v9 lockfile recording one git-installed dependency. */
function writeLockfileGit(profileDir: string, name: string, commit: string): void {
  const spec = `https://github.com/demo/repo.git#${commit}`
  const text = [
    "lockfileVersion: '9.0'",
    '',
    'importers:',
    '',
    '  .:',
    '    dependencies:',
    `      ${name}:`,
    `        specifier: ${spec}`,
    `        version: ${spec}`,
    '',
  ].join('\n')
  writeFileSync(join(profileDir, 'pnpm-lock.yaml'), text)
}

/** Extract a package tarball into an install directory (fixture "installed" state). */
async function installTarball(tarballBytes: Buffer, installDir: string): Promise<void> {
  const parsed = readNpmTarball(tarballBytes)
  rmSync(installDir, { recursive: true, force: true })
  await extractArchive(parsed.entries, installDir, { prefix: 'package/' })
}

/** Build one valid GitHub codeload-style archive around a skill subtree. */
function makeSkillArchive(repo: string, commit: string, subdir: string, files: readonly TarFixtureEntry[]): Buffer {
  const root = `${repo.split('/')[1] ?? repo}-${commit}`
  const prefix = subdir === '' ? root : `${root}/${subdir}`
  const entries: TarFixtureEntry[] = []
  for (const file of files) entries.push({ ...file, path: `${prefix}/${file.path}` })
  return buildTar(entries)
}

/** Known-answer git tree fixture, precomputed with real `git mktree`. */
const SKILL_TREE_FIXTURE = {
  commit: 'abcdef1234567890abcdef1234567890abcdef12',
  repo: 'demo/repo',
  subdir: 'skills/demo',
  tree: '23c1eff455f78209abc11f520110c093ab27164b',
  /** The same tree when scripts/run.js is not executable (all modes 100644). */
  treeWithoutExec: '2da45bfbed17806d4b1835a44e2d835a26e166e9',
  files: [
    { path: 'SKILL.md', content: '---\nname: demo-skill\n---\nhello\n', mode: 0o644 },
    { path: 'scripts/run.js', content: 'console.log("hi")\n', mode: 0o755 },
    { path: 'references/notes.md', content: 'notes\n', mode: 0o644 },
  ],
} as const

// ---------------------------------------------------------------------------
// tar / gzip parsing, extraction, git tree hashing
// ---------------------------------------------------------------------------

describe('tarball parsing and extraction', () => {
  test('reads npm tarball files, hashes and package identity', () => {
    const bytes = makeNpmTarball('demo-plugin', '1.2.3', { files: { 'lib/a.js': 'export const a = 2\n' } })
    const parsed = readNpmTarball(bytes)
    assert.equal(parsed.name, 'demo-plugin')
    assert.equal(parsed.version, '1.2.3')
    assert.deepEqual(parsed.files.map(file => file.path), ['cordis.patch.yml', 'index.js', 'lib/a.js', 'package.json'])
    assert.equal(parsed.byPath.get('index.js')?.sha256, createHash('sha256').update('export const version = "1"\n').digest('hex'))
  })

  test('parses gzip-compressed archives and extracts exactly the listed content', async () => {
    const plain = makeNpmTarball('demo-plugin', '1.2.3', { files: { 'lib/a.js': 'export const a = 2\n' } })
    const parsed = readNpmTarball(gzipSync(plain))
    const out = join(tempDir('extract'), 'package')
    const extracted = await extractArchive(parsed.entries, out, { prefix: 'package/' })
    assert.equal(extracted.files.length, parsed.files.length)
    assert.equal(compareExtractedFiles(extracted.files, parsed.files).ok, true)
    assert.equal(readFileSync(join(out, 'lib', 'a.js'), 'utf8'), 'export const a = 2\n')
  })

  test('rejects path traversal during extraction', async () => {
    const bytes = buildTar([
      { path: 'package/../../evil.txt', content: 'escape\n' },
    ])
    const parsed = readNpmTarball(bytes)
    await assert.rejects(
      () => extractArchive(parsed.entries, join(tempDir('traversal'), 'package'), { prefix: 'package/' }),
      /越界|拒绝/u,
    )
  })

  test('rejects corrupted headers (checksum mismatch)', () => {
    const bytes = makeNpmTarball('demo-plugin', '1.0.0')
    bytes[3] = (bytes[3] ?? 0) ^ 0xff
    assert.throws(() => readTarArchive(bytes), /校验失败/u)
  })

  test('computes the git tree hash GitHub reports for the same subtree', () => {
    const archive = makeSkillArchive(SKILL_TREE_FIXTURE.repo, SKILL_TREE_FIXTURE.commit, SKILL_TREE_FIXTURE.subdir,
      SKILL_TREE_FIXTURE.files.map(file => ({ path: file.path, content: file.content, mode: file.mode })))
    const entries = readTarArchive(archive)
    const root = archiveRoot(entries)
    assert.equal(root, `repo-${SKILL_TREE_FIXTURE.commit}`)
    const prefix = `${root}/${SKILL_TREE_FIXTURE.subdir}`
    assert.equal(gitTreeHashForEntries(entries, prefix), SKILL_TREE_FIXTURE.tree)
    // The same content with a non-executable script hashes to the 100644 tree.
    const nonexec = readTarArchive(makeSkillArchive(SKILL_TREE_FIXTURE.repo, SKILL_TREE_FIXTURE.commit, SKILL_TREE_FIXTURE.subdir,
      SKILL_TREE_FIXTURE.files.map(file => ({ path: file.path, content: file.content, mode: file.path.endsWith('.js') ? 0o644 : file.mode }))))
    const nonexecRoot = archiveRoot(nonexec)
    assert.equal(nonexecRoot, `repo-${SKILL_TREE_FIXTURE.commit}`)
    assert.equal(gitTreeHashForEntries(nonexec, `${nonexecRoot}/${SKILL_TREE_FIXTURE.subdir}`), SKILL_TREE_FIXTURE.treeWithoutExec)
    // The file list below the prefix is complete and prefix-relative.
    assert.deepEqual(entriesUnder(entries, prefix).map(entry => entry.relativePath).sort(),
      ['SKILL.md', 'references/notes.md', 'scripts/run.js'])
  })

  test('verifies a published dist.integrity value', () => {
    const bytes = makeNpmTarball('demo-plugin', '1.0.0')
    assert.equal(verifyTarballIntegrity(bytes, { dist: { integrity: sha512Base64(bytes) } }), undefined)
    assert.match(verifyTarballIntegrity(Buffer.from('different'), { dist: { integrity: sha512Base64(bytes) } }) ?? '', /校验失败/u)
  })
})

// ---------------------------------------------------------------------------
// Backup, verification, restore and Windows semantics
// ---------------------------------------------------------------------------

describe('backup and restore', () => {
  test('backs up, verifies, restores an install tree and profile manifest files', async () => {
    const root = tempDir('backup')
    const installDir = join(root, 'live-package')
    const profileDir = join(root, 'profile')
    mkdirSync(join(installDir, 'lib'), { recursive: true })
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(installDir, 'package.json'), '{"name":"demo-plugin","version":"1.0.0"}\n')
    writeFileSync(join(installDir, 'lib', 'a.js'), 'old\n')
    writeFileSync(join(profileDir, 'package.json'), '{"dependencies":{"demo-plugin":"^1.0.0"}}\n')
    writeFileSync(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')

    const manager = new BackupManager({ backupRoot: join(root, 'backups') })
    const snapshot = await manager.backupPlugin({ transactionId: 'tx-backup', installDir, profileDir })
    assert.equal((await manager.verify(snapshot)).ok, true)
    assert.ok(snapshot.fileCount >= 2)

    // A backup that no longer matches its manifest must be detected.
    writeFileSync(join(snapshot.rootDir, 'lib', 'a.js'), 'tampered\n')
    const tampered = await manager.verify(snapshot)
    assert.equal(tampered.ok, false)
    assert.match(tampered.problems.join('；'), /不一致/u)
    writeFileSync(join(snapshot.rootDir, 'lib', 'a.js'), 'old\n')

    // Simulate a destructive replacement, then restore.
    rmSync(join(installDir, 'lib'), { recursive: true, force: true })
    writeFileSync(join(installDir, 'package.json'), '{"name":"demo-plugin","version":"2.0.0"}\n')
    writeFileSync(join(profileDir, 'package.json'), '{"dependencies":{"demo-plugin":"2.0.0"}}\n')
    const report = await manager.restorePlugin(snapshot, installDir)
    assert.equal(report.ok, true, report.problems.join('；'))
    assert.equal(report.verifiedVersion, '1.0.0')
    assert.equal(readFileSync(join(installDir, 'lib', 'a.js'), 'utf8'), 'old\n')
    assert.equal((readJson(join(profileDir, 'package.json')).dependencies as Record<string, string>)['demo-plugin'], '^1.0.0')
    // Restoring does not modify the backup itself.
    assert.equal((await manager.verify(snapshot)).ok, true)
  })

  test('reopens a backup from disk for crash recovery', async () => {
    const root = tempDir('backup-load')
    const installDir = join(root, 'live-package')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(join(installDir, 'package.json'), '{"version":"0.9.0"}\n')
    const manager = new BackupManager({ backupRoot: join(root, 'backups') })
    const created = await manager.backupPlugin({ transactionId: 'tx-load', installDir, profileDir: root })
    const loaded = await manager.loadBackup('tx-load')
    assert.ok(loaded !== undefined)
    assert.equal(loaded.manifest.transactionId, 'tx-load')
    assert.equal(loaded.rootDir, created.rootDir)
    assert.equal(await manager.loadBackup('missing'), undefined)
  })

  test('restores a skill backup and detects a changed tree', async () => {
    const root = tempDir('backup-skill')
    const skillDir = join(root, 'skills', 'demo')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nold\n')
    const manager = new BackupManager({ backupRoot: join(root, 'backups') })
    const snapshot = await manager.backupSkill({ transactionId: 'tx-skill', skillDir })
    rmSync(join(skillDir, 'SKILL.md'))
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo\n---\nnew\n')
    const report = await manager.restoreSkill(snapshot, skillDir)
    assert.equal(report.ok, true, report.problems.join('；'))
    assert.equal(readFileSync(join(skillDir, 'SKILL.md'), 'utf8'), '---\nname: demo\n---\nold\n')
  })

  test('retries EBUSY failures and fails fast on non-retryable errors', async () => {
    let attempts = 0
    const value = await retryFs('test', async () => {
      attempts += 1
      if (attempts < 3) {
        const error = new Error('locked')
        error.code = 'EBUSY'
        throw error
      }
      return 'ok'
    }, { baseDelayMs: 1 })
    assert.equal(value, 'ok')
    assert.equal(attempts, 3)

    let fastAttempts = 0
    await assert.rejects(async () => {
      await retryFs('test', async () => {
        fastAttempts += 1
        const error = new Error('missing')
        error.code = 'ENOENT'
        throw error
      }, { baseDelayMs: 1 })
    })
    assert.equal(fastAttempts, 1)
  })

  test('removes a read-only file on Windows by clearing the attribute first', async () => {
    const root = tempDir('readonly')
    const path = join(root, 'locked.txt')
    writeFileSync(path, 'x')
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o444)
    await removeTree(path)
    assert.equal(existsSync(path), false)
  })

  test('writes atomically over an existing file', async () => {
    const root = tempDir('atomic')
    const path = join(root, 'package.json')
    writeFileSync(path, '{"old":true}\n')
    await writeFileAtomicSafe(path, '{"new":true}\n')
    assert.equal(readFileSync(path, 'utf8'), '{"new":true}\n')
  })

  test('hashTree and compareTreeManifests report added, modified and missing files', async () => {
    const root = tempDir('hash')
    mkdirSync(join(root, 'lib'), { recursive: true })
    writeFileSync(join(root, 'package.json'), 'a\n')
    writeFileSync(join(root, 'lib', 'a.js'), 'a\n')
    const first = await hashTree(root)
    writeFileSync(join(root, 'lib', 'a.js'), 'b\n')
    writeFileSync(join(root, 'extra.js'), 'x\n')
    rmSync(join(root, 'package.json'))
    const second = await hashTree(root)
    const comparison = compareTreeManifests(first, second)
    assert.equal(comparison.clean, false)
    assert.deepEqual(comparison.modified, ['lib/a.js'])
    assert.deepEqual(comparison.added, ['extra.js'])
    assert.deepEqual(comparison.missing, ['package.json'])
  })
})

// ---------------------------------------------------------------------------
// Transaction state machine
// ---------------------------------------------------------------------------

describe('transaction state machine', () => {
  function recordingSink(): { records: unknown[]; sink: { putTransaction(record: unknown): Promise<void> } } {
    const records: unknown[] = []
    return {
      records,
      sink: {
        async putTransaction(record: unknown): Promise<void> {
          records.push(JSON.parse(JSON.stringify(record)) as unknown)
        },
      },
    }
  }

  test('persists every phase transition and enforces the allowed flow', async () => {
    const { records, sink } = recordingSink()
    const transaction = new UpdateTransaction(sink, {
      kind: 'plugin-bundle',
      extensionId: 'plugin-bundle:web:demo',
      name: 'demo',
      targetVersion: '2.0.0',
      previousVersion: '1.0.0',
    })
    await transaction.save()
    await transaction.setPhase('BACKUP', 'backup')
    await transaction.setPhase('DOWNLOAD', 'download')
    await transaction.setPhase('STAGE', 'stage')
    await transaction.setPhase('INSTALL', 'install')
    await transaction.setPhase('VALIDATE', 'validate')
    await transaction.setPhase('VERIFIED', 'verified')
    assert.equal(transaction.record.phase, 'VERIFIED')
    const phases = records.map(record => (record as { phase: string }).phase)
    assert.deepEqual(phases, ['PREFLIGHT', 'BACKUP', 'DOWNLOAD', 'STAGE', 'INSTALL', 'VALIDATE', 'VERIFIED'])
    const last = records.at(-1) as { steps: Array<{ phase: string }> }
    assert.ok(last.steps.length >= 7)
    await assert.rejects(() => transaction.setPhase('BACKUP', 'illegal'), /非法的更新事务状态迁移/u)
  })

  test('supports the FAILED → RECOVERY → RECOVERED rollback path', async () => {
    const { sink } = recordingSink()
    const transaction = new UpdateTransaction(sink, {
      kind: 'skill',
      extensionId: 'skill:fs:demo',
      name: 'demo',
    })
    await transaction.setPhase('BACKUP', 'backup')
    await transaction.fail('installing failed')
    assert.equal(transaction.record.phase, 'FAILED')
    assert.equal(transaction.record.error, 'installing failed')
    await transaction.setPhase('RECOVERY', 'restore from backup')
    await transaction.setPhase('RECOVERED', 'rolled back')
    await transaction.patch({ rolledBack: true })
    assert.equal(transaction.record.phase, 'RECOVERED')
    assert.equal(transaction.record.rolledBack, true)
  })

  test('rejects skipping straight from PREFLIGHT to VERIFIED', async () => {
    const { sink } = recordingSink()
    const transaction = new UpdateTransaction(sink, { kind: 'skill', extensionId: 'skill:fs:demo', name: 'demo' })
    await assert.rejects(() => transaction.setPhase('VERIFIED', 'too fast'), /非法的更新事务状态迁移/u)
  })
})

// ---------------------------------------------------------------------------
// Plan decisions (pure)
// ---------------------------------------------------------------------------

function pluginRecordFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'plugin-bundle:web:demo-plugin',
    kind: 'plugin-bundle',
    name: 'demo-plugin',
    displayName: 'Demo Plugin',
    description: '',
    version: { current: '1.0.0', status: 'unchecked' },
    source: { kind: 'npm', trust: 'verified', label: 'npm Registry', packageName: 'demo-plugin', spec: 'demo-plugin@^1.0.0' },
    runtime: { installed: true, enabled: true, loaded: true },
    scope: 'current-profile',
    profile: 'web',
    official: false,
    availability: 'profile',
    removable: true,
    paths: { installDir: 'C:/tmp/plugin' },
    rows: [],
    overrides: [],
    localModification: { state: 'unknown' },
    diagnostics: [],
    actions: { canCheck: true, canUpdate: true },
    ...overrides,
  }
}

function cacheFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recordId: 'plugin:plugin-bundle:web:demo-plugin',
    status: 'update-available',
    currentVersion: '1.0.0',
    availableVersion: '2.0.0',
    compatibility: 'compatible',
    channel: 'stable',
    checkedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('plan decisions', () => {
  const context = { hmrEnabled: true, requested: false }

  test('an eligible npm update is planned as safe', () => {
    const entry = planPluginEntry(pluginRecordFixture(), cacheFixture(), context)
    assert.ok(entry !== undefined)
    assert.equal(entry.eligible, true)
    assert.equal(entry.requiresConfirmation, false)
    assert.equal(entry.targetVersion, '2.0.0')
    assert.equal(entry.needsRestart, false)
  })

  test('the manager itself is always excluded', () => {
    const entry = planPluginEntry(pluginRecordFixture({ self: true }), cacheFixture(), context)
    assert.equal(entry?.eligible, false)
    assert.match(entry?.excludedReason ?? '', /管理器自身/u)
  })

  test('git sources are planned as confirmation-only git installs', () => {
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const gitSource = {
      kind: 'git', trust: 'verified', label: 'Git 安装 · github.com',
      spec: `github:demo/repo#${commit}`, url: 'https://github.com/demo/repo', repo: 'demo/repo', ref: 'main',
    }
    const entry = planPluginEntry(
      pluginRecordFixture({ source: gitSource }),
      cacheFixture({ availableVersion: undefined, availableCommit: commit }),
      context,
    )
    assert.equal(entry?.eligible, false)
    assert.equal(entry?.requiresConfirmation, true)
    assert.equal(entry?.targetVersion, commit.slice(0, 12))
    assert.match(entry?.risk ?? '', /Git 安装/u)
  })

  test('local sources stay excluded from automatic updates', () => {
    const linkSource = { kind: 'local-link', trust: 'local-custom', label: '本地链接安装', spec: 'link:../demo' }
    const entry = planPluginEntry(pluginRecordFixture({ source: linkSource }), cacheFixture(), context)
    assert.equal(entry?.eligible, false)
    assert.match(entry?.excludedReason ?? '', /自动更新/u)
  })

  test('builds git install specs with the target commit', () => {
    const commit = 'abcdef1234567890abcdef1234567890abcdef12'
    const record = pluginRecordFixture({
      source: {
        kind: 'git', trust: 'verified', label: 'Git 安装',
        spec: 'https://github.com/demo/repo.git#main', url: 'https://github.com/demo/repo', repo: 'demo/repo', ref: 'main',
      },
    })
    assert.equal(buildGitTargetSpec(record, commit), `https://github.com/demo/repo.git#${commit}`)
    assert.equal(buildGitTargetSpec(pluginRecordFixture({
      source: { kind: 'git', trust: 'verified', label: 'Git', spec: 'not a git spec' },
    }), commit), undefined)
  })

  test('an incompatible target is excluded with its requirements', () => {
    const entry = planPluginEntry(pluginRecordFixture(), cacheFixture({
      status: 'incompatible-update',
      compatibility: 'incompatible',
      compatibilityRequirements: { 'engines.dsh': '^0.1.0' },
    }), context)
    assert.equal(entry?.eligible, false)
    assert.match(entry?.excludedReason ?? '', /不兼容/u)
  })

  test('a local modification requires confirmation but stays plannable', () => {
    const entry = planPluginEntry(pluginRecordFixture(), cacheFixture({ status: 'local-modified' }), context)
    assert.equal(entry?.requiresConfirmation, true)
    assert.equal(entry?.eligible, false)
    assert.match(entry?.risk ?? '', /本地修改/u)
  })

  test('unchecked records are only reported when explicitly requested', () => {
    const cache = cacheFixture({ status: 'unchecked' })
    assert.equal(planPluginEntry(pluginRecordFixture(), cache, context), undefined)
    const requested = planPluginEntry(pluginRecordFixture(), cache, { ...context, requested: true })
    assert.equal(requested?.excludedReason, '尚未检查更新，请先检查')
  })

  test('a flat-file skill cannot be updated automatically', () => {
    const record = {
      id: 'skill:fs:demo',
      kind: 'skill',
      name: 'demo',
      displayName: 'Demo',
      description: '',
      version: { current: 'old', status: 'unchecked' },
      source: { kind: 'skill-git', trust: 'verified', label: 'GitHub · demo/repo' },
      runtime: { installed: true },
      scope: 'filesystem',
      rootKey: 'user-dsh',
      layout: 'flat-file',
      paths: {},
      effective: true,
      localModification: { state: 'clean' },
      diagnostics: [],
      actions: { canCheck: true, canUpdate: true },
    }
    const entry = planSkillEntry(record, cacheFixture({
      recordId: 'skill:skill:fs:demo',
      status: 'update-available',
      availableCommit: SKILL_TREE_FIXTURE.commit,
      availableTree: SKILL_TREE_FIXTURE.tree,
    }), context)
    assert.equal(entry?.eligible, false)
    assert.match(entry?.excludedReason ?? '', /平铺单文件/u)
  })

  test('a modified skill directory requires confirmation', () => {
    const record = {
      id: 'skill:fs:demo',
      kind: 'skill',
      name: 'demo',
      displayName: 'Demo',
      description: '',
      version: { current: 'old', status: 'unchecked' },
      source: { kind: 'skill-git', trust: 'verified', label: 'GitHub · demo/repo' },
      runtime: { installed: true },
      scope: 'filesystem',
      rootKey: 'user-dsh',
      layout: 'directory',
      paths: {},
      effective: true,
      localModification: { state: 'modified', files: ['SKILL.md'] },
      diagnostics: [],
      actions: { canCheck: true, canUpdate: true },
    }
    const entry = planSkillEntry(record, cacheFixture({
      recordId: 'skill:skill:fs:demo',
      status: 'update-available',
      availableCommit: SKILL_TREE_FIXTURE.commit,
      availableTree: SKILL_TREE_FIXTURE.tree,
    }), context)
    assert.equal(entry?.requiresConfirmation, true)
    assert.equal(entry?.eligible, false)
  })
})

// ---------------------------------------------------------------------------
// End-to-end harness: fake HostServices around a temporary profile
// ---------------------------------------------------------------------------

interface FakePluginEntry {
  version: string
  enabled: boolean
}

interface FakePluginManagerState {
  profileDir: string
  installDir: string
  entries: Map<string, FakePluginEntry>
  tarballs: Map<string, Buffer>
  gitTarballs: Map<string, Buffer>
  failInstall: string | undefined
  failRemove: string | undefined
  /** Removal succeeded through pluginManager's own pnpm path. */
  removeApplication: 'applied' | 'restart-required' | 'failed'
  installApplication: 'applied' | 'restart-required'
}

function createFakePluginManager(state: FakePluginManagerState): Record<string, unknown> {
  const writeProfileManifest = (mutate: (manifest: Record<string, unknown>, deps: Record<string, string>) => void): void => {
    const path = join(state.profileDir, 'package.json')
    const manifest = existsSync(path) ? readJson(path) : { dependencies: {}, dsh: { profile: { bundles: [] } } }
    const dependencies = { ...(manifest.dependencies as Record<string, string> | undefined) }
    mutate(manifest, dependencies)
    writeJson(path, { ...manifest, dependencies })
  }
  return {
    async registries() {
      return { registry: 'https://registry.npmjs.org/', fallbackRegistries: [], resolved: 'https://registry.npmjs.org/' }
    },
    async listBundles() {
      const bundles: Array<Record<string, unknown>> = []
      for (const [name, entry] of state.entries) {
        bundles.push({
          name,
          official: false,
          availability: 'profile',
          version: entry.version,
          enabled: entry.enabled,
          installed: true,
          optional: false,
          removable: true,
          rows: [],
          overrides: [],
        })
      }
      return bundles
    },
    async listPlugins() {
      return []
    },
    async removeBundle(name: string) {
      if (state.failRemove !== undefined) {
        return { changed: false, application: 'failed', stage: 'remove', target: name, error: { code: 'operation-error', diagnostic: state.failRemove } }
      }
      rmSync(state.installDir, { recursive: true, force: true })
      state.entries.delete(name)
      writeProfileManifest((manifest) => {
        const dsh = manifest.dsh as { profile?: { bundles?: string[] } } | undefined
        const bundles = dsh?.profile?.bundles ?? []
        manifest.dsh = { ...(dsh ?? {}), profile: { ...(dsh?.profile ?? {}), bundles: bundles.filter(item => item !== name) } }
      })
      return { changed: true, application: state.removeApplication, stage: 'remove', target: name }
    },
    async installBundle(spec: string, options?: { enabled?: boolean; saveExact?: boolean }) {
      if (state.failInstall !== undefined) {
        return {
          changed: false,
          application: 'failed',
          stage: 'install',
          target: spec,
          error: { code: 'operation-error', diagnostic: state.failInstall },
          packageResult: { exitCode: 1, output: state.failInstall, truncated: false, logPath: '' },
        }
      }
      const hashAt = spec.lastIndexOf('#')
      const gitCommit = hashAt === -1 ? undefined : spec.slice(hashAt + 1).trim()
      if (gitCommit !== undefined && /^[0-9a-f]{7,40}$/iu.test(gitCommit)) {
        const gitBytes = state.gitTarballs.get(gitCommit)
        if (gitBytes === undefined) throw new Error(`fixture has no git tarball for ${spec}`)
        await installTarball(gitBytes, state.installDir)
        const enabled = options?.enabled !== false
        const installedVersion = readJson(join(state.installDir, 'package.json')).version as string
        state.entries.set('demo-plugin', { version: installedVersion, enabled })
        writeProfileManifest((manifest, dependencies) => {
          dependencies['demo-plugin'] = spec
          const dsh = manifest.dsh as { profile?: { bundles?: string[] } } | undefined
          const bundles = dsh?.profile?.bundles ?? []
          manifest.dsh = {
            ...(dsh ?? {}),
            profile: { ...(dsh?.profile ?? {}), bundles: enabled ? [...new Set([...bundles, 'demo-plugin'])] : bundles.filter(item => item !== 'demo-plugin') },
          }
        })
        writeLockfileGit(state.profileDir, 'demo-plugin', gitCommit)
        return { changed: true, application: state.installApplication, stage: 'install', target: spec, version: installedVersion, bundle: 'demo-plugin', enabled }
      }
      const at = spec.lastIndexOf('@')
      const name = at > 0 ? spec.slice(0, at) : spec
      const version = at > 0 ? spec.slice(at + 1) : ''
      const bytes = state.tarballs.get(version)
      if (bytes === undefined) throw new Error(`fixture has no tarball for ${spec}`)
      await installTarball(bytes, state.installDir)
      const enabled = options?.enabled !== false
      state.entries.set(name, { version, enabled })
      writeProfileManifest((manifest, dependencies) => {
        dependencies[name] = version
        const dsh = manifest.dsh as { profile?: { bundles?: string[] } } | undefined
        const bundles = dsh?.profile?.bundles ?? []
        manifest.dsh = {
          ...(dsh ?? {}),
          profile: { ...(dsh?.profile ?? {}), bundles: enabled ? [...new Set([...bundles, name])] : bundles.filter(item => item !== name) },
        }
      })
      return { changed: true, application: state.installApplication, stage: 'install', target: spec, version, bundle: name, enabled }
    },
  }
}

interface Harness {
  root: string
  home: string
  profileDir: string
  installDir: string
  recordId: string
  state: any
  tasks: any
  log: any
  services: any
  executor: any
  pluginState: FakePluginManagerState
  networkFailure: { lookup: boolean }
  setCheck(overrides?: Record<string, unknown>): Promise<void>
  setGitCheck(overrides?: Record<string, unknown>): Promise<void>
  writeLockfileGit(commit: string): void
  setPluginVersion(version: string): void
  runPlan(): Promise<any>
  runExecute(plan: any, options?: { confirmed?: boolean; overwrite?: boolean; signal?: AbortSignal }): Promise<any>
  transactions(): any[]
}

async function createHarness(options: { hmrEnabled?: boolean; withPlugin?: boolean } = {}): Promise<Harness> {
  const root = tempDir('harness')
  const home = join(root, 'dsh-home')
  const profileDir = join(root, 'profile')
  const installDir = join(profileDir, 'node_modules', 'demo-plugin')
  mkdirSync(profileDir, { recursive: true })
  writeJson(join(profileDir, 'package.json'), {
    dependencies: { 'demo-plugin': '^1.0.0' },
    dsh: { profile: { bundles: ['demo-plugin'] } },
  })
  const pluginState: FakePluginManagerState = {
    profileDir,
    installDir,
    entries: new Map([['demo-plugin', { version: '1.0.0', enabled: true }]]),
    tarballs: new Map(),
    gitTarballs: new Map(),
    failInstall: undefined,
    failRemove: undefined,
    removeApplication: 'applied',
    installApplication: 'applied',
  }
  const fakePluginManager = createFakePluginManager(pluginState)
  const facts = {
    name: 'web',
    dir: profileDir,
    home,
    installAnchor: join(root, 'dsh-install'),
    cwd: root,
    startedBundles: [],
  }
  const paths = {
    home,
    stateDir: join(home, 'extension-manager'),
    logDir: join(home, 'extension-manager', 'logs'),
    backupDir: join(home, 'extension-manager', 'backups'),
    stagingDir: join(home, 'extension-manager', 'staging'),
    stateFile: join(home, 'extension-manager', 'state.json'),
    logFile: join(home, 'extension-manager', 'logs', 'manager.log'),
  }
  const ctx = {
    get(name: string) {
      if (name === 'profileContext') return facts
      if (name === 'pluginManager') return fakePluginManager
      if (name === 'hmr' && options.hmrEnabled === true) return {}
      return undefined
    },
  }
  const state = new stateModule.ManagerState(ctx, paths)
  await state.initialize()
  const log = new logsModule.ManagerLog(paths.logFile)
  const tasks = new tasksModule.TaskRegistry()
  const recordId = 'plugin-bundle:web:demo-plugin'

  const buildRecord = (): Record<string, unknown> => {
    const entry = pluginState.entries.get('demo-plugin')
    return pluginRecordFixture({
      version: { current: entry?.version ?? '1.0.0', status: 'unchecked' },
      runtime: { installed: true, enabled: entry?.enabled ?? true, loaded: true },
      paths: { installDir },
    })
  }

  const plugins = {
    invalidate() {},
    async scan() {
      return {
        profile: { name: 'web', dir: profileDir, dshHome: home },
        profiles: [{ name: 'web', dir: profileDir, readable: true, current: true, bundles: 1 }],
        bundles: options.withPlugin === false ? [] : [buildRecord()],
        rows: [],
        stats: {
          bundlesInstalled: 1, bundlesEnabled: 1, bundlesOtherProfiles: 0, bundlesOfficial: 0,
          rowsTotal: 0, rowsLoaded: 0, rowsFailed: 0, updatesAvailable: 0, abnormal: 0,
        },
        reconciliation: { complete: true, scannedAt: new Date().toISOString(), durationMs: 0, sources: [], counts: {}, unexplained: [], notes: [] },
        check: { running: false },
      }
    },
  }
  const skills = {
    invalidate() {},
    async scan() {
      return {
        roots: [],
        physical: [],
        virtual: [],
        stats: { physical: 0, runtime: 0, effective: 0, shadowed: 0, notManaged: 0, updatesAvailable: 0, abnormal: 0 },
        reconciliation: { complete: true, scannedAt: new Date().toISOString(), durationMs: 0, sources: [], counts: {}, unexplained: [], notes: [] },
        check: { running: false },
      }
    },
  }

  const networkFailure = { lookup: false }
  const network = {
    async registryPolicy() {
      return {
        registry: 'https://registry.npmjs.org/',
        plan: ['https://registry.npmjs.org/'],
        fallbackRegistries: [],
        resolved: 'https://registry.npmjs.org/',
        allowFallback: true,
        configured: { registry: 'https://registry.npmjs.org/', fallbackRegistries: [], resolved: 'https://registry.npmjs.org/' },
      }
    },
    async fetchNpmDocument(name: string, request: { policy: unknown }) {
      void request
      if (networkFailure.lookup) {
        return { status: 'unavailable', attempts: [{ registry: 'https://registry.npmjs.org/', kind: 'network', message: '模拟网络不可用' }] }
      }
      const versions: Record<string, unknown> = {}
      for (const [version, bytes] of pluginState.tarballs) {
        versions[version] = {
          name,
          version,
          dist: {
            tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
            integrity: sha512Base64(bytes),
          },
        }
      }
      return {
        status: 'ok',
        document: { name, 'dist-tags': { latest: [...pluginState.tarballs.keys()].at(-1) }, versions },
        registry: 'https://registry.npmjs.org/',
        url: `https://registry.npmjs.org/${name}`,
        attempts: [],
      }
    },
    async downloadTarball(url: string) {
      const match = /-(\d+\.\d+\.\d+)\.tgz$/u.exec(url)
      const version = match?.[1]
      const bytes = version === undefined ? undefined : pluginState.tarballs.get(version)
      if (bytes === undefined) throw new Error(`fixture has no tarball for ${url}`)
      return bytes
    },
  }

  const services = {
    ctx,
    facts,
    state,
    log,
    tasks,
    plugins,
    skills,
    scratchDir: join(root, 'scratch'),
  }
  const executor = new UpdateExecutor(services, {
    network,
    backup: new BackupManager({ backupRoot: paths.backupDir }),
  })
  const harness: Harness = {
    root,
    home,
    profileDir,
    installDir,
    recordId,
    state,
    tasks,
    log,
    services,
    executor,
    pluginState,
    networkFailure,
    async setCheck(overrides: Record<string, unknown> = {}) {
      await state.setCheck({
        recordId: `plugin:${recordId}`,
        status: 'update-available',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
        compatibility: 'compatible',
        channel: 'stable',
        checkedAt: new Date().toISOString(),
        ...overrides,
      })
    },
    setPluginVersion(version: string) {
      const entry = pluginState.entries.get('demo-plugin') ?? { version, enabled: true }
      pluginState.entries.set('demo-plugin', { ...entry, version })
    },
    async setGitCheck(overrides: Record<string, unknown> = {}) {
      await state.setCheck({
        recordId: `plugin:${recordId}`,
        status: 'update-available',
        currentVersion: '1.0.0',
        channel: 'tag',
        compatibility: 'unknown',
        checkedAt: new Date().toISOString(),
        ...overrides,
      })
    },
    writeLockfileGit(commit: string) {
      writeLockfileGit(profileDir, 'demo-plugin', commit)
    },
    async runPlan() {
      return executor.plan('plugins')
    },
    async runExecute(plan: any, overrides: { confirmed?: boolean; overwrite?: boolean; signal?: AbortSignal } = {}) {
      const task = tasks.create({ kind: 'update', scope: 'plugins', items: [{ id: recordId, name: 'Demo Plugin' }] })
      await executor.execute({
        plan,
        confirmed: overrides.confirmed ?? true,
        overwriteLocalModifications: overrides.overwrite ?? false,
        taskId: task.id,
        signal: overrides.signal ?? new AbortController().signal,
      })
      return tasks.get(task.id)
    },
    transactions() {
      return Object.values(state.get().transactions)
    },
  }
  return harness
}

// ---------------------------------------------------------------------------
// End-to-end plugin update
// ---------------------------------------------------------------------------

/** Replace the plugin inventory with a single git-source record (test fixture). */
function gitPluginRecord(harness: Harness, sourceSpec: string, commit: string): Record<string, unknown> {
  return pluginRecordFixture({
    version: { current: '1.0.0', status: 'unchecked' },
    runtime: { installed: true, enabled: true, loaded: true },
    paths: { installDir: harness.installDir },
    source: {
      kind: 'git',
      trust: 'verified',
      label: 'Git 安装 · github.com',
      spec: sourceSpec,
      url: 'https://github.com/demo/repo',
      repo: 'demo/repo',
      ref: 'main',
      commit,
    },
  })
}

/** Point the harness inventory at one plugin record (test fixture). */
function overridePluginInventory(harness: Harness, record: Record<string, unknown>): void {
  harness.services.plugins = {
    invalidate() {},
    async scan() {
      return {
        profile: { name: 'web', dir: harness.profileDir, dshHome: harness.home },
        profiles: [],
        bundles: [record],
        rows: [],
        stats: {
          bundlesInstalled: 1, bundlesEnabled: 1, bundlesOtherProfiles: 0, bundlesOfficial: 0,
          rowsTotal: 0, rowsLoaded: 0, rowsFailed: 0, updatesAvailable: 0, abnormal: 0,
        },
        reconciliation: { complete: true, scannedAt: new Date().toISOString(), durationMs: 0, sources: [], counts: {}, unexplained: [], notes: [] },
        check: { running: false },
      }
    },
  }
}

describe('plugin update transaction (end to end)', () => {
  test('installs the target version, backs up, validates and records history', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0', { files: { 'extra.js': 'extra\n' } })
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    await harness.setCheck()

    const plan = await harness.runPlan()
    assert.equal(plan.entries.length, 1)
    assert.equal(plan.entries[0].eligible, true)
    const task = await harness.runExecute(plan)
    assert.equal(task.status, 'done')
    assert.equal(task.items[0].status, 'ok')

    const transactions = harness.transactions()
    assert.equal(transactions.length, 1)
    const transaction = transactions[0]
    assert.equal(transaction.phase, 'VERIFIED')
    const phases = transaction.steps.map((step: { phase: string }) => step.phase)
    for (const phase of ['PREFLIGHT', 'BACKUP', 'DOWNLOAD', 'STAGE', 'INSTALL', 'VALIDATE', 'VERIFIED']) {
      assert.ok(phases.includes(phase), `missing phase ${phase}`)
    }
    assert.equal(transaction.rolledBack, undefined)
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '2.0.0')
    assert.ok(existsSync(join(harness.installDir, 'extra.js')))
    assert.ok(transaction.backupDir !== undefined && existsSync(join(transaction.backupDir, 'manifest.json')))
    const manifest = readJson(join(transaction.backupDir, 'manifest.json'))
    assert.equal(manifest.transactionId, transaction.id)
    assert.ok((manifest.tree as { files: Array<{ path: string }> }).files.some(file => file.path === 'package.json'))
    // saveExact target version recorded in the profile manifest.
    const profile = readJson(join(harness.profileDir, 'package.json'))
    assert.equal((profile.dependencies as Record<string, string>)['demo-plugin'], '2.0.0')
    // Successful update clears the cached check and appends one history entry.
    assert.equal(harness.state.check(`plugin:${harness.recordId}`), undefined)
    assert.equal(harness.state.history()[0]?.outcome, 'success')
    assert.equal(harness.state.history()[0]?.transactionId, transaction.id)
  })

  test('rolls back to the verified backup when installation fails', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    harness.pluginState.failInstall = '模拟 pnpm 安装失败（EACCES）'
    await harness.setCheck()

    const plan = await harness.runPlan()
    const task = await harness.runExecute(plan)
    assert.equal(task.status, 'failed')

    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'RECOVERED')
    assert.equal(transaction.rolledBack, true)
    assert.match(transaction.result, /回滚/u)
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '1.0.0')
    const profile = readJson(join(harness.profileDir, 'package.json'))
    assert.equal((profile.dependencies as Record<string, string>)['demo-plugin'], '^1.0.0')
    assert.equal(harness.state.history()[0]?.outcome, 'rolled-back')
    // The backup directory is kept for the operator even after a successful rollback.
    assert.ok(transaction.backupDir !== undefined && existsSync(transaction.backupDir))
  })

  test('blocks a locally modified package until the user accepts overwriting it', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    writeFileSync(join(harness.installDir, 'local-hack.js'), 'hand edited\n')
    await harness.setCheck()

    const plan = await harness.runPlan()
    const first = await harness.runExecute(plan)
    assert.equal(first.items[0].status, 'skipped')
    assert.match(first.items[0].message ?? '', /覆盖本地修改|本地修改/u)
    const blockedTransaction = harness.transactions()[0]
    assert.equal(blockedTransaction.phase, 'RECOVERED')
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '1.0.0')
    assert.equal(harness.state.history()[0]?.outcome, 'blocked')

    const secondPlan = await harness.runPlan()
    const second = await harness.runExecute(secondPlan, { overwrite: true })
    assert.equal(second.status, 'done')
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '2.0.0')
    assert.equal(existsSync(join(harness.installDir, 'local-hack.js')), false)
  })

  test('a cancelled signal before the first item abandons the batch without transactions', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    await harness.setCheck()
    const plan = await harness.runPlan()
    const controller = new AbortController()
    controller.abort()
    const task = await harness.runExecute(plan, { signal: controller.signal })
    assert.equal(task.status, 'cancelled')
    assert.equal(harness.transactions().length, 0)
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '1.0.0')
  })

  test('a pending restart is persisted and reconciled by recover()', async () => {
    const harness = await createHarness({ hmrEnabled: false })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    harness.pluginState.installApplication = 'restart-required'
    await harness.setCheck()

    const plan = await harness.runPlan()
    assert.equal(plan.entries[0].needsRestart, true)
    await harness.runExecute(plan)
    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'PENDING_RESTART')
    assert.equal(transaction.needsRestart, true)

    // Simulated restart: recover() verifies the now-installed version.
    await harness.executor.recover()
    const reconciled = harness.state.transaction(transaction.id)
    assert.equal(reconciled.phase, 'VERIFIED')
    assert.equal(reconciled.needsRestart, false)
  })

  test('crash recovery restores an interrupted INSTALL from its backup', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    const manager = new BackupManager({ backupRoot: join(harness.home, 'extension-manager', 'backups') })
    const snapshot = await manager.backupPlugin({ transactionId: 'crash-tx', installDir: harness.installDir, profileDir: harness.profileDir })
    // Simulate a half-finished replacement: the live tree already holds v2.
    await installTarball(v2, harness.installDir)
    await harness.state.putTransaction({
      id: 'crash-tx',
      kind: 'plugin-bundle',
      extensionId: harness.recordId,
      name: 'demo-plugin',
      targetVersion: '2.0.0',
      previousVersion: '1.0.0',
      phase: 'INSTALL',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [{ at: new Date().toISOString(), phase: 'INSTALL', message: 'process died here' }],
      backupDir: snapshot.dir,
    })
    await harness.executor.recover()
    const recovered = harness.state.transaction('crash-tx')
    assert.equal(recovered.phase, 'RECOVERED')
    assert.equal(recovered.rolledBack, true)
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '1.0.0')
    assert.equal(harness.state.history()[0]?.outcome, 'rolled-back')
  })

  test('a preflight refusal leaves no open transaction and no modification', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', makeNpmTarball('demo-plugin', '2.0.0'))
    // A cache entry claiming a target the registry does not have must be refused.
    await harness.setCheck({ availableVersion: '9.9.9' })
    const plan = await harness.runPlan()
    const task = await harness.runExecute(plan)
    assert.equal(task.items[0].status, 'skipped')
    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'RECOVERED')
    assert.equal(transaction.rolledBack, undefined)
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '1.0.0')
    assert.deepEqual(harness.state.openTransactions(), [])
  })

  test('an unconfirmed execute never touches the filesystem', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    await harness.setCheck()
    const plan = await harness.runPlan()
    const task = await harness.runExecute(plan, { confirmed: false })
    assert.equal(task.status, 'cancelled')
    assert.equal(harness.transactions().length, 0)
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '1.0.0')
    assert.equal(readJson(join(harness.profileDir, 'package.json')).dependencies['demo-plugin'], '^1.0.0')
  })

  test('recover() prunes staging directories older than 24 hours when nothing is open', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const stagingRoot = join(harness.home, 'extension-manager', 'staging')
    const stale = join(stagingRoot, 'dead-transaction')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'target.tgz'), 'stale')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    const fresh = join(stagingRoot, 'fresh-transaction')
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(fresh, 'target.tgz'), 'fresh')
    await harness.executor.recover()
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(fresh), true)
    assert.equal(existsSync(stagingRoot), true)
  })
})

  test('plan detects local modifications and asks for confirmation with a backup hint', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    writeFileSync(join(harness.installDir, 'local-edit.js'), 'hand edited\n')
    await harness.setCheck()
    const plan = await harness.runPlan()
    assert.equal(plan.entries.length, 1)
    assert.equal(plan.entries[0].eligible, false)
    assert.equal(plan.entries[0].requiresConfirmation, true)
    assert.match(plan.entries[0].risk ?? '', /本地修改/u)
    assert.match(plan.entries[0].risk ?? '', /备份/u)
  })

  test('plan marks the update unverifiable when the registry is unreachable', async () => {
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.tarballs.set('1.0.0', v1)
    harness.pluginState.tarballs.set('2.0.0', v2)
    harness.networkFailure.lookup = true
    await harness.setCheck()
    const plan = await harness.runPlan()
    assert.equal(plan.entries[0].eligible, false)
    assert.equal(plan.entries[0].requiresConfirmation, true)
    assert.match(plan.entries[0].risk ?? '', /无法核对本地修改/u)
  })

  test('updates a git-installed bundle by commit and validates the lockfile', async () => {
    const OLD = '0123456789abcdef0123456789abcdef01234567'
    const NEW = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.gitTarballs.set(NEW, v2)
    writeJson(join(harness.profileDir, 'package.json'), {
      dependencies: { 'demo-plugin': `github:demo/repo#${OLD}` },
      dsh: { profile: { bundles: ['demo-plugin'] } },
    })
    harness.writeLockfileGit(OLD)
    overridePluginInventory(harness, gitPluginRecord(harness, `github:demo/repo#${OLD}`, OLD))
    await harness.setGitCheck({ availableCommit: NEW })

    const plan = await harness.runPlan()
    assert.equal(plan.entries.length, 1)
    assert.equal(plan.entries[0].eligible, false)
    assert.equal(plan.entries[0].requiresConfirmation, true)
    assert.equal(plan.entries[0].targetVersion, NEW.slice(0, 12))
    const task = await harness.runExecute(plan, { overwrite: true })
    assert.equal(task.status, 'done')
    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'VERIFIED')
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '2.0.0')
    assert.equal(
      (readJson(join(harness.profileDir, 'package.json')).dependencies as Record<string, string>)['demo-plugin'],
      `github:demo/repo#${NEW}`,
    )
    assert.match(readFileSync(join(harness.profileDir, 'pnpm-lock.yaml'), 'utf8'), new RegExp(NEW, 'u'))
    assert.equal(harness.state.history()[0]?.outcome, 'success')
  })

  test('rolls back a failed git install to the previous checkout and lockfile', async () => {
    const OLD = '0123456789abcdef0123456789abcdef01234567'
    const NEW = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
    const harness = await createHarness({ hmrEnabled: true })
    const v1 = makeNpmTarball('demo-plugin', '1.0.0')
    const v2 = makeNpmTarball('demo-plugin', '2.0.0')
    await installTarball(v1, harness.installDir)
    harness.pluginState.gitTarballs.set(NEW, v2)
    writeJson(join(harness.profileDir, 'package.json'), {
      dependencies: { 'demo-plugin': `github:demo/repo#${OLD}` },
      dsh: { profile: { bundles: ['demo-plugin'] } },
    })
    harness.writeLockfileGit(OLD)
    overridePluginInventory(harness, gitPluginRecord(harness, `github:demo/repo#${OLD}`, OLD))
    harness.pluginState.failInstall = '模拟 git 拉取失败'
    await harness.setGitCheck({ availableCommit: NEW })
    const plan = await harness.runPlan()
    const task = await harness.runExecute(plan, { overwrite: true })
    assert.equal(task.status, 'failed')
    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'RECOVERED')
    assert.equal(transaction.rolledBack, true)
    assert.equal(readJson(join(harness.installDir, 'package.json')).version, '1.0.0')
    assert.equal(
      (readJson(join(harness.profileDir, 'package.json')).dependencies as Record<string, string>)['demo-plugin'],
      `github:demo/repo#${OLD}`,
    )
    assert.match(readFileSync(join(harness.profileDir, 'pnpm-lock.yaml'), 'utf8'), new RegExp(OLD, 'u'))
    assert.equal(harness.state.history()[0]?.outcome, 'rolled-back')
  })

// ---------------------------------------------------------------------------
// Skill update (end to end)
// ---------------------------------------------------------------------------

interface SkillHarness extends Harness {
  skillRoot: string
  skillDir: string
  setSkillCheck(overrides?: Record<string, unknown>): Promise<void>
  setArchive(bytes: Buffer): void
  runSkillPlan(): Promise<any>
  runSkillExecute(plan: any): Promise<any>
}

async function createSkillHarness(): Promise<SkillHarness> {
  const base = await createHarness({ hmrEnabled: true, withPlugin: false })
  const skillRoot = join(base.root, 'skills-root')
  const skillDir = join(skillRoot, 'demo-skill')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: demo-skill\n---\nold content\n')
  writeFileSync(join(skillDir, 'old.js'), 'old\n')
  const skillId = 'skill:filesystem:demo-skill'
  let archiveBytes: Buffer = Buffer.alloc(0)
  const skillRecord = {
    id: skillId,
    kind: 'skill',
    name: 'demo-skill',
    displayName: 'Demo Skill',
    description: 'fixture skill',
    version: { current: 'old', currentTree: 'old-tree', status: 'unchecked' },
    source: {
      kind: 'skill-git',
      trust: 'verified',
      label: 'GitHub · demo/repo',
      url: 'https://github.com/demo/repo',
      repo: 'demo/repo',
      subdir: SKILL_TREE_FIXTURE.subdir,
      commit: 'old-commit',
    },
    runtime: { installed: true, loaded: true },
    scope: 'filesystem',
    rootKey: 'user-dsh',
    layout: 'directory',
    paths: { installDir: skillDir, rootDir: skillRoot },
    effective: true,
    localModification: { state: 'clean' },
    diagnostics: [],
    actions: { canCheck: true, canUpdate: true },
  }
  base.services.skills = {
    invalidate() {},
    async scan() {
      return {
        roots: [{ key: 'user-dsh', label: 'user', path: skillRoot, managed: true, exists: true, complete: true, count: 1 }],
        physical: [skillRecord],
        virtual: [],
        stats: { physical: 1, runtime: 1, effective: 1, shadowed: 0, notManaged: 0, updatesAvailable: 0, abnormal: 0 },
        reconciliation: { complete: true, scannedAt: new Date().toISOString(), durationMs: 0, sources: [], counts: {}, unexplained: [], notes: [] },
        check: { running: false },
      }
    },
  }
  const executor = new UpdateExecutor(base.services, {
    network: {
      async registryPolicy() {
        return {
          registry: 'https://registry.npmjs.org/',
          plan: ['https://registry.npmjs.org/'],
          fallbackRegistries: [],
          resolved: 'https://registry.npmjs.org/',
          allowFallback: true,
          configured: { registry: 'https://registry.npmjs.org/', fallbackRegistries: [], resolved: 'https://registry.npmjs.org/' },
        }
      },
      async fetchNpmDocument() {
        return { status: 'unavailable', attempts: [] }
      },
      async downloadTarball() {
        throw new Error('no npm downloads in skill tests')
      },
    },
    archive: {
      async download() {
        return archiveBytes
      },
    },
    backup: new BackupManager({ backupRoot: join(base.home, 'extension-manager', 'backups') }),
  })
  base.services.executor = executor
  const harness: SkillHarness = {
    ...base,
    executor,
    skillRoot,
    skillDir,
    setSkillCheck: async (overrides = {}) => {
      await base.state.setCheck({
        recordId: `skill:${skillId}`,
        status: 'update-available',
        currentVersion: 'old',
        availableVersion: 'v2',
        availableCommit: SKILL_TREE_FIXTURE.commit,
        availableTree: SKILL_TREE_FIXTURE.tree,
        checkedAt: new Date().toISOString(),
        ...overrides,
      })
    },
    setArchive(bytes: Buffer) {
      archiveBytes = bytes
    },
    async runSkillPlan() {
      return executor.plan('skills')
    },
    async runSkillExecute(plan: any) {
      const task = base.tasks.create({ kind: 'update', scope: 'skills', items: [{ id: skillId, name: 'Demo Skill' }] })
      await executor.execute({
        plan,
        confirmed: true,
        overwriteLocalModifications: false,
        taskId: task.id,
        signal: new AbortController().signal,
      })
      return base.tasks.get(task.id)
    },
  }
  return harness
}

describe('skill update transaction (end to end)', () => {
  test('replaces only the skill directory after verifying the git tree hash', async () => {
    const harness = await createSkillHarness()
    harness.setArchive(makeSkillArchive(
      SKILL_TREE_FIXTURE.repo,
      SKILL_TREE_FIXTURE.commit,
      SKILL_TREE_FIXTURE.subdir,
      SKILL_TREE_FIXTURE.files.map(file => ({ path: file.path, content: file.content, mode: file.mode })),
    ))
    await harness.setSkillCheck()
    const plan = await harness.runSkillPlan()
    assert.equal(plan.entries.length, 1)
    assert.equal(plan.entries[0].eligible, true)
    const task = await harness.runSkillExecute(plan)
    assert.equal(task.status, 'done')
    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'VERIFIED')
    assert.match(readFileSync(join(harness.skillDir, 'SKILL.md'), 'utf8'), /demo-skill/u)
    assert.equal(readFileSync(join(harness.skillDir, 'scripts', 'run.js'), 'utf8'), 'console.log("hi")\n')
    assert.equal(existsSync(join(harness.skillDir, 'old.js')), false)
    assert.ok(existsSync(join(harness.skillDir, 'references', 'notes.md')))
    // The whole repository was never checked out: only the skill subtree exists.
    assert.deepEqual(readdirNames(harness.skillRoot), ['demo-skill'])
    // The backup keeps the previous directory content.
    assert.ok(transaction.backupDir !== undefined)
    assert.equal(readFileSync(join(transaction.backupDir, 'skill', 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nold content\n')
    assert.equal(harness.state.history()[0]?.outcome, 'success')
    const cachedCheck = harness.state.check('skill:skill:filesystem:demo-skill')
    assert.equal(cachedCheck?.status, 'up-to-date')
    assert.equal(cachedCheck?.availableTree, SKILL_TREE_FIXTURE.tree)
  })

  test('refuses to replace a skill whose archive tree hash does not match', async () => {
    const harness = await createSkillHarness()
    harness.setArchive(makeSkillArchive(
      SKILL_TREE_FIXTURE.repo,
      SKILL_TREE_FIXTURE.commit,
      SKILL_TREE_FIXTURE.subdir,
      SKILL_TREE_FIXTURE.files.map(file => ({ path: file.path, content: file.content, mode: file.mode })),
    ))
    await harness.setSkillCheck({ availableTree: '0000000000000000000000000000000000000000' })
    const plan = await harness.runSkillPlan()
    const task = await harness.runSkillExecute(plan)
    assert.equal(task.status, 'failed')
    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'RECOVERED')
    assert.match(transaction.error ?? '', /目录树哈希/u)
    // The live directory is untouched.
    assert.equal(readFileSync(join(harness.skillDir, 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nold content\n')
    assert.ok(existsSync(join(harness.skillDir, 'old.js')))
  })

  test('refuses a skill with a modified directory unless overwrite is accepted', async () => {
    const harness = await createSkillHarness()
    harness.setArchive(makeSkillArchive(
      SKILL_TREE_FIXTURE.repo,
      SKILL_TREE_FIXTURE.commit,
      SKILL_TREE_FIXTURE.subdir,
      SKILL_TREE_FIXTURE.files.map(file => ({ path: file.path, content: file.content, mode: file.mode })),
    ))
    await harness.setSkillCheck()
    // Mark the physical copy as locally modified.
    harness.services.skills = {
      invalidate() {},
      async scan() {
        return {
          roots: [],
          physical: [{
            id: 'skill:filesystem:demo-skill',
            kind: 'skill',
            name: 'demo-skill',
            displayName: 'Demo Skill',
            description: 'fixture skill',
            version: { current: 'old', currentTree: 'old-tree', status: 'unchecked' },
            source: {
              kind: 'skill-git', trust: 'verified', label: 'GitHub · demo/repo',
              url: 'https://github.com/demo/repo', repo: 'demo/repo',
              subdir: SKILL_TREE_FIXTURE.subdir, commit: 'old-commit',
            },
            runtime: { installed: true, loaded: true },
            scope: 'filesystem',
            rootKey: 'user-dsh',
            layout: 'directory',
            paths: { installDir: harness.skillDir, rootDir: harness.skillRoot },
            effective: true,
            localModification: { state: 'modified', files: ['SKILL.md'] },
            diagnostics: [],
            actions: { canCheck: true, canUpdate: true },
          }],
          virtual: [],
          stats: { physical: 1, runtime: 1, effective: 1, shadowed: 0, notManaged: 0, updatesAvailable: 0, abnormal: 0 },
          reconciliation: { complete: true, scannedAt: new Date().toISOString(), durationMs: 0, sources: [], counts: {}, unexplained: [], notes: [] },
          check: { running: false },
        }
      },
    }
    const plan = await harness.runSkillPlan()
    assert.equal(plan.entries[0].requiresConfirmation, true)
    const task = await harness.runSkillExecute(plan)
    assert.equal(task.items[0].status, 'skipped')
    assert.match(task.items[0].message ?? '', /本地修改/u)
    assert.equal(readFileSync(join(harness.skillDir, 'SKILL.md'), 'utf8'), '---\nname: demo-skill\n---\nold content\n')
  })

  test('updates from a branch ref when the check has no commit, verifying the tree hash', async () => {
    const harness = await createSkillHarness()
    // The skill checker stores a tree hash but no commit; the source records a branch.
    harness.setArchive(makeSkillArchive(
      SKILL_TREE_FIXTURE.repo,
      'main',
      SKILL_TREE_FIXTURE.subdir,
      SKILL_TREE_FIXTURE.files.map(file => ({ path: file.path, content: file.content, mode: file.mode })),
    ))
    const baseRecord = (await harness.services.skills.scan({})).physical[0]
    harness.services.skills = {
      invalidate() {},
      async scan() {
        return {
          roots: [],
          physical: [{ ...baseRecord, source: { ...baseRecord.source, ref: 'main' } }],
          virtual: [],
          stats: { physical: 1, runtime: 1, effective: 1, shadowed: 0, notManaged: 0, updatesAvailable: 0, abnormal: 0 },
          reconciliation: { complete: true, scannedAt: new Date().toISOString(), durationMs: 0, sources: [], counts: {}, unexplained: [], notes: [] },
          check: { running: false },
        }
      },
    }
    await harness.setSkillCheck({ availableCommit: undefined })
    const plan = await harness.runSkillPlan()
    assert.equal(plan.entries.length, 1)
    const task = await harness.runSkillExecute(plan)
    assert.equal(task.status, 'done')
    assert.equal(readFileSync(join(harness.skillDir, 'scripts', 'run.js'), 'utf8'), 'console.log("hi")\n')
    const transaction = harness.transactions()[0]
    assert.equal(transaction.phase, 'VERIFIED')
    assert.equal(transaction.targetVersion, 'v2')
  })

  test('advances the confirmed source baseline after a successful replacement', async () => {
    const harness = await createSkillHarness()
    harness.setArchive(makeSkillArchive(
      SKILL_TREE_FIXTURE.repo,
      'HEAD',
      SKILL_TREE_FIXTURE.subdir,
      SKILL_TREE_FIXTURE.files.map(file => ({ path: file.path, content: file.content, mode: file.mode })),
    ))
    await harness.state.setSkillSource({
      recordId: 'skill:skill:filesystem:demo-skill',
      url: 'https://github.com/demo/repo',
      subdir: SKILL_TREE_FIXTURE.subdir,
      confirmedAt: new Date().toISOString(),
      baseline: { tree: 'old-tree' },
      verified: true,
    })
    await harness.setSkillCheck({ availableCommit: undefined })
    const plan = await harness.runSkillPlan()
    const task = await harness.runSkillExecute(plan)
    assert.equal(task.status, 'done')
    const association = harness.state.skillSource('skill:skill:filesystem:demo-skill')
    assert.equal(association.baseline.tree, SKILL_TREE_FIXTURE.tree)
  })
})

/** Sorted directory entry names (fixture assertion helper). */
function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort()
}

describe('backup retention and maintenance', () => {
  test('maintain() keeps the newest backups, protects open transactions and prunes stale staging', async () => {
    const harness = await createHarness({ hmrEnabled: true, withPlugin: false })
    const backupRoot = join(harness.home, 'extension-manager', 'backups')
    const base = Date.now() - 60 * 60 * 1000
    for (let index = 0; index < 23; index += 1) {
      const name = `tx-${String(index).padStart(2, '0')}`
      const dir = join(backupRoot, name)
      mkdirSync(dir, { recursive: true })
      writeJson(join(dir, 'manifest.json'), {
        schema: 1,
        transactionId: name,
        kind: 'plugin-bundle',
        createdAt: new Date(base + index * 60_000).toISOString(),
        sourcePath: '/tmp/package',
        rootDir: 'package',
        tree: { files: [], symlinks: [], dirs: [], totalBytes: 0 },
      })
    }
    // The oldest backup belongs to an open transaction: retention must keep it.
    await harness.state.putTransaction({
      id: 'tx-00',
      kind: 'plugin-bundle',
      extensionId: 'plugin-bundle:web:demo-plugin',
      name: 'demo-plugin',
      phase: 'PENDING_RESTART',
      targetVersion: '2.0.0',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: [],
    })
    const stagingRoot = join(harness.home, 'extension-manager', 'staging')
    const stale = join(stagingRoot, 'old-staging')
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'target.tgz'), 'x')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    const fresh = join(stagingRoot, 'fresh-staging')
    mkdirSync(fresh, { recursive: true })
    writeFileSync(join(fresh, 'target.tgz'), 'x')

    await harness.executor.maintain()

    const remaining = readdirSync(backupRoot).sort()
    assert.equal(remaining.length, 21)
    assert.ok(remaining.includes('tx-00'))
    assert.ok(remaining.includes('tx-22'))
    assert.ok(!remaining.includes('tx-01'))
    assert.ok(!remaining.includes('tx-02'))
    assert.equal(existsSync(stale), false)
    assert.equal(existsSync(fresh), true)
  })
})

// Keep `withInstallLock` covered: two queued operations must not interleave.
describe('serial write queue', () => {
  test('runs queued operations one after another', async () => {
    const order: string[] = []
    const first = withInstallLock(async () => {
      order.push('first-start')
      await new Promise(resolve => setTimeout(resolve, 10))
      order.push('first-end')
    })
    const second = withInstallLock(async () => {
      order.push('second-start')
      order.push('second-end')
    })
    await Promise.all([first, second])
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
  })
})
