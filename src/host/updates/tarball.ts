/**
 * Minimal tar/gzip reader, safe extraction, git tree hashing and GitHub
 * codeload archive support.
 *
 * The updater needs two independent content answers before it may replace
 * anything:
 *   - npm tarballs: the published file list plus one SHA-256 per file, used to
 *     detect local modifications and to validate what pnpm installed;
 *   - GitHub codeload archives: the skill subtree's git tree SHA-1, which must
 *     equal the tree hash the update checker read from the GitHub API.
 *
 * Nothing here shells out to `tar`, `git` or `gzip`: the archive format is
 * parsed locally, every path is checked against traversal, entry count and
 * uncompressed size are bounded, and checksums are verified so a truncated or
 * tampered archive fails instead of installing silently.
 */
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { ProxyAgent, request } from 'undici'
import type { Dispatcher } from 'undici'
import { ensureDirectory, messageOf, retryFs, safeJoinInside, sha256Hex } from './backup.js'

/** One tar block is 512 bytes. */
const TAR_BLOCK = 512
/** Hard bounds protecting the Host from hostile or broken archives. */
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
export const MAX_ARCHIVE_ENTRIES = 200_000
/** Default HTTP timeouts and body bound for archive downloads. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000
const DEFAULT_MAX_DOWNLOAD_BYTES = 192 * 1024 * 1024

/** One parsed archive entry. `data` is present for regular files. */
export interface TarEntry {
  /** Normalized archive path (`/` separators, no leading `./`). */
  path: string
  type: 'file' | 'directory' | 'symlink' | 'hardlink' | 'other'
  /** Unix permission bits from the header. */
  mode: number
  size: number
  data?: Buffer
  /** Link target for symlink/hardlink entries. */
  linkTarget?: string
}

/** One file listed inside an npm tarball, relative to the package root. */
export interface NpmTarballFile {
  path: string
  size: number
  sha256: string
  mode: number
}

/** Parsed npm tarball. */
export interface NpmTarball {
  /** Archive entries as read (paths still carry the tarball prefix). */
  entries: TarEntry[]
  /** File list relative to the package root, sorted by path. */
  files: NpmTarballFile[]
  byPath: Map<string, NpmTarballFile>
  packageJson?: Record<string, unknown>
  name?: string
  version?: string
  totalBytes: number
}

/** Options for {@link readTarArchive}. */
export interface TarReadOptions {
  maxBytes?: number
  maxEntries?: number
  /** Verify the header checksum; corrupted archives are rejected when true (default). */
  verifyChecksum?: boolean
}

/** Options for {@link extractArchive}. */
export interface ExtractOptions {
  /** Archive path prefix whose content is extracted (`package/` for npm tarballs). */
  prefix?: string
  /** Skip tree-relative paths (applied after the prefix). */
  ignore?: (relativePath: string) => boolean
  maxFiles?: number
}

/** One file written by {@link extractArchive}. */
export interface ExtractedFile {
  path: string
  size: number
  sha256: string
}

/** Result of {@link extractArchive}. */
export interface ExtractedArchive {
  dir: string
  files: ExtractedFile[]
  directories: string[]
  totalBytes: number
}

/** Read one fixed-width string field, trimming NUL/space padding. */
function readString(field: Buffer): string {
  const end = field.indexOf(0)
  const slice = end === -1 ? field : field.subarray(0, end)
  return slice.toString('utf8').replace(/ +$/u, '')
}

/** Parse an octal field; GNU base-256 (high-bit set) values are supported for large sizes. */
function parseNumeric(field: Buffer, label: string): number {
  if (field.length === 0) return 0
  if ((field[0] ?? 0) >= 0x80) {
    // GNU base-256: big-endian positive integer, one's complement for negatives is not needed here.
    let value = 0
    for (const byte of field) value = value * 256 + byte
    return value
  }
  const text = readString(field).trim()
  if (text === '') return 0
  const parsed = Number.parseInt(text, 8)
  if (!Number.isFinite(parsed)) throw new Error(`tar 头字段 ${label} 无法解析`)
  return parsed
}

