/**
 * Backup, verification and restore primitives for safe update transactions.
 *
 * Every destructive update first copies the live install directory (a plugin
 * package or a skill directory) and the profile files an installation may
 * rewrite into `$DSH_HOME/extension-manager/backups/<transaction>/`, records a
 * content manifest (SHA-256 per file) and re-reads the copy to prove it is
 * byte-identical before the update is allowed to touch the live directory.
 * Recovery writes the verified copy back and re-verifies the result.
 *
 * Windows semantics are deliberately explicit: rename/replace/remove retries
 * cover EBUSY/EPERM/EACCES/ENOTEMPTY, read-only attributes are cleared before
 * a retry (never by killing a process), and no operation assumes POSIX atomic
 * rename-over-existing behaviour. A backup directory is always kept when a
 * transaction fails so an operator can recover by hand.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants, createReadStream } from 'node:fs'
import type { Dirent } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

/** Filesystem error codes worth retrying; a locked file usually settles after a short wait. */
const RETRYABLE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'EAGAIN'])

/** Profile files an installation or the manager may rewrite; snapshotted per transaction. */
export const PROFILE_SNAPSHOT_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'cordis.patch.yml',
  'compatibility.json',
] as const

/** Human-readable error for any thrown value. */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** The filesystem error code of a failed operation, when it carries one. */
export function fsErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code
  return typeof code === 'string' ? code : undefined
}

/** Whether an error is a transient Windows-style file lock / permission problem. */
export function isRetryableFsError(error: unknown): boolean {
  const code = fsErrorCode(error)
  return code !== undefined && RETRYABLE_CODES.has(code)
}

/** Retry policy for file operations. */
export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  /** Called once per scheduled retry; useful for audit lines. */
  onRetry?: (attempt: number, error: unknown, label: string) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Run one file operation, retrying transient Windows lock/permission failures
 * with capped exponential backoff. Non-retryable errors are rethrown at once.
 */
export async function retryFs<T>(label: string, operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 6)
  const baseDelay = Math.max(1, options.baseDelayMs ?? 40)
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryableFsError(error) || attempt === attempts - 1) throw error
      options.onRetry?.(attempt + 1, error, label)
      await sleep(Math.min(1500, baseDelay * 2 ** attempt) + Math.floor(Math.random() * baseDelay))
    }
  }
  throw lastError
}

/** Clear the read-only attribute across a tree so a later remove/rename may succeed. */
async function clearReadOnlyTree(target: string): Promise<void> {
  const info = await lstat(target).catch(() => undefined)
  if (info === undefined) return
  if (info.isDirectory()) {
    const children = await readdir(target).catch(() => [] as string[])
    for (const child of children) await clearReadOnlyTree(join(target, child))
    await chmod(target, 0o777).catch(() => undefined)
    return
  }
  await chmod(target, 0o666).catch(() => undefined)
}

/** Ensure a directory exists (recursively). */
export async function ensureDirectory(target: string): Promise<void> {
  await retryFs(`mkdir:${target}`, () => mkdir(target, { recursive: true }))
}

/** One regular file in a content manifest, relative to the manifest root with `/` separators. */
export interface FileHashEntry {
  path: string
  size: number
  sha256: string
}

/** One symbolic link in a content manifest (target stored verbatim, not followed). */
export interface SymlinkHashEntry {
  path: string
  target: string
}

/** Content manifest of one directory tree. */
export interface TreeManifest {
  files: FileHashEntry[]
  symlinks: SymlinkHashEntry[]
  /** Directories in the tree (empty ones included; git does not track them). */
  dirs: string[]
  totalBytes: number
}

/** Difference between an expected manifest and an observed tree. */
export interface ManifestComparison {
  /** Present in the observed tree but not in the expected manifest. */
  added: string[]
  /** Present in both with different content. */
  modified: string[]
  /** Expected but absent from the observed tree. */
  missing: string[]
  /** Number of files/symlinks that matched exactly. */
  identical: number
  /** True when no difference was found. */
  clean: boolean
}

