/**
 * Read-only repository discovery for the details dialog.
 *
 * This module never decides where updates come from and never performs network
 * requests. It only normalizes repository URLs that the inventory already
 * observed (install provenance, a verified skill source, or an installed
 * package.json declaration) and refuses to guess when those sources disagree.
 */
import type { ExtensionRecord, SourceInfo } from './types'

/** Where a repository address was observed. */
export type RepositoryOrigin = 'install' | 'skill-source' | 'manifest' | 'npm-package'

/** One conflicting repository observation, retained for the advanced section. */
export interface RepositoryConflict {
  origin: RepositoryOrigin
  /** Normalized project-home URL. */
  url: string
}

/** A repository URL normalized to a safe project-home HTTPS URL. */
export interface NormalizedRepository {
  /** Canonical project-home URL without a `.git` suffix or credentials. */
  url: string
  /** Short display form, e.g. `github.com/owner/repo`. */
  display: string
  host: string
  owner: string
  repo: string
  github: boolean
  platform: string
}

export interface GithubRepositoryView {
  kind: 'github'
  url: string
  display: string
  origin: RepositoryOrigin
  sourceLabel: string
  declared: boolean
  subdir?: string
  subdirUrl?: string
  commit?: string
}

export interface OtherRepositoryView {
  kind: 'other'
  url: string
  display: string
  platform: string
  origin: RepositoryOrigin
  sourceLabel: string
}

export interface NpmRepositoryView {
  kind: 'npm'
  /** The npm package page, never presented as a GitHub repository. */
  url: string
  display: string
  packageName: string
}

export interface ConflictRepositoryView {
  kind: 'conflict'
  conflicts: readonly RepositoryConflict[]
}

export interface NoRepositoryView {
  kind: 'none'
  reason: 'unverified' | 'no-declaration' | 'local-install' | 'missing'
}

export type RepositoryView =
  | GithubRepositoryView
  | OtherRepositoryView
  | NpmRepositoryView
  | ConflictRepositoryView
  | NoRepositoryView

interface Candidate extends NormalizedRepository {
  origin: RepositoryOrigin
}

const GITHUB_HOST = 'github.com'
const KNOWN_OTHER_HOSTS = new Set(['gitlab.com', 'bitbucket.org', 'codeberg.org', 'gitee.com'])
const GITHUB_PATH_SEGMENT = /^[A-Za-z0-9_.-]+$/u
const COMMIT_SHA = /^[0-9a-f]{7,40}$/iu

const ORIGIN_LABELS: Record<RepositoryOrigin, string> = {
  install: '原始安装来源',
  'skill-source': 'Skill 来源映射',
  manifest: '项目声明的仓库',
  'npm-package': 'npm 包页面',
}

const ORIGIN_PRIORITY: Record<RepositoryOrigin, number> = {
  install: 4,
  'skill-source': 3,
  manifest: 2,
  'npm-package': 1,
}