/** Normalize one archive path: `/` separators, strip `./`, strip trailing `/`. */
function normalizeArchivePath(input: string): string {
  let path = input.replace(/\\/gu, '/')
  while (path.startsWith('./')) path = path.slice(2)
  path = path.replace(/\/+$/u, '')
  return path
}

/** Header checksum: sum of all bytes with the checksum field read as spaces. */
function headerChecksum(header: Buffer): number {
  let sum = 0
  for (let index = 0; index < TAR_BLOCK; index += 1) {
    if (index >= 148 && index < 156) sum += 0x20
    else sum += header[index] ?? 0
  }
  return sum
}

/** Parse a PAX extended header payload into key/value records. */
function parsePaxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space === -1) break
    const length = Number.parseInt(data.subarray(offset, space).toString('utf8'), 10)
    if (!Number.isInteger(length) || length <= 0 || offset + length > data.length) break
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8')
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    offset += length
  }
  return records
}

/** Decompress gzip input when needed; plain tar buffers pass through. */
function decompress(input: Buffer, maxBytes: number): Buffer {
  const isGzip = input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b
  if (!isGzip) {
    if (input.byteLength > maxBytes) throw new Error('归档超过大小上限')
    return input
  }
  try {
    return gunzipSync(input, { maxOutputLength: maxBytes })
  } catch (error) {
    throw new Error(`gzip 解压失败（归档可能损坏或超过大小上限）：${messageOf(error)}`)
  }
}

/**
 * Parse a tar (optionally gzip-compressed) archive into entries.
 * PAX extended headers, GNU long names and base-256 sizes are supported.
 */
export function readTarArchive(input: Buffer, options: TarReadOptions = {}): TarEntry[] {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES
  const maxEntries = options.maxEntries ?? MAX_ARCHIVE_ENTRIES
  const verifyChecksum = options.verifyChecksum !== false
  const buffer = decompress(input, maxBytes)
  const entries: TarEntry[] = []
  let offset = 0
  let totalBytes = 0
  let pendingPath: string | undefined
  let pendingLinkTarget: string | undefined
  let pendingPax: Map<string, string> | undefined
  while (offset + TAR_BLOCK <= buffer.length) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK)
    // Two zero blocks end the archive; one is accepted for slightly truncated writers.
    if (header.every(byte => byte === 0)) break
    if (verifyChecksum) {
      const recorded = Number.parseInt(readString(header.subarray(148, 156)).trim() || '0', 8)
      if (!Number.isFinite(recorded) || recorded !== headerChecksum(header)) {
        throw new Error('tar 头校验失败（归档可能已损坏）')
      }
    }
    const nameField = readString(header.subarray(0, 100))
    const prefixField = readString(header.subarray(345, 500))
    const mode = parseNumeric(header.subarray(100, 108), 'mode')
    let size = parseNumeric(header.subarray(124, 136), 'size')
    const typeFlag = String.fromCharCode(header[156] ?? 0x30)
    const linkName = readString(header.subarray(157, 257))
    const payloadStart = offset + TAR_BLOCK
    if (size < 0 || payloadStart + size > buffer.length) throw new Error('tar 条目长度越界（归档可能已损坏）')
    const payload = size === 0 ? Buffer.alloc(0) : buffer.subarray(payloadStart, payloadStart + size)
    offset = payloadStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (typeFlag === 'x' || typeFlag === 'g') {
      // Extended header: records apply to the next regular entry.
      const records = parsePaxRecords(payload)
      if (typeFlag === 'x') pendingPax = records
      continue
    }
    if (typeFlag === 'L' || typeFlag === 'K') {
      // GNU long name / long link name.
      const value = payload.toString('utf8').replace(/\0+$/u, '')
      if (typeFlag === 'L') pendingPath = value
      else pendingLinkTarget = value
      continue
    }
    let path = pendingPax?.get('path') ?? pendingPath ?? (prefixField === '' ? nameField : `${prefixField}/${nameField}`)
    const linkTarget = pendingPax?.get('linkpath') ?? pendingLinkTarget ?? linkName
    const paxSize = pendingPax?.get('size')
    if (paxSize !== undefined) {
      const overridden = Number.parseInt(paxSize, 10)
      if (!Number.isInteger(overridden) || overridden < 0) throw new Error('tar 扩展头中的长度无效')
      // The payload was already carved with the header size; PAX sizes only
      // matter for entries whose header size could not hold the value.
      if (overridden > size) throw new Error('tar 扩展头声明的长度超过归档实际内容')
    }
    pendingPath = undefined
    pendingLinkTarget = undefined
    pendingPax = undefined
    path = normalizeArchivePath(path)
    if (path === '' || path === '.') continue
    if (entries.length >= maxEntries) throw new Error(`归档条目数量超过上限（${String(maxEntries)}）`)
    const type: TarEntry['type'] = typeFlag === '5' ? 'directory'
      : typeFlag === '2' ? 'symlink'
        : typeFlag === '1' ? 'hardlink'
          : typeFlag === '0' || typeFlag === '\0' ? 'file' : 'other'
    if (type === 'file') {
      totalBytes += size
      if (totalBytes > maxBytes) throw new Error('归档解压后大小超过上限')
      // Retain a private copy: `buffer` may be a view over a larger array.
      entries.push({ path, type, mode, size, data: Buffer.from(payload) })
      continue
    }
    entries.push({
      path,
      type,
      mode,
      size: 0,
      ...(linkTarget === '' ? {} : { linkTarget }),
    })
  }
  if (entries.length === 0) throw new Error('归档中没有可读取的条目')
  return entries
}