/** Options accepted by {@link hashTree}. */
export interface HashTreeOptions {
  /** Skip a tree-relative path (e.g. nested `node_modules`). */
  ignore?: (relativePath: string) => boolean
  /** Safety bound; exceeding it rejects the tree instead of scanning forever. */
  maxEntries?: number
}

/** Compute the SHA-256 of one buffer as lowercase hex. */
export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Compute the SHA-256 of one file by streaming it. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Normalize a manifest path to `/` separators with no leading `./`. */
function normalizeRelative(input: string): string {
  return input.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
}

/**
 * Hash a directory tree: every regular file (path, size, SHA-256), every
 * symbolic link (target) and every directory. Symlinks are recorded, never
 * followed, so a link pointing outside the tree cannot leak foreign content
 * into a manifest or a local-modification comparison.
 */
export async function hashTree(root: string, options: HashTreeOptions = {}): Promise<TreeManifest> {
  const files: FileHashEntry[] = []
  const symlinks: SymlinkHashEntry[] = []
  const dirs: string[] = []
  let totalBytes = 0
  const limit = options.maxEntries ?? 200_000
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      throw new Error(`无法读取目录 ${directory}：${messageOf(error)}`)
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      if (options.ignore?.(relativePath) === true) continue
      if (files.length + symlinks.length + dirs.length >= limit) {
        throw new Error(`目录文件数量超过安全上限（${String(limit)} 项），已停止扫描`)
      }
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        dirs.push(relativePath)
        await walk(absolute, relativePath)
        continue
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolute).catch(() => '')
        symlinks.push({ path: relativePath, target })
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(absolute)
      files.push({ path: relativePath, size: info.size, sha256: await sha256File(absolute) })
      totalBytes += info.size
    }
  }
  await walk(root, '')
  files.sort((left, right) => left.path.localeCompare(right.path))
  symlinks.sort((left, right) => left.path.localeCompare(right.path))
  dirs.sort((left, right) => left.localeCompare(right))
  return { files, symlinks, dirs, totalBytes }
}

/** Compare an expected manifest with an observed one; diffs are bounded for UI display. */
export function compareTreeManifests(expected: TreeManifest, actual: TreeManifest, limit = 40): ManifestComparison {
  const expectedFiles = new Map(expected.files.map(entry => [entry.path, entry]))
  const actualFiles = new Map(actual.files.map(entry => [entry.path, entry]))
  const expectedLinks = new Map(expected.symlinks.map(entry => [entry.path, entry]))
  const actualLinks = new Map(actual.symlinks.map(entry => [entry.path, entry]))
  const added: string[] = []
  const modified: string[] = []
  const missing: string[] = []
  let identical = 0
  for (const [path, entry] of actualFiles) {
    const wanted = expectedFiles.get(path)
    if (wanted === undefined) {
      if (added.length < limit) added.push(path)
      continue
    }
    if (wanted.sha256 === entry.sha256 && wanted.size === entry.size) identical += 1
    else if (modified.length < limit) modified.push(path)
  }
  for (const path of expectedFiles.keys()) {
    if (!actualFiles.has(path) && missing.length < limit) missing.push(path)
  }
  for (const [path, entry] of actualLinks) {
    const wanted = expectedLinks.get(path)
    if (wanted === undefined) {
      if (added.length < limit) added.push(path)
      continue
    }
    if (wanted.target === entry.target) identical += 1
    else if (modified.length < limit) modified.push(path)
  }
  for (const path of expectedLinks.keys()) {
    if (!actualLinks.has(path) && missing.length < limit) missing.push(path)
  }
  return {
    added,
    modified,
    missing,
    identical,
    clean: added.length === 0 && modified.length === 0 && missing.length === 0,
  }
}