/** Parse and normalize a repository URL written by common package tools. */
export function normalizeRepositoryUrl(raw: string): NormalizedRepository | undefined {
  let text = raw.trim()
  if (text === '' || /[\u0000-\u001f\u007f\s]/u.test(text)) return undefined
  if (text.startsWith('git+')) text = text.slice(4)
  if (/^git@github\.com:/iu.test(text)) {
    const match = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(text)
    return match === null ? undefined : githubRepository(match[1] ?? '', match[2] ?? '')
  }
  if (/^github:/iu.test(text)) {
    const match = /^github:([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(text)
    return match === null ? undefined : githubRepository(match[1] ?? '', match[2] ?? '')
  }
  if (/^git@/iu.test(text)) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.password !== '') return undefined
  const ssh = url.protocol === 'ssh:'
  // `git@` is the conventional SSH user, not a credential; passwords or any
  // other userinfo are still rejected.
  if (url.username !== '' && !(ssh && url.username === 'git')) return undefined
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (url.protocol !== 'https:' && url.protocol !== 'ssh:') return undefined
  if (ssh && url.hostname.toLowerCase() !== GITHUB_HOST) return undefined
  const host = url.hostname.toLowerCase().replace(/^www\./u, '')
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  if (segments.length < 2) return undefined
  const owner = segments[0] ?? ''
  const repo = (segments[1] ?? '').replace(/\.git$/iu, '')
  if (host === GITHUB_HOST) return githubRepository(owner, repo)
  if (!KNOWN_OTHER_HOSTS.has(host)) return undefined
  if (!GITHUB_PATH_SEGMENT.test(owner) || !GITHUB_PATH_SEGMENT.test(repo) || owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined
  const base = `https://${host}/${owner}/${repo}`
  return {
    url: base,
    display: `${host}/${owner}/${repo}`,
    host,
    owner,
    repo,
    github: false,
    platform: host === 'gitlab.com' ? 'GitLab' : host === 'bitbucket.org' ? 'Bitbucket' : host === 'gitee.com' ? 'Gitee' : '代码仓库',
  }
}

function githubRepository(owner: string, repo: string): NormalizedRepository | undefined {
  const cleanOwner = owner.trim()
  const cleanRepo = repo.trim().replace(/\.git$/iu, '')
  if (cleanOwner === '' || cleanRepo === '') return undefined
  if (!GITHUB_PATH_SEGMENT.test(cleanOwner) || !GITHUB_PATH_SEGMENT.test(cleanRepo)) return undefined
  if (cleanOwner === '.' || cleanOwner === '..' || cleanRepo === '.' || cleanRepo === '..') return undefined
  return {
    url: `https://${GITHUB_HOST}/${cleanOwner}/${cleanRepo}`,
    display: `${GITHUB_HOST}/${cleanOwner}/${cleanRepo}`,
    host: GITHUB_HOST,
    owner: cleanOwner,
    repo: cleanRepo,
    github: true,
    platform: 'GitHub',
  }
}

/** Read the `repository` declaration of an installed package.json. */
export function parsePackageRepository(value: unknown): { url: string; directory?: string } | undefined {
  if (typeof value === 'string') {
    const url = value.trim()
    return url === '' ? undefined : { url }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.url !== 'string' || record.url.trim() === '') return undefined
  const directory = typeof record.directory === 'string' && record.directory.trim() !== '' ? record.directory.trim() : undefined
  return {
    url: record.url.trim(),
    ...(directory === undefined ? {} : { directory }),
  }
}

/** Whether a source kind is an install/source repository observation. */
function isInstallSource(kind: SourceInfo['kind']): boolean {
  return kind === 'git' || kind === 'github' || kind === 'skill-git' || kind === 'skill-lock'
}

function sourceOrigin(kind: SourceInfo['kind']): RepositoryOrigin {
  return kind === 'skill-lock' || kind === 'skill-git' ? 'skill-source' : 'install'
}

/** Resolve the one project repository worth linking, or an explicit non-link state. */
export function resolveRepository(record: Pick<ExtensionRecord, 'kind' | 'source'>): RepositoryView {
  const source = record.source
  const candidates: Candidate[] = []
  const add = (raw: string, origin: RepositoryOrigin): void => {
    const normalized = normalizeRepositoryUrl(raw)
    if (normalized === undefined) return
    if (candidates.some(candidate => candidate.host === normalized.host && candidate.owner.toLowerCase() === normalized.owner.toLowerCase() && candidate.repo.toLowerCase() === normalized.repo.toLowerCase())) return
    candidates.push({ ...normalized, origin })
  }

  if (isInstallSource(source.kind) && source.url !== undefined) add(source.url, sourceOrigin(source.kind))
  if (source.repo !== undefined && source.repo.trim() !== '') {
    add(`https://${GITHUB_HOST}/${source.repo.trim()}`, sourceOrigin(source.kind))
  }
  if (source.repository !== undefined) add(source.repository, 'manifest')

  if (candidates.length > 1) {
    return {
      kind: 'conflict',
      conflicts: candidates.map(candidate => ({ origin: candidate.origin, url: candidate.url })),
    }
  }
  const candidate = candidates[0]
  if (candidate === undefined) {
    if (record.kind === 'plugin-bundle' && source.kind === 'npm' && source.packageName !== undefined && source.packageName !== '') {
      const registryHost = registryHostname(source.registry)
      if (registryHost === undefined || registryHost === 'registry.npmjs.org' || registryHost === 'www.npmjs.com' || registryHost === 'npmjs.com') {
        return {
          kind: 'npm',
          url: `https://www.npmjs.com/package/${encodeURIComponent(source.packageName)}`,
          display: `npmjs.com/package/${source.packageName}`,
          packageName: source.packageName,
        }
      }
    }
    return { kind: 'none', reason: reasonForMissing(source) }
  }

  const sourceLabel = ORIGIN_LABELS[candidate.origin]
  alertSourcePriority(candidates)
  if (candidate.github) {
    const subdir = cleanSubdir(candidate.origin === 'manifest' ? source.repositoryDirectory : source.subdir)
    const commit = source.commit !== undefined && COMMIT_SHA.test(source.commit) ? source.commit : undefined
    const subdirUrl = subdir === undefined || commit === undefined
      ? undefined
      : `${candidate.url}/tree/${encodeURIComponent(commit)}/${subdir.split('/').map(segment => encodeURIComponent(segment)).join('/')}`
    return {
      kind: 'github',
      url: candidate.url,
      display: candidate.display,
      origin: candidate.origin,
      sourceLabel,
      declared: candidate.origin === 'manifest',
      ...(subdir === undefined ? {} : { subdir }),
      ...(subdirUrl === undefined ? {} : { subdirUrl }),
      ...(commit === undefined ? {} : { commit }),
    }
  }
  return {
    kind: 'other',
    url: candidate.url,
    display: candidate.display,
    platform: candidate.platform,
    origin: candidate.origin,
    sourceLabel,
  }
}

function alertSourcePriority(candidates: readonly Candidate[]): void {
  // Kept as a named step so the priority order is explicit: install/source
  // observations win over a package.json declaration only for labelling.
  const winner = [...candidates].sort((a, b) => ORIGIN_PRIORITY[b.origin] - ORIGIN_PRIORITY[a.origin])[0]
  if (winner === undefined) return
}

function cleanSubdir(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const segments = value.trim().replace(/\\/gu, '/').split('/').filter(segment => segment !== '')
  if (segments.length === 0 || segments.some(segment => segment === '.' || segment === '..')) return undefined
  return segments.join('/')
}

function registryHostname(registry: string | undefined): string | undefined {
  if (registry === undefined || registry.trim() === '') return undefined
  try {
    return new URL(registry).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

function reasonForMissing(source: SourceInfo): NoRepositoryView['reason'] {
  if (source.kind === 'local-link' || source.kind === 'local-path' || source.kind === 'tarball') return 'local-install'
  if (source.kind === 'npm') return 'no-declaration'
  if (source.kind === 'unknown' || source.kind === 'filesystem') return 'unverified'
  if (source.trust === 'unknown') return 'unverified'
  return 'missing'
}
