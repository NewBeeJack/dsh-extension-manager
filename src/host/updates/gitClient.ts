/**
 * Git-backed plugin provenance for update checks.
 *
 * Three responsibilities, all independent of the DSH runtime:
 *  - parse the git install specs pnpm/the profile manifest record (including
 *    GitHub/GitLab/Bitbucket web URLs and `owner/repo` shorthands);
 *  - read the resolution commit pnpm recorded in `pnpm-lock.yaml` (v6 and v9
 *    layouts) when the live bundle info does not carry one;
 *  - compare the installed commit with the remote ref using `git ls-remote`,
 *    bounded in time and cancellable through an AbortSignal.
 *
 * A remote lookup that failed is never reported as "up to date"; the caller
 * receives a typed failure kind instead.
 */
import { execFile } from 'node:child_process'
import semver from 'semver'
import { parse as parseYaml } from 'yaml'

/** Default bound for one `git ls-remote` invocation. */
export const DEFAULT_GIT_TIMEOUT_MS = 12_000

/** How the recorded ref must be interpreted. */
export type GitRefType = 'branch' | 'tag' | 'commit' | 'semver' | 'unknown'

/** One git install spec, read into the parts a check needs. */
export interface GitSpec {
  /** The spec as recorded (dependency value from `package.json`). */
  spec: string
  /** URL git commands receive (no `#ref` fragment). */
  url: string
  /** Recognized hosting provider, when the URL names one. */
  provider?: 'github' | 'gitlab' | 'bitbucket'
  /** Hostname, when one is derivable. */
  host?: string
  /** `owner/repo`, when the URL has that shape. */
  repo?: string
  /** Requested ref (branch, tag, or commit) from the `#` fragment. */
  ref?: string
  /** How `ref` must be interpreted. */
  refType?: GitRefType
  /** Repository-relative directory holding the package (monorepo case). */
  subdir?: string
  /** Human-facing web URL, when known. */
  webUrl?: string
}

/** A recognized git host URL split into owner/repo plus optional tree location. */
export interface ParsedGitHostUrl {
  provider: 'github' | 'gitlab' | 'bitbucket'
  host: string
  owner: string
  repo: string
  /** Ref from a `/tree/<ref>` (GitHub/GitLab) or `/src/<ref>` (Bitbucket) URL. */
  ref?: string
  /** Directory after the ref in a tree URL. */
  subdir?: string
  webUrl: string
  cloneUrl: string
}

const KNOWN_GIT_HOSTS: Readonly<Record<string, 'github' | 'gitlab' | 'bitbucket'>> = {
  'github.com': 'github',
  'www.github.com': 'github',
  'gitlab.com': 'gitlab',
  'www.gitlab.com': 'gitlab',
  'bitbucket.org': 'bitbucket',
  'www.bitbucket.org': 'bitbucket',
}

/** Whether a value looks like a full or abbreviated git commit id. */
export function isCommitRef(ref: string | undefined): boolean {
  return ref !== undefined && /^[0-9a-f]{7,40}$/iu.test(ref)
}