/** Copy one directory tree, preserving regular files, directories and symbolic links. */
export async function copyTree(source: string, target: string, options: HashTreeOptions & RetryOptions = {}): Promise<void> {
  const copyEntry = async (from: string, to: string, relativeDirectory: string): Promise<void> => {
    await ensureDirectory(to)
    const entries = await retryFs(`readdir:${from}`, () => readdir(from, { withFileTypes: true }))
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      if (options.ignore?.(relativePath) === true) continue
      const fromChild = join(from, entry.name)
      const toChild = join(to, entry.name)
      if (entry.isDirectory()) {
        await copyEntry(fromChild, toChild, relativePath)
        continue
      }
      if (entry.isSymbolicLink()) {
        const linkTarget = await retryFs(`readlink:${fromChild}`, () => readlink(fromChild))
        await retryFs(`symlink:${toChild}`, async () => {
          await rm(toChild, { recursive: true, force: true }).catch(() => undefined)
          try {
            await symlink(linkTarget, toChild)
          } catch {
            // Windows needs the link type; a directory target is the common failure.
            await symlink(linkTarget, toChild, 'junction')
          }
        }, options)
        continue
      }
      if (entry.isFile()) {
        await retryFs(`copy:${fromChild}`, () => copyFile(fromChild, toChild), options)
        continue
      }
      throw new Error(`不支持的目录项类型（既不是文件、目录，也不是符号链接）：${relativePath}`)
    }
  }
  await copyEntry(source, target, '')
}

/** Remove one path (file, link or tree), retrying transient Windows locks. */
export async function removeTree(target: string, options: RetryOptions = {}): Promise<void> {
  let cleared = false
  await retryFs(`remove:${target}`, async () => {
    try {
      await rm(target, { recursive: true, force: true })
    } catch (error) {
      // A read-only attribute surfaces as EPERM on Windows; clear it once, then retry.
      if (!cleared && isRetryableFsError(error)) {
        cleared = true
        await clearReadOnlyTree(target)
      }
      throw error
    }
  }, options)
}

/** Rename with retries; a missing source and a locked destination are reported distinctly. */
export async function renameWithRetry(from: string, to: string, options: RetryOptions = {}): Promise<void> {
  await ensureDirectory(dirname(to))
  await retryFs(`rename:${from}`, () => rename(from, to), options)
}

/**
 * Move a file or directory. `rename` is preferred; across volumes (skill roots
 * may live on another drive than `$DSH_HOME`) it falls back to copy+remove.
 */
export async function moveTree(from: string, to: string, options: RetryOptions = {}): Promise<void> {
  try {
    await renameWithRetry(from, to, options)
    return
  } catch (error) {
    if (fsErrorCode(error) !== 'EXDEV') throw error
  }
  await copyTree(from, to, options)
  await removeTree(from, options)
}

/**
 * Write a file through a temporary sibling plus a replace step that also works
 * on Windows (where `rename` cannot overwrite an existing file): the previous
 * file is moved aside first so a crash never loses both copies.
 */
export async function writeFileAtomicSafe(path: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const directory = dirname(path)
  await ensureDirectory(directory)
  const temporary = join(directory, `.${basename(path)}.${String(process.pid)}.${String(Date.now())}.tmp`)
  const options = mode === undefined ? {} : { mode }
  await retryFs(`write:${temporary}`, () => writeFile(temporary, data, options))
  try {
    await retryFs(`replace:${path}`, async () => {
      try {
        await rename(temporary, path)
        return
      } catch (error) {
        const code = fsErrorCode(error)
        if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTEMPTY') throw error
      }
      const aside = `${path}.bak-${String(process.pid)}`
      await rm(aside, { force: true }).catch(() => undefined)
      await rename(path, aside).catch((error: unknown) => {
        if (fsErrorCode(error) !== 'ENOENT') throw error
      })
      await rename(temporary, path)
      await rm(aside, { force: true }).catch(() => undefined)
    })
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** Write a JSON document atomically. */
export async function writeJsonAtomicSafe(path: string, value: unknown): Promise<void> {
  await writeFileAtomicSafe(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** Read and parse one JSON file, or `undefined` when it is absent or unreadable. */
export async function readJsonSafe<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Whether a path exists and allows the requested access. */
export async function checkAccess(path: string, mode: number = fsConstants.W_OK): Promise<boolean> {
  try {
    await access(path, mode)
    return true
  } catch {
    return false
  }
}

/** Free bytes on the volume holding `path`, when the platform can report them. */
export async function readFreeBytes(path: string): Promise<number | undefined> {
  try {
    const info = await statfs(path)
    const free = Number(info.bavail) * Number(info.bsize)
    return Number.isFinite(free) ? free : undefined
  } catch {
    return undefined
  }
}

/** Sum the sizes of every regular file below `root` without hashing them. */
export async function measureDirectory(root: string, options: HashTreeOptions = {}): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      if (options.ignore?.(relativePath) === true) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, relativePath)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(absolute).catch(() => undefined)
      if (info === undefined) continue
      bytes += info.size
      files += 1
    }
  }
  await walk(root, '')
  return { bytes, files }
}