/**
 * Read an npm package tarball: strips the `package/` prefix, hashes every file
 * and exposes the package identity for validation.
 */
export function readNpmTarball(input: Buffer, options: { prefix?: string } = {}): NpmTarball {
  const prefix = (options.prefix ?? 'package/').replace(/\/*$/u, '/')
  const entries = readTarArchive(input)
  const files: NpmTarballFile[] = []
  const byPath = new Map<string, NpmTarballFile>()
  let totalBytes = 0
  let packageJson: Record<string, unknown> | undefined
  for (const entry of entries) {
    if (entry.type === 'directory') continue
    const fullPath = entry.path
    if (!fullPath.startsWith(prefix)) continue
    const relativePath = fullPath.slice(prefix.length)
    if (relativePath === '') continue
    if (entry.type !== 'file' || entry.data === undefined) {
      throw new Error(`npm 包中出现了不支持的条目类型：${entry.path}`)
    }
    if (byPath.has(relativePath)) throw new Error(`npm 包中出现了重复文件：${relativePath}`)
    const checksum = sha256Hex(entry.data)
    const file: NpmTarballFile = { path: relativePath, size: entry.size, sha256: checksum, mode: entry.mode }
    byPath.set(relativePath, file)
    files.push(file)
    totalBytes += entry.size
    if (relativePath === 'package.json') {
      try {
        const parsed = JSON.parse(entry.data.toString('utf8')) as unknown
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          packageJson = parsed as Record<string, unknown>
        }
      } catch {
        throw new Error('npm 包中的 package.json 无法解析')
      }
    }
  }
  if (byPath.size === 0) throw new Error('npm 包中没有文件（tarball 结构异常）')
  files.sort((left, right) => left.path.localeCompare(right.path))
  const name = typeof packageJson?.['name'] === 'string' ? packageJson['name'] : undefined
  const version = typeof packageJson?.['version'] === 'string' ? packageJson['version'] : undefined
  return {
    entries,
    files,
    byPath,
    ...(packageJson === undefined ? {} : { packageJson }),
    ...(name === undefined ? {} : { name }),
    ...(version === undefined ? {} : { version }),
    totalBytes,
  }
}

/** Trim an archive prefix (`sub/dir`) into the canonical `sub/dir/` form. */
function canonicalPrefix(prefix: string): string {
  const normalized = prefix.replace(/\\/gu, '/').replace(/^\.?\//u, '').replace(/\/+$/u, '')
  return normalized === '' ? '' : `${normalized}/`
}

/** Entries below one archive directory, with the prefix stripped. */
export function entriesUnder(entries: readonly TarEntry[], prefix: string): Array<TarEntry & { relativePath: string }> {
  const canonical = canonicalPrefix(prefix)
  const result: Array<TarEntry & { relativePath: string }> = []
  for (const entry of entries) {
    if (!entry.path.startsWith(canonical)) continue
    const relativePath = entry.path.slice(canonical.length)
    if (relativePath === '') continue
    result.push({ ...entry, relativePath })
  }
  return result
}

/** The single top-level directory of an archive (GitHub archives have one). */
export function archiveRoot(entries: readonly TarEntry[]): string | undefined {
  let root: string | undefined
  for (const entry of entries) {
    const segment = entry.path.split('/')[0]
    if (segment === undefined || segment === '') continue
    if (root === undefined) root = segment
    else if (root !== segment) return undefined
  }
  return root
}

/** One entry fed into the git tree hasher. */
export interface GitTreeInputEntry {
  /** Archive path; `stripPrefix` is removed before the tree is built. */
  path: string
  mode: '100644' | '100755' | '120000' | '40000'
  content: Buffer
}

/** The git blob object id for one content buffer. */
export function gitBlobHash(content: Buffer): string {
  return createHash('sha1').update(`blob ${String(content.length)}\0`).update(content).digest('hex')
}

/** The git tree object id over already-nested entries. */
function gitTreeHashFromNode(node: TreeNode): Buffer {
  interface TreeItem {
    name: string
    mode: string
    sha: Buffer
  }
  const items: TreeItem[] = []
  for (const [name, file] of node.files) items.push({ name, mode: file.mode, sha: file.sha })
  for (const [name, child] of node.children) items.push({ name, mode: '40000', sha: gitTreeHashFromNode(child) })
  // Git sorts tree entries by raw name bytes (not locale order).
  items.sort((left, right) => Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')))
  const parts: Buffer[] = []
  for (const item of items) {
    parts.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'), item.sha)
  }
  const body = Buffer.concat(parts)
  return createHash('sha1').update(`tree ${String(body.length)}\0`).update(body).digest()
}

/** Nested git tree node. */
interface TreeNode {
  files: Map<string, { mode: string; sha: Buffer }>
  children: Map<string, TreeNode>
}

function emptyTreeNode(): TreeNode {
  return { files: new Map(), children: new Map() }
}

/**
 * Compute the git tree SHA-1 of a directory subtree represented by archive
 * entries, matching the value the GitHub trees API returns for that directory.
 * Symlinks are hashed git-style (mode 120000, blob content = link target).
 */
export function gitTreeHashForEntries(entries: readonly TarEntry[], prefix: string): string {
  const root = emptyTreeNode()
  for (const item of entriesUnder(entries, prefix)) {
    const relativePath = item.relativePath.replace(/\/+$/u, '')
    if (relativePath === '') continue
    const segments = relativePath.split('/')
    let node = root
    for (const segment of segments.slice(0, -1)) {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = emptyTreeNode()
        node.children.set(segment, child)
      }
      node = child
    }
    const name = segments.at(-1)
    if (name === undefined || name === '') continue
    if (item.type === 'directory') {
      if (!node.children.has(name)) node.children.set(name, emptyTreeNode())
      continue
    }
    const content = item.type === 'symlink' ? Buffer.from(item.linkTarget ?? '', 'utf8') : item.data
    if (content === undefined) continue
    const mode = item.type === 'symlink' ? '120000' : (item.mode & 0o111) !== 0 ? '100755' : '100644'
    node.files.set(name, { mode, sha: Buffer.from(gitBlobHash(content), 'hex') })
  }
  return gitTreeHashFromNode(root).toString('hex')
}

/** Normalize an ignore match against a tree-relative path. */
function isIgnored(ignore: ((relativePath: string) => boolean) | undefined, relativePath: string): boolean {
  return ignore?.(relativePath) === true
}

/** Validate a symlink target stays inside the extraction root. */
function checkSymlinkTarget(destination: string, filePath: string, linkTarget: string): string {
  const normalized = linkTarget.replace(/\\/gu, '/')
  if (normalized === '' || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    throw new Error(`归档中的符号链接目标不安全：${filePath} → ${linkTarget}`)
  }
  const resolved = join(dirname(filePath), normalized)
  const relativePath = relative(destination, resolved)
  if (relativePath.startsWith('..') || relativePath.startsWith('/') || /^[A-Za-z]:/u.test(relativePath)) {
    throw new Error(`归档中的符号链接指向技能目录之外：${filePath} → ${linkTarget}`)
  }
  return linkTarget
}

/**
 * Extract an archive subtree into a fresh directory. Absolute paths, `..`
 * segments, duplicate paths, device nodes and symlinks escaping the root are
 * rejected; file writes retry transient Windows locks.
 */
export async function extractArchive(entries: readonly TarEntry[], destination: string, options: ExtractOptions = {}): Promise<ExtractedArchive> {
  const canonical = canonicalPrefix(options.prefix ?? '')
  const files: ExtractedFile[] = []
  const directories: string[] = []
  let totalBytes = 0
  const limit = options.maxFiles ?? MAX_ARCHIVE_ENTRIES
  await rm(destination, { recursive: true, force: true })
  await ensureDirectory(destination)
  const seen = new Set<string>()
  for (const entry of entries) {
    if (canonical !== '' && !entry.path.startsWith(canonical)) continue
    const rawRelative = canonical === '' ? entry.path : entry.path.slice(canonical.length)
    const relativePath = rawRelative.replace(/\/+$/u, '')
    if (relativePath === '') continue
    if (isIgnored(options.ignore, relativePath)) continue
    if (files.length + directories.length >= limit) throw new Error('归档条目数量超过提取上限')
    if (seen.has(relativePath)) throw new Error(`归档中出现了重复路径：${relativePath}`)
    seen.add(relativePath)
    const target = safeJoinInside(destination, relativePath)
    if (target === undefined) throw new Error(`归档条目路径越界（已被拒绝）：${relativePath}`)
    if (entry.type === 'directory') {
      await ensureDirectory(target)
      directories.push(relativePath)
      continue
    }
    await ensureDirectory(dirname(target))
    if (entry.type === 'file') {
      const data = entry.data
      if (data === undefined) throw new Error(`归档文件缺少内容：${relativePath}`)
      await retryFs(`write:${target}`, () => writeFile(target, data))
      files.push({ path: relativePath, size: data.byteLength, sha256: sha256Hex(data) })
      totalBytes += data.byteLength
      continue
    }
    if (entry.type === 'symlink') {
      const linkTarget = checkSymlinkTarget(destination, target, entry.linkTarget ?? '')
      await retryFs(`symlink:${target}`, async () => {
        await rm(target, { force: true }).catch(() => undefined)
        try {
          await symlink(linkTarget, target)
        } catch {
          await symlink(linkTarget, target, 'junction')
        }
      })
      files.push({ path: relativePath, size: Buffer.byteLength(linkTarget), sha256: sha256Hex(Buffer.from(linkTarget, 'utf8')) })
      continue
    }
    // Hardlinks and device nodes never occur in the supported archives; refusing
    // them is safer than guessing what they should point at.
    throw new Error(`不支持的归档条目类型（${entry.type}）：${relativePath}`)
  }
  if (files.length === 0) throw new Error('归档子目录中没有文件')
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { dir: destination, files, directories, totalBytes }
}

/** Compare an extracted tree against the archive file list it came from. */
export function compareExtractedFiles(
  extracted: readonly ExtractedFile[],
  expected: readonly NpmTarballFile[],
): { ok: boolean; added: string[]; modified: string[]; missing: string[] } {
  const expectedByPath = new Map(expected.map(file => [file.path, file]))
  const extractedByPath = new Map(extracted.map(file => [file.path, file]))
  const added: string[] = []
  const modified: string[] = []
  const missing: string[] = []
  for (const [path, file] of extractedByPath) {
    const wanted = expectedByPath.get(path)
    if (wanted === undefined) added.push(path)
    else if (wanted.sha256 !== file.sha256) modified.push(path)
  }
  for (const path of expectedByPath.keys()) if (!extractedByPath.has(path)) missing.push(path)
  return { ok: added.length === 0 && modified.length === 0 && missing.length === 0, added, modified, missing }
}

/** Failure of an archive download, classified for user-facing diagnostics. */
export class ArchiveFetchError extends Error {
  readonly kind: 'timeout' | 'network' | 'http' | 'too-large' | 'invalid-url'
  readonly status: number | undefined
  readonly url: string

  constructor(
    message: string,
    options: { kind: ArchiveFetchError['kind']; url: string; status?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ArchiveFetchError'
    this.kind = options.kind
    this.status = options.status
    this.url = options.url
  }
}

/** Options for {@link fetchArchive}. */
export interface ArchiveFetchOptions {
  signal?: AbortSignal
  timeoutMs?: number
  maxBytes?: number
  headers?: Record<string, string>
}

/** Read the proxy URL from the environment when the target host is not excluded. */
function proxyFor(url: URL): string | undefined {
  const env = process.env
  const raw = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (raw === undefined || raw === '') return undefined
  const noProxy = env.NO_PROXY ?? env.no_proxy
  if (noProxy !== undefined && noProxy !== '') {
    const hostname = url.hostname.toLowerCase()
    for (const rule of noProxy.split(',').map(item => item.trim()).filter(item => item !== '')) {
      if (rule === '*') return undefined
      const cleaned = rule.replace(/^\./u, '').toLowerCase()
      if (hostname === cleaned || hostname.endsWith(`.${cleaned}`)) return undefined
    }
  }
  return raw
}

/**
 * Download one URL into memory with a hard size bound, an explicit timeout and
 * proxy support from `HTTPS_PROXY`/`HTTP_PROXY` (honouring `NO_PROXY`).
 * Redirects are followed manually (at most five) so the dependency stays on the
 * stable `request` API of undici rather than an interceptor configuration.
 */
export async function fetchArchive(url: string, options: ArchiveFetchOptions = {}): Promise<Buffer> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ArchiveFetchError(`归档地址无效：${url}`, { kind: 'invalid-url', url })
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ArchiveFetchError(`归档地址必须使用 http(s)：${url}`, { kind: 'invalid-url', url })
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOWNLOAD_BYTES
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const external = options.signal
  const onExternalAbort = (): void => controller.abort(external?.reason)
  if (external !== undefined) {
    if (external.aborted) controller.abort(external.reason)
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }
  const proxy = proxyFor(parsed)
  let dispatcher: Dispatcher | undefined
  try {
    if (proxy !== undefined) {
      try {
        dispatcher = new ProxyAgent(proxy)
      } catch {
        dispatcher = undefined
      }
    }
    const requestHeaders = {
      'user-agent': 'dsh-extension-manager',
      accept: 'application/gzip, application/x-gzip, application/octet-stream, */*',
      ...options.headers,
    }
    let current = parsed
    let response: Awaited<ReturnType<typeof request>> | undefined
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const attempt = await request(current, {
        method: 'GET',
        headers: requestHeaders,
        ...(dispatcher === undefined ? {} : { dispatcher }),
        signal: controller.signal,
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      })
      const status = attempt.statusCode
      if (status >= 300 && status < 400) {
        const location = (attempt.headers as Record<string, string | string[] | undefined>).location
        const target = Array.isArray(location) ? location[0] : location
        attempt.body.destroy()
        if (target === undefined || target === '') {
          throw new ArchiveFetchError(`下载归档失败：HTTP ${String(status)} 未给出跳转地址`, {
            kind: 'http',
            url: current.href,
            status,
          })
        }
        if (redirects === 5) {
          throw new ArchiveFetchError('下载归档失败：跳转次数过多', { kind: 'http', url, status })
        }
        current = new URL(target, current)
        if (current.protocol !== 'https:' && current.protocol !== 'http:') {
          throw new ArchiveFetchError(`归档跳转到了不支持的地址：${current.href}`, { kind: 'invalid-url', url: current.href })
        }
        continue
      }
      response = attempt
      break
    }
    if (response === undefined) {
      throw new ArchiveFetchError('下载归档失败：没有取得响应', { kind: 'http', url })
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.body.destroy()
      throw new ArchiveFetchError(`下载归档失败：HTTP ${String(response.statusCode)}`, {
        kind: 'http',
        url: current.href,
        status: response.statusCode,
      })
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      received += buffer.length
      if (received > maxBytes) {
        response.body.destroy()
        throw new ArchiveFetchError(`归档超过大小上限（${String(maxBytes)} 字节）`, { kind: 'too-large', url })
      }
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  } catch (error) {
    if (error instanceof ArchiveFetchError) throw error
    if (timedOut) {
      throw new ArchiveFetchError(`下载归档超时（${String(timeoutMs)} 毫秒）`, { kind: 'timeout', url, cause: error })
    }
    if (external?.aborted === true) throw error
    throw new ArchiveFetchError(`下载归档失败：${messageOf(error)}`, { kind: 'network', url, cause: error })
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
    if (dispatcher !== undefined) {
      await (dispatcher as ProxyAgent).close().catch(() => undefined)
    }
  }
}

/** Parse `owner/repo` out of a GitHub URL or git spec. */
export function parseGithubRepo(input: string | undefined): string | undefined {
  if (input === undefined || input.trim() === '') return undefined
  const match = /github\.com[/:]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?]|$)/u.exec(input.trim())
  if (match === null) return undefined
  const owner = match[1]
  const repo = match[2]
  if (owner === undefined || repo === undefined || owner === '' || repo === '') return undefined
  return `${owner}/${repo}`
}

/** Build the GitHub codeload archive URL for one commit, branch or tag. */
export function githubCodeloadUrl(repo: string, ref: string): string {
  const trimmed = repo.trim().replace(/^\/+/u, '')
  const [owner, name] = trimmed.split('/')
  if (owner === undefined || owner === '' || name === undefined || name === '') {
    throw new Error(`GitHub 仓库标识无效：${repo}`)
  }
  const cleanName = name.endsWith('.git') ? name.slice(0, -4) : name
  if (ref.trim() === '') throw new Error('GitHub 归档缺少 ref（提交、分支或标签）')
  return `https://codeload.github.com/${owner}/${cleanName}/tar.gz/${encodeURIComponent(ref.trim())}`
}

/** Download a GitHub repository archive for one ref. */
export async function downloadGithubArchive(repo: string, ref: string, options: ArchiveFetchOptions = {}): Promise<Buffer> {
  return fetchArchive(githubCodeloadUrl(repo, ref), options)
}

/** Read the frontmatter `name` of a SKILL.md document (best effort, no YAML dependency). */
export function readFrontmatterName(content: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)
  if (match === null) return undefined
  const name = /^name:\s*['"]?([^'"\r\n#]+?)['"]?\s*$/mu.exec(match[1] ?? '')
  return name?.[1]?.trim()
}

/** Read a SKILL.md from disk without following anything unusual. */
export async function readSkillDocument(skillDir: string): Promise<{ path: string; name?: string } | undefined> {
  const path = join(skillDir, 'SKILL.md')
  try {
    const content = await readFile(path, 'utf8')
    const name = readFrontmatterName(content)
    return { path, ...(name === undefined ? {} : { name }) }
  } catch {
    return undefined
  }
}