/** Whether a ref names a decorated version (so the candidate is a tag). */
export function isTagRef(ref: string | undefined): boolean {
  return ref !== undefined && semver.valid(ref.trim()) !== null
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function stripGitSuffix(repo: string): string {
  return repo.replace(/\.git$/iu, '')
}

/**
 * Parse a GitHub/GitLab/Bitbucket web URL, including `/tree/<ref>/<subdir>`
 * locations, into a clone URL plus the ref/directory they name.
 */
export function parseGitHostUrl(raw: string | undefined): ParsedGitHostUrl | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (!/^https?:\/\//iu.test(trimmed)) return undefined
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  const provider = KNOWN_GIT_HOSTS[host]
  if (provider === undefined) return undefined
  const segments = url.pathname.split('/').filter(segment => segment !== '').map(decodeSegment)
  const owner = segments[0]
  const repo = segments[1]
  if (owner === undefined || repo === undefined) return undefined
  const repoName = stripGitSuffix(repo)
  const webUrl = `https://${host}/${owner}/${repoName}`
  const cloneUrl = `${webUrl}.git`
  let ref: string | undefined
  let subdir: string | undefined
  if (provider === 'github' && (segments[2] === 'tree' || segments[2] === 'blob') && segments[3] !== undefined) {
    ref = segments[3]
    subdir = segments.slice(4).join('/')
  } else if (provider === 'gitlab' && segments[2] === '-' && segments[3] === 'tree' && segments[4] !== undefined) {
    ref = segments[4]
    subdir = segments.slice(5).join('/')
  } else if (provider === 'bitbucket' && segments[2] === 'src' && segments[3] !== undefined) {
    ref = segments[3]
    subdir = segments.slice(4).join('/')
  }
  return {
    provider,
    host,
    owner,
    repo: repoName,
    webUrl,
    cloneUrl,
    ...(ref === undefined || ref === '' ? {} : { ref }),
    ...(subdir === undefined || subdir === '' ? {} : { subdir }),
  }
}

function refTypeOf(ref: string): GitRefType {
  if (isCommitRef(ref)) return 'commit'
  if (isTagRef(ref)) return 'tag'
  return 'branch'
}

/**
 * Parse one recorded git spec. Accepts every form pnpm/DSH record:
 * `github:owner/repo#ref`, `git+https://…`, `git+ssh://…`, `ssh://…`,
 * `git://…`, scp-like `git@host:owner/repo.git`, plain `https://host/owner/repo`
 * (with optional `/tree/<ref>` location), and an `owner/repo` shorthand.
 * Returns `undefined` for anything that is not a git spec.
 */
export function parseGitSpec(raw: string | undefined): GitSpec | undefined {
  if (raw === undefined) return undefined
  const original = raw.trim()
  if (original === '') return undefined
  let spec = original.startsWith('git+') ? original.slice(4) : original
  const hashIndex = spec.indexOf('#')
  const baseRaw = hashIndex === -1 ? spec : spec.slice(0, hashIndex)
  let fragment = hashIndex === -1 ? undefined : spec.slice(hashIndex + 1)
  let ref: string | undefined
  let refType: GitRefType | undefined
  let subdir: string | undefined
  if (fragment !== undefined) {
    if (fragment.startsWith('path:')) {
      subdir = fragment.slice('path:'.length).replace(/^\/+/u, '')
      fragment = undefined
    }
    if (fragment !== undefined && fragment.startsWith('semver:')) {
      ref = fragment.slice('semver:'.length).trim()
      refType = 'semver'
    } else if (fragment !== undefined && fragment.trim() !== '') {
      ref = decodeSegment(fragment.trim())
      refType = refTypeOf(ref)
    }
  }
  // Provider shorthand: github:owner/repo, github:owner/repo.git
  const shorthand = /^(github|gitlab|bitbucket):(.+)$/iu.exec(baseRaw)
  if (shorthand !== null) {
    const provider = shorthand[1]?.toLowerCase() as 'github' | 'gitlab' | 'bitbucket'
    const host = `${provider}.com`
    const rest = (shorthand[2] ?? '').replace(/^\/+/u, '').replace(/\/+$/u, '')
    const pair = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(rest)
    if (pair === null) return undefined
    const owner = pair[1] ?? ''
    const repo = stripGitSuffix(pair[2] ?? '')
    return {
      spec: original,
      url: `https://${host}/${owner}/${repo}.git`,
      provider,
      host,
      repo: `${owner}/${repo}`,
      webUrl: `https://${host}/${owner}/${repo}`,
      ...(ref === undefined ? {} : { ref }),
      ...(refType === undefined ? {} : { refType }),
      ...(subdir === undefined ? {} : { subdir }),
    }
  }
  // Web URLs: parse the tree location first so `#ref` can override it.
  const hostUrl = parseGitHostUrl(baseRaw)
  if (hostUrl !== undefined) {
    const effectiveRef = ref ?? hostUrl.ref
    const effectiveRefType = ref !== undefined
      ? refType ?? refTypeOf(ref)
      : hostUrl.ref === undefined ? undefined : refTypeOf(hostUrl.ref)
    const effectiveSubdir = subdir ?? hostUrl.subdir
    return {
      spec: original,
      url: hostUrl.cloneUrl,
      provider: hostUrl.provider,
      host: hostUrl.host,
      repo: `${hostUrl.owner}/${hostUrl.repo}`,
      webUrl: hostUrl.webUrl,
      ...(effectiveRef === undefined ? {} : { ref: effectiveRef }),
      ...(effectiveRefType === undefined ? {} : { refType: effectiveRefType }),
      ...(effectiveSubdir === undefined ? {} : { subdir: effectiveSubdir }),
    }
  }
  // scp-like: git@github.com:owner/repo.git
  const scp = /^git@([^:/\\]+):(.+)$/u.exec(baseRaw)
  if (scp !== null) {
    const host = (scp[1] ?? '').toLowerCase()
    const path = scp[2] ?? ''
    const segments = path.replace(/^\/+/u, '').split('/').filter(segment => segment !== '')
    const provider = KNOWN_GIT_HOSTS[host]
    const owner = segments[0]
    const repo = segments[1]
    return {
      spec: original,
      url: baseRaw,
      host,
      ...(provider === undefined ? {} : { provider }),
      ...(owner === undefined || repo === undefined ? {} : { repo: `${owner}/${stripGitSuffix(repo)}` }),
      ...(ref === undefined ? {} : { ref }),
      ...(refType === undefined ? {} : { refType }),
      ...(subdir === undefined ? {} : { subdir }),
    }
  }
  // `git:host/path` is pnpm's shorthand for an https clone URL.
  if (baseRaw.startsWith('git:') && !baseRaw.startsWith('git://')) {
    return parseGitSpec(`https://${baseRaw.slice('git:'.length)}${ref === undefined ? '' : `#${ref}`}`)
  }
  // ssh://, git://, https://, file:// clone URLs.
  const cloneUrl = /^[a-z][a-z0-9+.-]*:\/\//iu.test(baseRaw) ? baseRaw : undefined
  if (cloneUrl !== undefined) {
    let host: string | undefined
    try {
      const parsed = new URL(cloneUrl)
      host = parsed.hostname.toLowerCase()
    } catch {
      host = undefined
    }
    return {
      spec: original,
      url: cloneUrl,
      ...(host === undefined || host === '' ? {} : { host }),
      ...(host === undefined || KNOWN_GIT_HOSTS[host] === undefined ? {} : { provider: KNOWN_GIT_HOSTS[host] }),
      ...(ref === undefined ? {} : { ref }),
      ...(refType === undefined ? {} : { refType }),
      ...(subdir === undefined ? {} : { subdir }),
    }
  }
  // `owner/repo` shorthand (pnpm treats it as GitHub).
  const barePair = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(baseRaw)
  if (barePair !== null && !baseRaw.startsWith('@')) {
    const owner = barePair[1] ?? ''
    const repo = stripGitSuffix(barePair[2] ?? '')
    return {
      spec: original,
      url: `https://github.com/${owner}/${repo}.git`,
      provider: 'github',
      host: 'github.com',
      repo: `${owner}/${repo}`,
      webUrl: `https://github.com/${owner}/${repo}`,
      ...(ref === undefined ? {} : { ref }),
      ...(refType === undefined ? {} : { refType }),
      ...(subdir === undefined ? {} : { subdir }),
    }
  }
  return undefined
}

/** One git resolution read from a pnpm lockfile. */
export interface LockfileGitResolution {
  /** Package name the resolution belongs to. */
  name: string
  /** Exact installed commit. */
  commit: string
  /** Repository URL recorded by pnpm, when present. */
  repo?: string
  /** Requested ref recorded by pnpm, when present. */
  ref?: string
  /** Package directory inside a monorepo, when present. */
  path?: string
  /** The importer specifier (what `package.json` recorded). */
  specifier?: string
}

const FORTY_HEX = /(?:[#/])([0-9a-f]{40})(?:[?#/]|$)/iu

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Extract a 40-hex commit id from a lockfile version/spec text. */
function commitFromText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const match = FORTY_HEX.exec(text)
  if (match?.[1] !== undefined) return match[1].toLowerCase()
  const bare = /(?:^|[^0-9a-f])([0-9a-f]{40})(?:[^0-9a-f]|$)/iu.exec(text)
  return bare?.[1] === undefined ? undefined : bare[1].toLowerCase()
}

/** Split a lockfile snapshot key (`@scope/name@1.2.3`, `/name@1.2.3`) into name and version text. */
export function splitLockfileKey(key: string): { name: string; version: string } | undefined {
  const text = key.startsWith('/') ? key.slice(1) : key
  if (text === '') return undefined
  const at = text.startsWith('@') ? text.indexOf('@', 1) : text.indexOf('@')
  if (at <= 0) return { name: text, version: '' }
  return { name: text.slice(0, at), version: text.slice(at + 1) }
}

/** Recorded ref from a pnpm specifier such as `github:owner/repo#v1.2.3`. */
function refFromSpecifier(specifier: string | undefined): string | undefined {
  if (specifier === undefined) return undefined
  const hash = specifier.indexOf('#')
  if (hash === -1) return undefined
  const fragment = specifier.slice(hash + 1)
  if (fragment.startsWith('path:')) return undefined
  if (fragment.startsWith('semver:')) {
    const range = fragment.slice('semver:'.length).trim()
    return range === '' ? undefined : range
  }
  const ref = fragment.trim()
  // A recorded commit is the resolution itself, not the ref that should be compared.
  if (ref === '' || isCommitRef(ref)) return undefined
  return ref
}

function mergeResolution(
  into: Map<string, LockfileGitResolution>,
  name: string,
  patch: Partial<LockfileGitResolution> & { commit: string },
): void {
  const existing = into.get(name)
  if (existing === undefined) {
    into.set(name, {
      name,
      commit: patch.commit,
      ...(patch.repo === undefined ? {} : { repo: patch.repo }),
      ...(patch.ref === undefined ? {} : { ref: patch.ref }),
      ...(patch.path === undefined ? {} : { path: patch.path }),
      ...(patch.specifier === undefined ? {} : { specifier: patch.specifier }),
    })
    return
  }
  if (existing.repo === undefined && patch.repo !== undefined) existing.repo = patch.repo
  if (existing.ref === undefined && patch.ref !== undefined) existing.ref = patch.ref
  if (existing.path === undefined && patch.path !== undefined) existing.path = patch.path
  if (existing.specifier === undefined && patch.specifier !== undefined) existing.specifier = patch.specifier
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/**
 * Read every git resolution recorded in one pnpm lockfile (v6 and v9 layouts):
 * importer version strings plus the `packages`/`snapshots` resolution blocks.
 * A malformed or non-lockfile document yields an empty list.
 */
export function parseLockfileGitResolutions(lockfileText: string): LockfileGitResolution[] {
  let document: unknown
  try {
    document = parseYaml(lockfileText)
  } catch {
    return []
  }
  const root = asRecord(document)
  if (root === undefined) return []
  const found = new Map<string, LockfileGitResolution>()
  // Importer entries carry the resolved version/spec; lockfile v5 records the
  // dependencies directly on the root document.
  const importers = asRecord(root.importers)
  const importerDocs: Array<{ label: string; record: Record<string, unknown> }> = []
  if (importers !== undefined) {
    for (const [label, value] of Object.entries(importers)) {
      const record = asRecord(value)
      if (record !== undefined) importerDocs.push({ label, record })
    }
  } else {
    importerDocs.push({ label: '.', record: root })
  }
  for (const importer of importerDocs) {
    for (const sectionName of DEPENDENCY_SECTIONS) {
      const section = asRecord(importer.record[sectionName])
      if (section === undefined) continue
      for (const [name, value] of Object.entries(section)) {
        const entry = typeof value === 'string' ? undefined : asRecord(value)
        const version = typeof value === 'string' ? value : stringField(entry, 'version')
        const specifier = stringField(entry, 'specifier')
        const ref = refFromSpecifier(specifier) ?? refFromSpecifier(version)
        const commit = commitFromText(version) ?? commitFromText(specifier)
        if (commit === undefined) continue
        mergeResolution(found, name, {
          commit,
          ...(ref === undefined ? {} : { ref }),
          ...(specifier === undefined ? {} : { specifier }),
        })
      }
    }
  }
  // Package/snapshot blocks carry the authoritative `resolution` object.
  for (const sectionName of ['packages', 'snapshots'] as const) {
    const section = asRecord(root[sectionName])
    if (section === undefined) continue
    for (const [key, value] of Object.entries(section)) {
      const split = splitLockfileKey(key)
      if (split === undefined) continue
      const entry = asRecord(value)
      const resolution = asRecord(entry?.resolution)
      const versionText = split.version
      const resolutionText = [
        stringField(resolution, 'commit') ?? '',
        stringField(resolution, 'tarball') ?? '',
        stringField(resolution, 'repo') ?? '',
        versionText,
      ].join(' ')
      const commit = stringField(resolution, 'commit') ?? commitFromText(versionText) ?? commitFromText(stringField(resolution, 'tarball'))
      if (commit === undefined) continue
      const type = stringField(resolution, 'type')
      const looksGit = type === 'git'
        || /(?:^|\s)(?:git\+|git:|github:|gitlab:|bitbucket:|git@|https?:\/\/[^\s]+\.git)/iu.test(resolutionText)
        || /codeload\.github\.com|github\.com\//iu.test(resolutionText)
        || stringField(resolution, 'repo') !== undefined
      if (!looksGit) continue
      const repo = stringField(resolution, 'repo')
      const packagePath = stringField(resolution, 'path') ?? stringField(resolution, 'directory')
      const ref = refFromSpecifier(versionText)
      mergeResolution(found, split.name, {
        commit: commit.toLowerCase(),
        ...(repo === undefined ? {} : { repo }),
        ...(packagePath === undefined ? {} : { path: packagePath }),
        ...(ref === undefined ? {} : { ref }),
      })
    }
  }
  return [...found.values()]
}

/** The git resolution for one package, when the lockfile records it. */
export function parseLockfileGitResolution(lockfileText: string, packageName: string): LockfileGitResolution | undefined {
  return parseLockfileGitResolutions(lockfileText).find(entry => entry.name === packageName)
}

/** Failure kinds `resolveRemoteCommit` can report. */
export type GitRemoteFailureKind = 'git-missing' | 'not-found' | 'network' | 'timeout' | 'aborted' | 'invalid'

/** One remote-ref lookup request. */
export interface RemoteRefRequest {
  /** Clone URL git can fetch (`https://…git`, `ssh://…`, `git@host:owner/repo.git`, or a local path). */
  url: string
  /** Requested branch/tag/commit. Absent means the remote's default `HEAD`. */
  ref?: string
  /** How to interpret `ref`; default `unknown` (heads first, then tags). */
  refType?: GitRefType
}

/** Result of comparing a local install with the remote ref. */
export type RemoteCommitResult =
  | {
    ok: true
    commit: string
    /** The full remote ref that answered, e.g. `refs/heads/main`. */
    refName?: string
    /** Tag version when the ref was a decorated version tag. */
    version?: string
  }
  | { ok: false; kind: GitRemoteFailureKind; message: string }

interface GitCommandSuccess {
  ok: true
  stdout: string
  stderr: string
}

type GitCommandResult = GitCommandSuccess | { ok: false; kind: GitRemoteFailureKind; message: string }

/** First meaningful line of git output, for a compact diagnostic. */
function firstOutputLine(output: string): string {
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== '')
  const errorLine = lines.find(line => /fatal:|error:|could not|unable to|denied/iu.test(line))
  return (errorLine ?? lines[0] ?? '').slice(0, 300)
}

/** Classify a failed `git` run from its exit facts and output. */
function classifyGitFailure(
  error: unknown,
  signal: AbortSignal | undefined,
  output: string,
  timeoutMs: number,
): { ok: false; kind: GitRemoteFailureKind; message: string } {
  if (signal?.aborted === true) return { ok: false, kind: 'aborted', message: 'git 查询已取消' }
  const facts = error as { code?: string | number; killed?: boolean; signal?: string; message?: string }
  if (facts.code === 'ENOENT') {
    return { ok: false, kind: 'git-missing', message: '本机未安装 git（在 PATH 中找不到 git 可执行文件）' }
  }
  if (facts.killed === true || facts.signal === 'SIGTERM' || facts.signal === 'SIGKILL') {
    return { ok: false, kind: 'timeout', message: `git 查询超过 ${String(timeoutMs)}ms 未完成` }
  }
  const text = output.toLowerCase()
  if (/not found|does not appear to be a git repository|could not read from remote repository|repository not found|unknown revision|invalid refspec|no matching refs|not our ref|no such ref/iu.test(text)) {
    return { ok: false, kind: 'not-found', message: firstOutputLine(output) === '' ? '远端仓库找不到指定的 ref' : firstOutputLine(output) }
  }
  if (/could not resolve host|connection refused|connection timed out|network is unreachable|failed to connect|operation timed out|unable to access|ssl|tls|proxy|econnrefused|etimedout|enotfound/iu.test(text)) {
    return { ok: false, kind: 'network', message: firstOutputLine(output) === '' ? '无法连接 git 远端仓库' : firstOutputLine(output) }
  }
  const message = firstOutputLine(output) || String(facts.message ?? '')
  return { ok: false, kind: 'invalid', message: message === '' ? 'git 查询失败' : message }
}

/** Run one `git` command with a timeout and an optional AbortSignal. */
function runGit(
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<GitCommandResult> {
  return new Promise<GitCommandResult>((resolve) => {
    let settled = false
    const settle = (result: GitCommandResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const callback = (error: Error | null, stdout: string, stderr: string): void => {
      if (error === null) {
        settle({ ok: true, stdout, stderr })
        return
      }
      settle(classifyGitFailure(error, options.signal, `${stdout}\n${stderr}`, options.timeoutMs))
    }
    try {
      execFile('git', [...args], {
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        // Never let a remote that asks for credentials block the check on a prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      }, callback)
    } catch (error) {
      settle(classifyGitFailure(error, options.signal, String(error), options.timeoutMs))
    }
  })
}

interface RemoteRef {
  sha: string
  refName: string
  peeled: boolean
}

/** Parse `git ls-remote` output lines (`<sha>\t<ref>`). */
export function parseLsRemoteOutput(stdout: string): RemoteRef[] {
  const refs: RemoteRef[] = []
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const tab = trimmed.indexOf('\t')
    const sha = tab === -1 ? '' : trimmed.slice(0, tab).trim()
    const refName = tab === -1 ? '' : trimmed.slice(tab + 1).trim()
    if (!/^[0-9a-f]{40}$/iu.test(sha) || refName === '') continue
    refs.push({ sha: sha.toLowerCase(), refName, peeled: refName.endsWith('^{}') })
  }
  return refs
}

function tagVersionOf(refName: string): string | undefined {
  const match = /^refs\/tags\/(.+?)(?:\^\{\})?$/u.exec(refName)
  if (match?.[1] === undefined) return undefined
  const version = semver.valid(match[1])
  return version === null ? undefined : version
}

/** Effective commit per ref: a peeled tag line (`^{}`) wins over the tag object. */
function effectiveRefs(refs: readonly RemoteRef[]): Map<string, RemoteRef> {
  const map = new Map<string, RemoteRef>()
  for (const ref of refs) {
    const key = ref.refName.replace(/\^\{\}$/u, '')
    const existing = map.get(key)
    if (existing === undefined || ref.peeled) map.set(key, ref)
  }
  return map
}

interface ChosenRef {
  commit: string
  refName: string
  version?: string
}

/** Pick the ref that answers the request from one ls-remote answer set. */
function chooseRemoteRef(refs: readonly RemoteRef[], request: RemoteRefRequest): ChosenRef | undefined {
  const effective = effectiveRefs(refs)
  const entries = [...effective.values()]
  if (request.ref === undefined || request.ref.trim() === '') {
    const head = entries.find(ref => ref.refName === 'HEAD')
    return head === undefined ? undefined : { commit: head.sha, refName: head.refName }
  }
  const ref = request.ref.trim()
  const heads = `refs/heads/${ref}`
  const tags = `refs/tags/${ref}`
  const exactHead = entries.find(entry => entry.refName === heads)
  const exactTag = entries.find(entry => entry.refName === tags)
  const preferTag = request.refType === 'tag' || request.refType === 'semver'
  const primary = preferTag ? exactTag ?? exactHead : exactHead ?? exactTag
  if (primary !== undefined) {
    const version = tagVersionOf(primary.refName)
    return {
      commit: primary.sha,
      refName: primary.refName,
      ...(version === undefined ? {} : { version }),
    }
  }
  // git also accepts tail patterns (`main` matches refs/heads/main); take the
  // first ref that ends with the requested name.
  const tail = entries.find(entry => entry.refName === ref || entry.refName.endsWith(`/${ref}`))
  if (tail === undefined) return undefined
  const version = tagVersionOf(tail.refName)
  return {
    commit: tail.sha,
    refName: tail.refName,
    ...(version === undefined ? {} : { version }),
  }
}

/** For `#semver:<range>` installs: pick the highest remote tag satisfying the range. */
function chooseSemverTag(refs: readonly RemoteRef[], range: string): ChosenRef | { error: string } {
  const effective = effectiveRefs(refs)
  const candidates: Array<{ version: string; commit: string; refName: string }> = []
  for (const entry of effective.values()) {
    const version = tagVersionOf(entry.refName)
    if (version !== undefined) candidates.push({ version, commit: entry.sha, refName: entry.refName })
  }
  if (candidates.length === 0) return { error: '远端仓库没有任何语义化版本标签' }
  let best: string | null
  try {
    best = semver.maxSatisfying(candidates.map(candidate => candidate.version), range, { includePrerelease: true })
  } catch {
    return { error: `无法解析 semver 范围：${range}` }
  }
  if (best === null) return { error: `远端没有任何标签满足 semver 范围 ${range}` }
  const chosen = candidates.find(candidate => candidate.version === best)
  if (chosen === undefined) return { error: `远端没有任何标签满足 semver 范围 ${range}` }
  return { commit: chosen.commit, refName: chosen.refName, version: chosen.version }
}

/**
 * Ask the remote repository which commit a ref points at.
 *
 * A pinned commit ref is answered locally (there is nothing to ask). A
 * `#semver:<range>` ref resolves to the highest matching remote tag. Everything
 * else runs one bounded `git ls-remote`; the workspace checkout is never
 * touched.
 */
export async function resolveRemoteCommit(
  request: RemoteRefRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RemoteCommitResult> {
  const url = request.url.trim()
  if (url === '') return { ok: false, kind: 'invalid', message: 'Git 仓库地址为空' }
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  // A pinned commit is already the requested state: there is nothing to ask.
  if (request.refType === 'commit' && isCommitRef(request.ref) && request.ref !== undefined) {
    return { ok: true, commit: request.ref.toLowerCase(), refName: request.ref }
  }
  if (request.refType === 'semver' && request.ref !== undefined) {
    const listing = await runGit(['ls-remote', '--tags', '--', url], { timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (!listing.ok) return listing
    const chosen = chooseSemverTag(parseLsRemoteOutput(listing.stdout), request.ref)
    if ('error' in chosen) return { ok: false, kind: 'not-found', message: chosen.error }
    return { ok: true, commit: chosen.commit, refName: chosen.refName, ...(chosen.version === undefined ? {} : { version: chosen.version }) }
  }
  const args: string[] = ['ls-remote', '--', url]
  if (request.ref === undefined || request.ref.trim() === '') {
    args.push('HEAD')
  } else if (request.ref.startsWith('refs/')) {
    args.push(request.ref)
  } else {
    args.push(`refs/heads/${request.ref}`, `refs/tags/${request.ref}`)
  }
  const listing = await runGit(args, { timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) })
  if (!listing.ok) return listing
  const refs = parseLsRemoteOutput(listing.stdout)
  if (refs.length === 0) {
    return {
      ok: false,
      kind: 'not-found',
      message: request.ref === undefined ? '远端仓库没有返回默认分支 HEAD' : `远端仓库找不到 ref ${request.ref}`,
    }
  }
  const chosen = chooseRemoteRef(refs, request)
  if (chosen === undefined) {
    return { ok: false, kind: 'not-found', message: `远端仓库找不到 ref ${request.ref ?? 'HEAD'}` }
  }
  return {
    ok: true,
    commit: chosen.commit,
    refName: chosen.refName,
    ...(chosen.version === undefined ? {} : { version: chosen.version }),
  }
}