/** Whether a tree contains at least one symbolic link (checked without following links). */
export async function containsSymlink(root: string): Promise<string | undefined> {
  const walk = async (directory: string, relativeDirectory: string): Promise<string | undefined> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => undefined)
    if (entries === undefined) return undefined
    for (const entry of entries) {
      const relativePath = relativeDirectory === '' ? entry.name : `${relativeDirectory}/${entry.name}`
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) return relativePath
      if (entry.isDirectory()) {
        const found = await walk(absolute, relativePath)
        if (found !== undefined) return found
      }
    }
    return undefined
  }
  return walk(root, '')
}

/**
 * Resolve `child` and prove it stays inside `root` (both must exist for a
 * genuine real-path check). Returns the resolved path, or `undefined` when the
 * path escapes the root, is equal to it, or cannot be resolved.
 */
export async function resolveInside(root: string, child: string): Promise<string | undefined> {
  try {
    const realRoot = await realpath(root)
    const realChild = await realpath(child)
    const relativePath = relative(realRoot, realChild)
    if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined
    return realChild
  } catch {
    return undefined
  }
}

/** Append `child` to `root` and reject any path that would escape it after normalization. */
export function safeJoinInside(root: string, child: string): string | undefined {
  const normalizedChild = child.replace(/\\/gu, '/')
  if (normalizedChild === '' || normalizedChild.startsWith('/') || /^[A-Za-z]:/u.test(normalizedChild)) return undefined
  const segments = normalizedChild.split('/')
  if (segments.some(segment => segment === '..' || segment === '')) return undefined
  const joined = join(root, ...segments)
  const relativePath = relative(root, joined)
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined
  return joined
}

/** One file inside a backup snapshot. */
export interface BackupSnapshotFile {
  name: string
  sha256: string
  size: number
}

/** Persisted manifest of one backup directory. */
export interface BackupManifest {
  schema: 1
  transactionId: string
  kind: 'plugin-bundle' | 'skill'
  createdAt: string
  /** Absolute source path the backup was copied from. */
  sourcePath: string
  /** Directory name inside the backup holding the copied tree (`package` / `skill`). */
  rootDir: string
  tree: TreeManifest
  /** Profile files snapshotted beside the tree (plugin backups only). */
  profile?: {
    dir: string
    files: BackupSnapshotFile[]
    /** Files absent at backup time; recovery leaves them alone. */
    missing: string[]
  }
}

/** Result of a completed backup, handed to restore/verify. */
export interface BackupResult {
  transactionId: string
  kind: 'plugin-bundle' | 'skill'
  /** Directory holding the snapshot (`.../backups/<txid>`). */
  dir: string
  /** Directory holding the copied tree (`.../backups/<txid>/package|skill`). */
  rootDir: string
  manifestPath: string
  manifest: BackupManifest
  fileCount: number
  totalBytes: number
}

/** Outcome of re-reading a backup from disk. */
export interface BackupVerification {
  ok: boolean
  /** Human-readable problems (Chinese) safe to show. */
  problems: string[]
  fileCount: number
  totalBytes: number
}

/** Outcome of restoring a backup into the live location. */
export interface RestoreReport {
  ok: boolean
  /** Whether the install/skill tree itself was written back. */
  treeRestored: boolean
  /** Profile snapshot files written back successfully. */
  profileFilesRestored: string[]
  /** Profile files left alone because they were absent at backup time. */
  profileFilesSkipped: string[]
  problems: string[]
  /** Version read from the restored `package.json`, when one was restored. */
  verifiedVersion?: string
}

/** Minimal logger surface the manager needs; `ManagerLog` satisfies it. */
export interface BackupLogger {
  info(event: string, detail?: Record<string, unknown>): void
  warn(event: string, detail?: Record<string, unknown>): void
}

/** Constructor options for {@link BackupManager}. */
export interface BackupManagerOptions {
  /** `$DSH_HOME/extension-manager/backups`. */
  backupRoot: string
  log?: BackupLogger
  /** Scoped retry overrides. */
  retry?: RetryOptions
}

/** Sanitize a transaction id for use as a directory name (no traversal possible). */
function sanitizeTransactionId(transactionId: string): string {
  const sanitized = transactionId.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 96)
  return sanitized === '' || sanitized === '.' || sanitized === '..' ? 'transaction' : sanitized
}

/**
 * Creates verified backups of install trees and profile files, and restores
 * them during failure recovery.
 */
export class BackupManager {
  readonly backupRoot: string
  private readonly log: BackupLogger | undefined
  private readonly retry: RetryOptions

  constructor(options: BackupManagerOptions) {
    this.backupRoot = options.backupRoot
    this.log = options.log
    this.retry = options.retry ?? {}
  }

  /** Absolute backup directory for one transaction id. */
  dirFor(transactionId: string): string {
    const safe = sanitizeTransactionId(transactionId)
    const parent = join(this.backupRoot, safe)
    // The sanitized id cannot escape on its own; verify anyway before touching disk.
    const relativePath = relative(this.backupRoot, parent)
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new Error('事务标识无法安全地映射为备份目录')
    }
    return parent
  }

  /** Re-open a backup written by an earlier process (startup recovery). */
  async loadBackup(transactionId: string): Promise<BackupResult | undefined> {
    const dir = this.dirFor(transactionId)
    const manifestPath = join(dir, 'manifest.json')
    const manifest = await readJsonSafe<BackupManifest>(manifestPath)
    if (manifest === undefined) return undefined
    if (manifest.transactionId !== transactionId) return undefined
    const rootDir = join(dir, manifest.rootDir)
    const info = await stat(rootDir).catch(() => undefined)
    if (info === undefined || !info.isDirectory()) return undefined
    return {
      transactionId,
      kind: manifest.kind,
      dir,
      rootDir,
      manifestPath,
      manifest,
      fileCount: manifest.tree.files.length + manifest.tree.symlinks.length,
      totalBytes: manifest.tree.totalBytes,
    }
  }

  /** Snapshot a plugin's install directory plus the profile files an install may rewrite. */
  async backupPlugin(input: {
    transactionId: string
    /** The resolved package directory (real filesystem path). */
    installDir: string
    /** Profile directory whose manifest files are snapshotted. */
    profileDir: string
  }): Promise<BackupResult> {
    const dir = await this.prepareDir(input.transactionId)
    const rootDir = join(dir, 'package')
    this.log?.info('backup.plugin.start', { transactionId: input.transactionId, installDir: input.installDir })
    const tree = await hashTree(input.installDir)
    await this.requireSpace(dir, tree.totalBytes)
    await copyTree(input.installDir, rootDir, this.retry)
    const copied = await hashTree(rootDir)
    const comparison = compareTreeManifests(tree, copied)
    if (!comparison.clean) {
      throw new Error(`备份复制校验失败：${describeComparison(comparison)}`)
    }
    const profile = await this.snapshotProfileFiles(input.profileDir, join(dir, 'profile'))
    const manifest: BackupManifest = {
      schema: 1,
      transactionId: input.transactionId,
      kind: 'plugin-bundle',
      createdAt: new Date().toISOString(),
      sourcePath: input.installDir,
      rootDir: 'package',
      tree,
      profile,
    }
    const manifestPath = join(dir, 'manifest.json')
    await writeJsonAtomicSafe(manifestPath, manifest)
    const result: BackupResult = {
      transactionId: input.transactionId,
      kind: 'plugin-bundle',
      dir,
      rootDir,
      manifestPath,
      manifest,
      fileCount: tree.files.length + tree.symlinks.length,
      totalBytes: tree.totalBytes,
    }
    this.log?.info('backup.plugin.completed', { transactionId: input.transactionId, files: result.fileCount, bytes: result.totalBytes })
    return result
  }

  /** Snapshot one skill directory. */
  async backupSkill(input: { transactionId: string; skillDir: string }): Promise<BackupResult> {
    const dir = await this.prepareDir(input.transactionId)
    const rootDir = join(dir, 'skill')
    this.log?.info('backup.skill.start', { transactionId: input.transactionId, skillDir: input.skillDir })
    const tree = await hashTree(input.skillDir)
    await this.requireSpace(dir, tree.totalBytes)
    await copyTree(input.skillDir, rootDir, this.retry)
    const copied = await hashTree(rootDir)
    const comparison = compareTreeManifests(tree, copied)
    if (!comparison.clean) {
      throw new Error(`技能目录备份复制校验失败：${describeComparison(comparison)}`)
    }
    const manifest: BackupManifest = {
      schema: 1,
      transactionId: input.transactionId,
      kind: 'skill',
      createdAt: new Date().toISOString(),
      sourcePath: input.skillDir,
      rootDir: 'skill',
      tree,
    }
    const manifestPath = join(dir, 'manifest.json')
    await writeJsonAtomicSafe(manifestPath, manifest)
    const result: BackupResult = {
      transactionId: input.transactionId,
      kind: 'skill',
      dir,
      rootDir,
      manifestPath,
      manifest,
      fileCount: tree.files.length + tree.symlinks.length,
      totalBytes: tree.totalBytes,
    }
    this.log?.info('backup.skill.completed', { transactionId: input.transactionId, files: result.fileCount })
    return result
  }

  /** Re-read a backup from disk and prove its content still matches its manifest. */
  async verify(result: BackupResult): Promise<BackupVerification> {
    const problems: string[] = []
    const manifest = await readJsonSafe<BackupManifest>(result.manifestPath)
    if (manifest === undefined) {
      return { ok: false, problems: ['备份清单文件缺失或无法读取'], fileCount: 0, totalBytes: 0 }
    }
    if (manifest.transactionId !== result.transactionId) problems.push('备份清单与事务标识不一致')
    const snapshotRoot = join(result.dir, manifest.rootDir)
    let observed: TreeManifest
    try {
      observed = await hashTree(snapshotRoot)
    } catch (error) {
      return { ok: false, problems: [`备份目录无法读取：${messageOf(error)}`], fileCount: 0, totalBytes: 0 }
    }
    const comparison = compareTreeManifests(manifest.tree, observed)
    if (!comparison.clean) problems.push(`备份内容与清单不一致：${describeComparison(comparison)}`)
    if (manifest.profile !== undefined) {
      for (const file of manifest.profile.files) {
        const snapshotPath = join(result.dir, 'profile', file.name)
        const checksum = await sha256File(snapshotPath).catch(() => undefined)
        if (checksum !== file.sha256) problems.push(`Profile 快照 ${file.name} 校验失败`)
      }
    }
    const fileCount = observed.files.length + observed.symlinks.length
    if (problems.length > 0) this.log?.warn('backup.verify.failed', { transactionId: result.transactionId, problems })
    return { ok: problems.length === 0, problems, fileCount, totalBytes: observed.totalBytes }
  }

  /**
   * Restore a plugin backup: write the verified install tree back to `liveDir`
   * and the snapshotted profile files back to the profile directory. The result
   * is verified by re-hashing the restored tree.
   */
  async restorePlugin(result: BackupResult, liveDir: string): Promise<RestoreReport> {
    const verification = await this.verify(result)
    if (!verification.ok) {
      return {
        ok: false,
        treeRestored: false,
        profileFilesRestored: [],
        profileFilesSkipped: [],
        problems: verification.problems,
      }
    }
    const treeReport = await this.restoreTree(result, liveDir)
    const manifest = result.manifest
    const profileFilesRestored: string[] = []
    const profileFilesSkipped: string[] = []
    const problems = [...treeReport.problems]
    if (manifest.profile !== undefined) {
      for (const file of manifest.profile.files) {
        try {
          const snapshotPath = join(result.dir, 'profile', file.name)
          const content = await readFile(snapshotPath)
          const current = await sha256File(join(manifest.profile.dir, file.name)).catch(() => undefined)
          if (current === file.sha256) continue
          await writeFileAtomicSafe(join(manifest.profile.dir, file.name), content)
          profileFilesRestored.push(file.name)
        } catch (error) {
          problems.push(`Profile 文件 ${file.name} 恢复失败：${messageOf(error)}`)
        }
      }
      for (const name of manifest.profile.missing) {
        profileFilesSkipped.push(name)
      }
    }
    const verifiedVersion = await readPackageVersion(liveDir)
    const ok = treeReport.treeRestored && problems.length === 0
    if (!ok) this.log?.warn('backup.restore.failed', { transactionId: result.transactionId, problems })
    return {
      ok,
      treeRestored: treeReport.treeRestored,
      profileFilesRestored,
      profileFilesSkipped,
      problems,
      ...(verifiedVersion === undefined ? {} : { verifiedVersion }),
    }
  }

  /** Restore a skill backup into its live directory and verify the result. */
  async restoreSkill(result: BackupResult, liveDir: string): Promise<RestoreReport> {
    const verification = await this.verify(result)
    if (!verification.ok) {
      return { ok: false, treeRestored: false, profileFilesRestored: [], profileFilesSkipped: [], problems: verification.problems }
    }
    const treeReport = await this.restoreTree(result, liveDir)
    return {
      ok: treeReport.treeRestored && treeReport.problems.length === 0,
      treeRestored: treeReport.treeRestored,
      profileFilesRestored: [],
      profileFilesSkipped: [],
      problems: treeReport.problems,
    }
  }

  /** Remove one backup directory (used only after a fully verified update). */
  async removeBackup(result: BackupResult): Promise<void> {
    await removeTree(result.dir, this.retry)
  }

  /**
   * Keep the newest `keep` transaction backups and remove older ones. Backups
   * named by `protectedIds` are never removed, whatever their age; the result
   * lists what was deleted so the caller can write one audit log line.
   */
  async pruneBackups(options: { keep: number; protectedIds?: ReadonlySet<string> }): Promise<{ removed: string[]; kept: number }> {
    const keep = Math.max(0, Math.floor(options.keep))
    const protectedIds = options.protectedIds ?? new Set<string>()
    let entries: Dirent[]
    try {
      entries = await readdir(this.backupRoot, { withFileTypes: true })
    } catch {
      return { removed: [], kept: 0 }
    }
    const candidates: Array<{ name: string; dir: string; at: number }> = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = join(this.backupRoot, entry.name)
      const info = await stat(dir).catch(() => undefined)
      if (info === undefined) continue
      // A backup's own manifest records when it was created; the directory
      // mtime is a sufficient ordering fallback for old or foreign directories.
      const manifest = await readJsonSafe<BackupManifest>(join(dir, 'manifest.json'))
      const created = manifest === undefined ? Number.NaN : Date.parse(manifest.createdAt)
      candidates.push({ name: entry.name, dir, at: Number.isFinite(created) ? created : info.mtimeMs })
    }
    candidates.sort((left, right) => right.at - left.at)
    const removed: string[] = []
    let kept = 0
    for (const [index, candidate] of candidates.entries()) {
      if (index < keep || protectedIds.has(candidate.name)) {
        kept += 1
        continue
      }
      try {
        await removeTree(candidate.dir, this.retry)
        removed.push(candidate.name)
      } catch (error) {
        this.log?.warn('backup.prune.failed', { transactionId: candidate.name, message: messageOf(error) })
      }
    }
    return { removed, kept }
  }

  /** Create a clean directory for one transaction backup. */
  private async prepareDir(transactionId: string): Promise<string> {
    const dir = this.dirFor(transactionId)
    await removeTree(dir, this.retry).catch(() => undefined)
    await ensureDirectory(dir)
    return dir
  }

  /** Refuse a backup when the volume cannot hold it (backup is worthless if it fills the disk). */
  private async requireSpace(dir: string, totalBytes: number): Promise<void> {
    const free = await readFreeBytes(dir)
    if (free === undefined) return
    const required = Math.ceil(totalBytes * 1.2) + 16 * 1024 * 1024
    if (free < required) {
      throw new Error(`备份空间不足：需要约 ${formatBytes(required)}，当前可用 ${formatBytes(free)}`)
    }
  }

  /** Copy the verified snapshot tree over the live directory. */
  private async restoreTree(result: BackupResult, liveDir: string): Promise<{ treeRestored: boolean; problems: string[] }> {
    const problems: string[] = []
    try {
      await ensureDirectory(dirname(liveDir))
      await removeTree(liveDir, this.retry)
      await copyTree(result.rootDir, liveDir, this.retry)
    } catch (error) {
      problems.push(`安装目录无法写回：${messageOf(error)}`)
      return { treeRestored: false, problems }
    }
    try {
      const observed = await hashTree(liveDir)
      const comparison = compareTreeManifests(result.manifest.tree, observed)
      if (!comparison.clean) problems.push(`恢复后的目录与备份不一致：${describeComparison(comparison)}`)
    } catch (error) {
      problems.push(`恢复后的目录无法校验：${messageOf(error)}`)
    }
    return { treeRestored: true, problems }
  }

  /** Copy each existing profile file into the backup and record its checksum. */
  private async snapshotProfileFiles(profileDir: string, snapshotDir: string): Promise<NonNullable<BackupManifest['profile']>> {
    await ensureDirectory(snapshotDir)
    const files: BackupSnapshotFile[] = []
    const missing: string[] = []
    for (const name of PROFILE_SNAPSHOT_FILES) {
      const source = join(profileDir, name)
      const info = await stat(source).catch(() => undefined)
      if (info === undefined || !info.isFile()) {
        missing.push(name)
        continue
      }
      const content = await readFile(source)
      const checksum = sha256Hex(content)
      await writeFileAtomicSafe(join(snapshotDir, name), content)
      const copied = await sha256File(join(snapshotDir, name))
      if (copied !== checksum) throw new Error(`Profile 文件快照校验失败：${name}`)
      files.push({ name, sha256: checksum, size: content.byteLength })
    }
    return { dir: profileDir, files, missing }
  }
}

/** Read the `version` field of `<dir>/package.json`, when available. */
export async function readPackageVersion(dir: string): Promise<string | undefined> {
  const manifest = await readJsonSafe<{ version?: unknown }>(join(dir, 'package.json'))
  return typeof manifest?.version === 'string' ? manifest.version : undefined
}

/** Human-readable diff summary. */
export function describeComparison(comparison: ManifestComparison): string {
  const parts: string[] = []
  if (comparison.added.length > 0) parts.push(`多出 ${String(comparison.added.length)} 个文件（${comparison.added.slice(0, 5).join('、')}）`)
  if (comparison.modified.length > 0) parts.push(`${String(comparison.modified.length)} 个文件内容不同（${comparison.modified.slice(0, 5).join('、')}）`)
  if (comparison.missing.length > 0) parts.push(`缺少 ${String(comparison.missing.length)} 个文件（${comparison.missing.slice(0, 5).join('、')}）`)
  return parts.join('；')
}

/** Format a byte count for Chinese user-facing messages. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小'
  if (bytes < 1024) return `${String(Math.ceil(bytes))} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = units[0] ?? 'KiB'
  for (const candidate of units) {
    unit = candidate
    if (value < 1024) break
    value /= 1024
  }
  return `${value.toFixed(1)} ${unit}`
}
