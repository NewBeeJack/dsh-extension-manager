/**
 * Skill roots, SKILL.md frontmatter parsing and git-object analysis.
 *
 * This module is deliberately Context-free: it only reads the local
 * filesystem and computes deterministic values. The inventory layer reads the
 * live `skill-filesystem` provider configuration from the Cordis Loader and
 * passes the resolved values in; the update checker reuses the same git tree
 * algorithm for its remote comparison. Everything here is synchronous or
 * plain async filesystem work so tests can drive it with temporary fixtures.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { lstat, readFile, readdir, readlink, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Diagnostic } from '../../shared/types'

/** Root ranks used by the DSH filesystem skill provider (lower wins). */
export const SKILL_RANKS = {
  projectDsh: 100,
  projectAgents: 200,
  custom: 300,
  userDsh: 400,
  userAgents: 500,
  bundled: 600,
} as const

/** Rank given to a managed copy whose root carries no rank (never the DSH case). */
const FALLBACK_MANAGED_RANK = 1_000

/** Environment variables and defaults the DSH home helpers use. */
const DSH_HOME_ENV = 'DSH_HOME'
const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/** File name of the manifest inside a directory-bundle skill. */
export const SKILL_MANIFEST_FILE = 'SKILL.md'

/** Public kebab-case skill-name grammar used by the DSH registry. */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** Non-managed skill roots on this machine, in display order. */
export const EXTERNAL_SKILL_ROOTS: ReadonlyArray<{ key: string; label: string; segments: readonly string[] }> = [
  { key: 'external-codex', label: 'Codex 技能目录（DSH 未托管）', segments: ['.codex', 'skills'] },
  { key: 'external-claude', label: 'Claude 技能目录（DSH 未托管）', segments: ['.claude', 'skills'] },
  { key: 'external-copilot', label: 'Copilot 技能目录（DSH 未托管）', segments: ['.copilot', 'skills'] },
  { key: 'external-cursor', label: 'Cursor 技能目录（DSH 未托管）', segments: ['.cursor', 'skills'] },
]

/** Invocation policy parsed from frontmatter. */
export interface SkillInvocationPolicy {
  modelInvocable: boolean
  userInvocable: boolean
}

/** Provider configuration resolved from the running Loader / ConfigEditor. */
export interface SkillProviderSettings {
  providerName: string
  includeDefaultRoots: boolean
  dshHome: string
  agentsHome: string
  customSkillDirs: readonly string[]
  bundledSkillDir?: string
  /** Where the values came from, for diagnostics only. */
  source: 'config-editor' | 'loader' | 'defaults'
  notes: readonly string[]
}

/** One readable workspace registration (`ctx.workspaceRegistry.list()`). */
export interface RegisteredWorkspaceLike {
  id?: string
  name?: string
  path: string
}

/** Kinds of skill roots the manager distinguishes. */
export type SkillRootKind =
  | 'project-dsh'
  | 'project-agents'
  | 'custom'
  | 'user-dsh'
  | 'user-agents'
  | 'bundled'
  | 'workspace'
  | 'external'

/** One root directory that may contain skills. */
export interface SkillRootSpec {
  key: string
  label: string
  path: string
  /** DSH filesystem-provider rank; absent for non-managed roots. */
  rank?: number
  /** Whether the running DSH filesystem provider scans this root. */
  managed: boolean
  kind: SkillRootKind
  /** Skip the reserved `.system` directory (DSH semantics for user roots). */
  skipSystem?: boolean
  /** Workspace registration that owns a project root, when known. */
  workspaceId?: string
  /** Root derived from the runtime catalog instead of the Loader configuration. */
  synthetic?: boolean
  /** Extra explanation shown in diagnostics. */
  note?: string
}

/** Everything root resolution needs; no Context is involved. */
export interface RootResolutionInput {
  /** Directory whose project roots are scanned (the selected workspace). */
  workspacePath: string
  /** Profile home (DSH home) used when the provider config carries no override. */
  dshHome: string
  /** OS user home; base of the non-managed external roots. */
  userHome: string
  settings: SkillProviderSettings
  /** Workspace registrations other than the selected one (informational roots). */
  registeredWorkspaces?: readonly RegisteredWorkspaceLike[]
  /** Selected workspace identity for diagnostics. */
  workspace?: { id?: string; name?: string }
}

/** Result of resolving all roots for one workspace. */
export interface RootResolution {
  workspacePath: string
  projectRoot: string
  roots: SkillRootSpec[]
  diagnostics: Diagnostic[]
}

/** One skill found by a filesystem scan. */
export interface DiscoveredSkill {
  rootKey: string
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  layout: 'directory' | 'flat-file'
  /** Absolute path of the parsed manifest file. */
  manifestPath: string
  /** Lexical directory the discovery entry lives in (through any alias/junction). */
  lexicalDir: string
  /** Canonical path of the manifest, used for runtime-catalog comparison. */
  realPath: string
  /** Absolute resource directory (the bundle directory or the flat-file root). */
  dir: string
  /** Directory-entry name, which may differ from the frontmatter name. */
  entryName: string
  metadata?: Record<string, unknown>
}

/** Result of scanning one root directory. */
export interface RootDiscovery {
  skills: DiscoveredSkill[]
  diagnostics: Diagnostic[]
  /** False when the root could not be read completely. */
  complete: boolean
}

/** Persisted frontmatter view of one skill. */
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  metadata?: Record<string, unknown>
}

/** Parse outcome for one SKILL.md document. */
export type SkillParseResult =
  | { ok: true; skill: ParsedSkill; body: string }
  | { ok: false; diagnostic: Diagnostic }

/** One entry of `~/.agents/.skill-lock.json`. */
export interface SkillLockEntry {
  source?: string
  sourceType?: string
  sourceUrl?: string
  skillPath?: string
  skillFolderHash?: string
  ref?: string
  installedAt?: string
  updatedAt?: string
}

/** Parsed `~/.agents/.skill-lock.json` document. */
export interface SkillLockFile {
  version: number
  skills: Record<string, SkillLockEntry>
}

/** GitHub repository identity parsed from a URL. */
export interface GitHubRepositoryRef {
  owner: string
  repo: string
}

/** One object-store entry while assembling a git tree hash. */
interface TreeEntry {
  /** Sort key (`name/` for directories, matching Git's tree ordering). */
  sortKey: string
  /** Raw tree record prefix (`<mode> <name>\0`). */
  header: Buffer
  sha: string
}

/** Result of hashing a skill folder the way Git hashes a tree object. */
export interface TreeHashResult {
  /** 40-hex git tree id, empty when an error was reported. */
  sha: string
  files: number
  bytes: number
  /** Blob ids by POSIX-style relative path (bounded by `maxFiles`). */
  fileHashes: Record<string, string>
  error?: string
}

/** Repository information read from `.git` files, without spawning git. */
export interface GitRepositoryInfo {
  root: string
  gitDir: string
  remoteUrl?: string
  branch?: string
  commit?: string
}

/** Working-tree modification state for one repository path. */
export interface GitWorktreeStatus {
  state: 'clean' | 'modified' | 'unknown'
  files: string[]
  error?: string
}

/** Identity of one physical skill copy for override / runtime linking. */
export interface PhysicalSkillIdentity {
  id: string
  name: string
  rootKey: string
  rank?: number
  managed: boolean
  /** Canonical absolute manifest path. */
  realPath: string
  manifestPath: string
  dir: string
}

/** Shadowing answer for a set of physical copies of the same names. */
export interface OverrideResolution {
  /** Copies that win their name inside the managed root ordering. */
  effective: Set<string>
  /** Losing copy id → winning copy path. */
  shadowedBy: Map<string, string>
  /** Winning copy id → losing copies it overrides. */
  overriddenCopies: Map<string, Array<{ rootKey: string; path: string }>>
  diagnostics: Diagnostic[]
}

/** Runtime catalog summary as read from `ctx.skills.snapshot()`. */
export interface RuntimeSkillSummary {
  name: string
  description: string
  path?: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
  provider?: string
  source?: string
}

/** Union of the runtime catalog observations this process could make. */
export interface RuntimeCatalog {
  available: boolean
  complete: boolean
  skills: readonly RuntimeSkillSummary[]
  /** Observation labels the union was built from. */
  observations: readonly string[]
  errors: readonly string[]
}

/** Association between the physical list and the runtime list. */
export interface RuntimeLink {
  /** Physical copy ids that are the winning runtime candidate for their name. */
  effective: Set<string>
  /** Physical copy ids the runtime catalog actually exposes. */
  loaded: Set<string>
  /** Losing copy id → runtime path/provider that shadows it. */
  shadowedBy: Map<string, string>
  /** Runtime skills with no physical copy in any scanned root. */
  virtual: RuntimeSkillSummary[]
  /** Runtime skill names represented by some physical copy. */
  representedNames: Set<string>
  diagnostics: Diagnostic[]
}

/** Compare two strings by UTF-16 code unit, like the DSH registry does. */
function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Strip a trailing separator so path comparison is stable. */
export function tidyPath(value: string): string {
  return value.replace(/[\\/]+$/u, '')
}

/** Expand the `~`, `~/` and `~\` prefixes against the OS home. */
export function expandHomePath(value: string, userHome: string = homedir()): string {
  if (value === '~') return userHome
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(userHome, value.slice(2))
  return value
}

/**
 * Resolve one root path from an explicit setting, then an environment
 * variable, then a default — the precedence the DSH home helpers use.
 */
export function resolveHomeRoot(configured: string | undefined, envName: string, fallback: string): string {
  const fromEnv = process.env[envName]
  const selected = configured !== undefined && configured !== ''
    ? configured
    : fromEnv !== undefined && fromEnv.trim().length > 0
      ? fromEnv
      : fallback
  return resolve(expandHomePath(selected))
}

/** Canonicalize an existing path; missing paths fall back to `resolve()`. */
export function canonicalPath(value: string): string {
  const absolute = resolve(value)
  try {
    return tidyPath(realpathSync(absolute))
  } catch {
    return tidyPath(absolute)
  }
}

/** Compare two paths for identity on the current platform. */
export function samePath(left: string, right: string): boolean {
  const a = tidyPath(left).replaceAll('\\', '/')
  const b = tidyPath(right).replaceAll('\\', '/')
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/** Normalize a path into a case-folded comparison key. */
function comparisonKey(value: string): string {
  const normalized = tidyPath(value).replaceAll('\\', '/').replace(/\/+$/u, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Public case-folded path key used to join filesystem and runtime records. */
export function skillPathKey(value: string): string {
  return comparisonKey(value)
}

/** Find the nearest ancestor holding a `.git` entry; `start` when none. */
export function findProjectRootSync(startDir: string): string {
  let current = resolve(startDir)
  while (true) {
    const gitEntry = join(current, '.git')
    if (existsSync(gitEntry)) return current
    const parent = dirname(current)
    if (parent === current) {
      // No repository: the provider's own fallback is the working directory.
      return resolve(startDir)
    }
    current = parent
  }
}

/** Build the managed + non-managed root list for one workspace. */
export function resolveSkillRoots(input: RootResolutionInput): RootResolution {
  const diagnostics: Diagnostic[] = []
  const settings = input.settings
  const workspacePath = tidyPath(resolve(input.workspacePath))
  const projectRoot = findProjectRootSync(workspacePath)
  const roots: SkillRootSpec[] = []
  if (settings.includeDefaultRoots) {
    roots.push(
      {
        key: 'project-dsh',
        label: '当前工作区 · .dsh/skills',
        path: tidyPath(join(projectRoot, '.dsh', 'skills')),
        rank: SKILL_RANKS.projectDsh,
        managed: true,
        kind: 'project-dsh',
      },
      {
        key: 'project-agents',
        label: '当前工作区 · .agents/skills',
        path: tidyPath(join(projectRoot, '.agents', 'skills')),
        rank: SKILL_RANKS.projectAgents,
        managed: true,
        kind: 'project-agents',
      },
    )
  }
  const customSeen = new Set<string>()
  settings.customSkillDirs.forEach((raw, index) => {
    const path = canonicalPath(expandHomePath(raw))
    if (customSeen.has(comparisonKey(path))) return
    customSeen.add(comparisonKey(path))
    const name = basename(path)
    roots.push({
      key: `custom:${name === '' ? String(index) : name}`,
      label: `自定义技能根（${path}）`,
      path,
      rank: SKILL_RANKS.custom,
      managed: true,
      kind: 'custom',
    })
  })
  if (settings.includeDefaultRoots) {
    roots.push(
      {
        key: 'user-dsh',
        label: `DSH 用户技能目录（${settings.dshHome}）`,
        path: tidyPath(join(settings.dshHome, 'skills')),
        rank: SKILL_RANKS.userDsh,
        managed: true,
        kind: 'user-dsh',
        skipSystem: true,
      },
      {
        key: 'user-agents',
        label: `共享 Agent 技能目录（${settings.agentsHome}）`,
        path: tidyPath(join(settings.agentsHome, 'skills')),
        rank: SKILL_RANKS.userAgents,
        managed: true,
        kind: 'user-agents',
      },
    )
  }
  if (settings.bundledSkillDir !== undefined && settings.bundledSkillDir !== '') {
    roots.push({
      key: 'bundled',
      label: '随 DSH 提供的技能目录',
      path: canonicalPath(expandHomePath(settings.bundledSkillDir)),
      rank: SKILL_RANKS.bundled,
      managed: true,
      kind: 'bundled',
    })
  }
  // Registered workspaces other than the selected one: their project roots are
  // managed by DSH whenever that workspace becomes the active cwd, so they are
  // listed (and scanned) but usually inactive for the current run.
  const otherWorkspaces = (input.registeredWorkspaces ?? [])
    .filter(workspace => !samePath(workspace.path, workspacePath))
    .slice(0, 12)
  for (const workspace of otherWorkspaces) {
    const target = tidyPath(resolve(workspace.path))
    const workspaceRoot = findProjectRootSync(target)
    const identity = workspace.id ?? workspace.name ?? basename(target)
    const projectRoots: ReadonlyArray<{ suffix: 'project-dsh' | 'project-agents'; rank: number; segment: string }> = [
      { suffix: 'project-dsh', rank: SKILL_RANKS.projectDsh, segment: '.dsh' },
      { suffix: 'project-agents', rank: SKILL_RANKS.projectAgents, segment: '.agents' },
    ]
    for (const projectRootSpec of projectRoots) {
      const path = tidyPath(join(workspaceRoot, projectRootSpec.segment, 'skills'))
      if (!existsSync(path)) continue
      roots.push({
        key: `workspace:${identity}:${projectRootSpec.suffix}`,
        label: `已注册工作区「${workspace.name ?? basename(target)}」· ${projectRootSpec.segment}/skills`,
        path,
        rank: projectRootSpec.rank,
        managed: true,
        kind: 'workspace',
        ...(workspace.id === undefined ? {} : { workspaceId: workspace.id }),
        note: '该工作区当前未激活，扫描结果仅用于展示本机已安装技能。',
      })
    }
  }
  // Non-managed roots: installed for other agent tools, never served by DSH.
  for (const external of EXTERNAL_SKILL_ROOTS) {
    const path = tidyPath(join(input.userHome, ...external.segments))
    if (!existsSync(path)) continue
    roots.push({
      key: external.key,
      label: external.label,
      path,
      managed: false,
      kind: 'external',
      skipSystem: true,
    })
  }
  // Identical directories can appear under several root identities (for
  // example when the workspace itself is the user home). The provider would
  // scan the same directory twice; the inventory merges them so one physical
  // copy is counted once, keeping the highest-priority identity.
  const deduped: SkillRootSpec[] = []
  const byPath = new Map<string, SkillRootSpec>()
  for (const root of roots) {
    const key = comparisonKey(root.path)
    const existing = byPath.get(key)
    if (existing === undefined) {
      byPath.set(key, root)
      deduped.push(root)
      continue
    }
    const existingRank = existing.rank ?? FALLBACK_MANAGED_RANK
    const nextRank = root.rank ?? FALLBACK_MANAGED_RANK
    const replace = (root.managed && !existing.managed) || (root.managed === existing.managed && nextRank < existingRank)
    diagnostics.push({
      level: 'info',
      code: 'skill-root/duplicate',
      message: `技能根重复：${root.path} 已由「${existing.label}」表示，忽略「${root.label}」`,
      detail: { kept: existing.key, dropped: root.key },
    })
    if (replace) {
      const index = deduped.indexOf(existing)
      if (index !== -1) deduped[index] = root
      byPath.set(key, root)
    }
  }
  deduped.sort((left, right) => {
    const rankDiff = (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER)
    return rankDiff !== 0 ? rankDiff : compareCodePoints(left.key, right.key)
  })
  if (!settings.includeDefaultRoots) {
    diagnostics.push({
      level: 'info',
      code: 'skill-root/default-roots-disabled',
      message: '运行时 skill-filesystem 配置关闭了默认根（includeDefaultRoots=false），项目根与用户根不会生效。',
    })
  }
  return { workspacePath, projectRoot, roots: deduped, diagnostics }
}

/** Read one text file, reporting absence instead of throwing. */
async function readTextIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Whether an error means "the path does not exist". */
function isAbsentError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

/** Classify one directory entry without following symlinks blindly. */
async function classifyEntry(fullPath: string, directory: boolean, file: boolean, symlink: boolean): Promise<'directory' | 'file' | undefined> {
  if (directory) return 'directory'
  if (file) return 'file'
  if (!symlink) return undefined
  try {
    const info = await stat(fullPath)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return undefined
  } catch (error) {
    if (isAbsentError(error)) return undefined
    throw error
  }
}

/** Absolute canonical path for a manifest that may be behind a symlink. */
function canonicalManifestPath(path: string): string {
  return canonicalPath(path)
}

/** Discover every skill bundle / flat markdown file inside one root. */
export async function discoverRoot(root: SkillRootSpec): Promise<RootDiscovery> {
  const diagnostics: Diagnostic[] = []
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if (isAbsentError(error)) return { skills: [], diagnostics, complete: true }
    diagnostics.push({
      level: 'warning',
      code: 'skill-root/unreadable',
      message: `无法读取技能根「${root.label}」：${error instanceof Error ? error.message : String(error)}`,
      detail: { rootKey: root.key, path: root.path },
    })
    return { skills: [], diagnostics, complete: false }
  }
  const sorted = [...entries].sort((left, right) => compareCodePoints(left.name, right.name))
  const skills: DiscoveredSkill[] = []
  for (const entry of sorted) {
    if (root.skipSystem === true && entry.name === '.system') continue
    const fullPath = join(root.path, entry.name)
    let kind: 'directory' | 'file' | undefined
    try {
      kind = await classifyEntry(fullPath, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink())
    } catch (error) {
      diagnostics.push({
        level: 'warning',
        code: 'skill-entry/unreadable',
        message: `无法读取技能条目 ${entry.name}：${error instanceof Error ? error.message : String(error)}`,
        detail: { rootKey: root.key, path: fullPath },
      })
      continue
    }
    if (kind === undefined) continue
    if (kind === 'file' && !entry.name.endsWith('.md')) continue
    const manifestPath = kind === 'directory' ? join(fullPath, SKILL_MANIFEST_FILE) : fullPath
    const resourceDir = kind === 'directory' ? fullPath : root.path
    const raw = await readTextIfPresent(manifestPath)
    if (raw === undefined) {
      if (kind === 'directory') continue // No SKILL.md: not a skill bundle.
      diagnostics.push({
        level: 'warning',
        code: 'skill-entry/unreadable',
        message: `技能文件无法读取：${entry.name}`,
        detail: { rootKey: root.key, path: manifestPath },
      })
      continue
    }
    const parsed = parseSkillMarkdown(raw, manifestPath)
    if (!parsed.ok) {
      diagnostics.push(parsed.diagnostic)
      continue
    }
    const skill = parsed.skill
    skills.push({
      rootKey: root.key,
      name: skill.name,
      description: skill.description,
      ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
      invocation: skill.invocation,
      layout: kind === 'directory' ? 'directory' : 'flat-file',
      manifestPath,
      lexicalDir: resourceDir,
      realPath: canonicalManifestPath(manifestPath),
      dir: canonicalPath(resourceDir),
      entryName: entry.name,
      ...(skill.metadata === undefined ? {} : { metadata: skill.metadata }),
    })
  }
  return { skills, diagnostics, complete: true }
}

/** Split raw markdown into YAML frontmatter data and body, CRLF-safe. */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/u, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const yamlText = raw.slice(start, closing.start)
  const parsed: unknown = parseYaml(yamlText)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

/** Locate the `---` line that closes the frontmatter block. */
function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/u, '')
    if (line === '---') return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

/** One required/optional non-empty string frontmatter field. */
function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/** Parse one frontmatter boolean (`true/false/1/0/yes/no/on/off`). */
function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': return true
      case 'false': case 'no': case 'off': return false
      default: break
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/** Reject the legacy camelCase invocation keys the DSH parser rejects. */
function rejectLegacyInvocationKey(data: Record<string, unknown>, legacy: string, canonical: string): void {
  if (Object.hasOwn(data, legacy)) {
    throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
  }
}

/** Resolve the invocation policy exactly like the DSH filesystem provider. */
export function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  rejectLegacyInvocationKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

/** Read an optional plain metadata object from the frontmatter. */
function optionalMetadata(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = data.metadata
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Parse one SKILL.md / flat markdown document into a skill or a diagnostic. */
export function parseSkillMarkdown(raw: string, manifestPath: string): SkillParseResult {
  let frontmatter: { data: Record<string, unknown>; body: string } | undefined
  try {
    frontmatter = parseFrontmatter(raw)
  } catch (error) {
    return {
      ok: false,
      diagnostic: invalidSkillDiagnostic(manifestPath, 'skill/invalid-yaml', `技能文件的 YAML frontmatter 无效：${error instanceof Error ? error.message : String(error)}`),
    }
  }
  if (frontmatter === undefined) {
    return { ok: false, diagnostic: invalidSkillDiagnostic(manifestPath, 'skill/missing-frontmatter', '技能文件缺少 YAML frontmatter') }
  }
  const data = frontmatter.data
  const name = stringField(data, 'name')
  if (name === undefined) {
    return { ok: false, diagnostic: invalidSkillDiagnostic(manifestPath, 'skill/missing-name', '技能 frontmatter 缺少 name 字段') }
  }
  if (!SKILL_NAME_PATTERN.test(name.trim())) {
    return {
      ok: false,
      diagnostic: invalidSkillDiagnostic(manifestPath, 'skill/invalid-name', `技能 name 不是 kebab-case：${name}`),
    }
  }
  const description = stringField(data, 'description')
  if (description === undefined) {
    return { ok: false, diagnostic: invalidSkillDiagnostic(manifestPath, 'skill/missing-description', '技能 frontmatter 缺少 description 字段') }
  }
  let invocation: SkillInvocationPolicy
  try {
    invocation = parseInvocationPolicy(data)
  } catch (error) {
    return {
      ok: false,
      diagnostic: invalidSkillDiagnostic(manifestPath, 'skill/invalid-invocation', `技能调用策略无效：${error instanceof Error ? error.message : String(error)}`),
    }
  }
  const whenToUse = stringField(data, 'whenToUse')
  const metadata = optionalMetadata(data)
  return {
    ok: true,
    skill: {
      name: name.trim(),
      description,
      ...(whenToUse === undefined ? {} : { whenToUse }),
      invocation,
      ...(metadata === undefined ? {} : { metadata }),
    },
    body: frontmatter.body,
  }
}

/** Build one user-facing diagnostic for an invalid skill file. */
function invalidSkillDiagnostic(manifestPath: string, code: string, message: string): Diagnostic {
  return { level: 'warning', code, message, detail: { path: manifestPath } }
}

/** Parse a `~/.agents/.skill-lock.json` document. */
export function parseSkillLock(text: string): { lock?: SkillLockFile; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    return {
      diagnostics: [{
        level: 'warning',
        code: 'skill-lock/invalid-json',
        message: `技能锁文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      }],
    }
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { diagnostics: [{ level: 'warning', code: 'skill-lock/invalid-document', message: '技能锁文件结构不是对象' }] }
  }
  const record = document as Record<string, unknown>
  const rawSkills = record.skills
  if (typeof rawSkills !== 'object' || rawSkills === null || Array.isArray(rawSkills)) {
    return { diagnostics: [{ level: 'warning', code: 'skill-lock/missing-skills', message: '技能锁文件缺少 skills 对象' }] }
  }
  const skills: Record<string, SkillLockEntry> = {}
  for (const [name, value] of Object.entries(rawSkills as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      diagnostics.push({ level: 'warning', code: 'skill-lock/invalid-entry', message: `技能锁文件条目 ${name} 结构无效`, detail: { name } })
      continue
    }
    const entry = value as Record<string, unknown>
    const pick = (field: string): string | undefined => typeof entry[field] === 'string' && entry[field] !== '' ? entry[field] as string : undefined
    const parsedEntry: SkillLockEntry = {}
    const assign = (field: keyof SkillLockEntry): void => {
      const picked = pick(field)
      if (picked !== undefined) parsedEntry[field] = picked
    }
    for (const field of ['source', 'sourceType', 'sourceUrl', 'skillPath', 'skillFolderHash', 'ref', 'installedAt', 'updatedAt'] as const) {
      assign(field)
    }
    skills[name] = parsedEntry
  }
  const version = typeof record.version === 'number' ? record.version : 0
  if (version !== 3) {
    diagnostics.push({
      level: 'info',
      code: 'skill-lock/unknown-version',
      message: `技能锁文件版本为 ${String(version)}（管理器的验证针对 v3 设计，字段按兼容方式读取）`,
    })
  }
  return { lock: { version, skills }, diagnostics }
}

/** Read `~/.agents/.skill-lock.json`; absence is not an error. */
export async function readSkillLockFile(agentsHome: string): Promise<{ path: string; lock?: SkillLockFile; error?: string }> {
  const path = join(agentsHome, '.skill-lock.json')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return { path }
  }
  const parsed = parseSkillLock(text)
  if (parsed.lock === undefined) {
    const message = parsed.diagnostics.map(item => item.message).join('；')
    return { path, ...(message === '' ? {} : { error: message }) }
  }
  return { path, lock: parsed.lock }
}

/** Look up one installed skill in the lock file (by name, then by path). */
export function findSkillLockEntry(lock: SkillLockFile | undefined, name: string): SkillLockEntry | undefined {
  if (lock === undefined) return undefined
  const direct = lock.skills[name]
  if (direct !== undefined) return direct
  for (const entry of Object.values(lock.skills)) {
    if (entry.skillPath === undefined) continue
    const segments = entry.skillPath.split(/[\\/]/u).filter(segment => segment !== '')
    const parent = segments[segments.length - 2]
    if (parent === name) return entry
  }
  return undefined
}

/** Repository-relative directory holding the skill described by a lock entry. */
export function lockEntrySubdir(entry: SkillLockEntry): string | undefined {
  if (entry.skillPath === undefined) return undefined
  const segments = entry.skillPath.split(/[\\/]/u).filter(segment => segment !== '')
  if (segments.length === 0) return undefined
  return segments.slice(0, -1).join('/')
}

/** Parse a GitHub repository URL in the spellings install tools write. */
export function parseGitHubRepository(url: string): GitHubRepositoryRef | undefined {
  const candidate = url.trim()
  if (candidate === '') return undefined
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(candidate)
  if (ssh !== null && ssh[1] !== undefined && ssh[2] !== undefined) return { owner: ssh[1], repo: ssh[2] }
  const shorthand = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/u.exec(candidate)
  if (shorthand !== null && shorthand[1] !== undefined && shorthand[2] !== undefined) return { owner: shorthand[1], repo: shorthand[2] }
  const https = /^(?:git\+)?https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/u.exec(candidate)
  if (https !== null && https[1] !== undefined && https[2] !== undefined) return { owner: https[1], repo: https[2] }
  return undefined
}

/** Normalize a GitHub URL to `https://github.com/owner/repo`. */
export function normalizeGitHubUrl(repository: GitHubRepositoryRef): string {
  return `https://github.com/${repository.owner}/${repository.repo}`
}

/** Accepted shape of a GitHub token printed by `gh auth token`. */
const GITHUB_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{20,}$/u

/**
 * Pick the GitHub token used for update checks: an explicit environment token
 * first, then a token resolved lazily from the `gh` CLI. Never stored anywhere.
 */
export function selectGitHubToken(env: Record<string, string | undefined>, ghToken?: string): string | undefined {
  const fromEnv = env.GITHUB_TOKEN ?? env.GH_TOKEN
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim()
  return ghToken
}

/** Validate one `gh auth token` stdout line; `undefined` means "not logged in". */
export function parseGitHubTokenOutput(stdout: string): string | undefined {
  const token = stdout.trim()
  return GITHUB_TOKEN_PATTERN.test(token) ? token : undefined
}

/**
 * Explain a GitHub API rate-limit rejection. Anonymous limits are stated as
 * such (with the reset time and the `gh` login hint) so they are never confused
 * with a normal network failure.
 */
export function githubRateLimitMessage(input: { authenticated: boolean; resetEpochSeconds?: number; now?: number }): string {
  const now = input.now ?? Date.now()
  let resetText = '重置时间未知'
  if (input.resetEpochSeconds !== undefined && Number.isFinite(input.resetEpochSeconds)) {
    const at = input.resetEpochSeconds * 1000
    const minutes = Math.max(1, Math.ceil((at - now) / 60_000))
    resetText = `重置时间 ${new Date(at).toLocaleString('zh-CN')}（约 ${String(minutes)} 分钟后）`
  }
  return input.authenticated
    ? `GitHub API 限额已用尽（${resetText}）；本次结果不会显示为“最新”。`
    : `GitHub 匿名限额已用尽（${resetText}），可登录 gh（gh auth login）或设置 GITHUB_TOKEN 提升限额；本次结果不会显示为“最新”。`
}

/** Make a case-insensitive copy of text bytes with CRLF folded to LF. */
export function normalizeTextBytes(raw: Buffer): Buffer {
  if (raw.includes(0)) return raw
  const text = raw.toString('utf8')
  if (!text.includes('\r')) return raw
  return Buffer.from(text.replace(/\r\n/gu, '\n'), 'utf8')
}

/** Git blob id for one file; text files are compared in canonical LF form. */
export function gitBlobSha(raw: Buffer, normalize = true): string {
  const content = normalize ? normalizeTextBytes(raw) : raw
  return createHash('sha1')
    .update(`blob ${String(content.length)}\0`)
    .update(content)
    .digest('hex')
}

/** Whether two git object ids are the same (hex compare, case-insensitive). */
export function sameTreeSha(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || right === undefined || left === '' || right === '') return false
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

/** Short display form of one git object id. */
export function shortTreeSha(sha: string | undefined): string {
  return sha === undefined || sha === '' ? '未知' : sha.slice(0, 12)
}

/** Local modification verdict derived from tree ids and the latest check. */
export interface LocalModificationDecision {
  state: 'clean' | 'modified' | 'unknown'
  detail?: string
}

/** One human-readable age of a recorded baseline ("3 周前"). */
export function formatRecordAge(recordedAt: string | undefined, now: number = Date.now()): string {
  if (recordedAt === undefined || recordedAt === '') return ''
  const at = Date.parse(recordedAt)
  if (!Number.isFinite(at)) return ''
  const ageMs = Math.max(0, now - at)
  const days = Math.floor(ageMs / 86_400_000)
  if (days < 1) return '今天'
  if (days < 7) return `${String(days)} 天前`
  if (days < 30) return `${String(Math.floor(days / 7))} 周前`
  if (days < 365) return `${String(Math.floor(days / 30))} 个月前`
  return `${String(Math.floor(days / 365))} 年前`
}

/**
 * Decide one copy's local-modification state, consistently with the update
 * checker's a/b/c ordering:
 *
 *   - local content equal to the last observed upstream tree → clean, even when
 *     the recorded lock baseline is older (the manager updates skill folders but
 *     never rewrites `~/.agents/.skill-lock.json`);
 *   - otherwise compare against the recorded baseline;
 *   - without any comparable tree the caller falls back to Git worktree state.
 *
 * `remoteTree` comes from the durable check cache; a copy edited after that
 * check no longer matches it, so the baseline comparison still reports the edit.
 */
export function resolveLocalModificationDecision(input: {
  localTree?: string
  baselineTree?: string
  /** Human label for the recorded baseline ("锁记录基线" / "来源基线"). */
  baselineLabel?: string
  baselineRecordedAt?: string
  remoteTree?: string
  now?: number
}): LocalModificationDecision {
  const { localTree, baselineTree, remoteTree } = input
  const label = input.baselineLabel ?? '记录基线'
  if (localTree !== undefined && remoteTree !== undefined && sameTreeSha(localTree, remoteTree)) {
    const stale = baselineTree !== undefined && !sameTreeSha(baselineTree, remoteTree)
    if (!stale) return { state: 'clean', detail: `内容与远端一致（${shortTreeSha(remoteTree)}）` }
    const age = formatRecordAge(input.baselineRecordedAt, input.now)
    return {
      state: 'clean',
      detail: `内容与远端一致（${shortTreeSha(remoteTree)}）；${label} ${shortTreeSha(baselineTree)} 较旧${age === '' ? '' : `（${age}记录）`}`,
    }
  }
  if (localTree !== undefined && baselineTree !== undefined) {
    if (sameTreeSha(localTree, baselineTree)) {
      return { state: 'clean', detail: `目录哈希与${label}一致（${shortTreeSha(baselineTree)}）` }
    }
    return {
      state: 'modified',
      detail: `目录哈希与${label}不一致：基线 ${shortTreeSha(baselineTree)}，本地 ${shortTreeSha(localTree)}`,
    }
  }
  return { state: 'unknown' }
}
export interface SkillUpdateDecision {
  status: 'up-to-date' | 'update-available' | 'local-modified' | 'check-failed'
  /** Local content differs from the recorded baseline. */
  localChanged: boolean
  /** Remote content differs from the recorded baseline. */
  remoteChanged: boolean
  /** Local content differs from the current remote. */
  localDiffersFromRemote: boolean
  /** The recorded baseline is older than both sides (manager-updated copy). */
  staleBaseline: boolean
  /** No trustworthy baseline was available, so no safe decision was possible. */
  baselineKnown: boolean
}

/**
 * Classify one skill copy from three git tree ids — local, remote and the
 * recorded baseline — in the order the manager promises:
 *
 *   a) local == remote  → `up-to-date`, even when the recorded baseline is
 *      older (a lock-based skill updated by the manager keeps the original
 *      `~/.agents/.skill-lock.json` hash; that file is never rewritten).
 *   b) local != remote != baseline → `update-available`; the caller annotates
 *      the local-modification conflict and the update planner asks for
 *      confirmation.
 *   c) local != remote == baseline → `local-modified` (only the local copy
 *      changed; the remote still serves the recorded version).
 *
 * A missing baseline cannot be reasoned about safely and yields `check-failed`.
 */
export function decideSkillUpdateStatus(input: {
  localTree: string
  remoteTree: string
  baselineTree?: string
  /** Git worktree already reported local changes (kept for detail, not the decision). */
  localModified?: boolean
}): SkillUpdateDecision {
  const baselineKnown = input.baselineTree !== undefined && input.baselineTree !== ''
  const localMatchesRemote = sameTreeSha(input.localTree, input.remoteTree)
  const localChanged = baselineKnown && !sameTreeSha(input.localTree, input.baselineTree)
  const remoteChanged = baselineKnown && !sameTreeSha(input.remoteTree, input.baselineTree)
  const staleBaseline = localMatchesRemote && remoteChanged
  if (localMatchesRemote) {
    return { status: 'up-to-date', localChanged, remoteChanged, localDiffersFromRemote: false, staleBaseline, baselineKnown }
  }
  if (!baselineKnown) {
    return { status: 'check-failed', localChanged: false, remoteChanged: false, localDiffersFromRemote: true, staleBaseline: false, baselineKnown }
  }
  if (remoteChanged) {
    return { status: 'update-available', localChanged, remoteChanged, localDiffersFromRemote: true, staleBaseline: false, baselineKnown }
  }
  return { status: 'local-modified', localChanged: true, remoteChanged: false, localDiffersFromRemote: true, staleBaseline: false, baselineKnown }
}

/** Throw when the caller already cancelled the scan. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) throw new Error('aborted')
}

/**
 * Hash one skill directory exactly like `git write-tree` would: sorted tree
 * entries, mode + name + blob id, then the `tree <byte-length>` object header.
 *
 * Text files are normalized from CRLF to LF before hashing because GitHub
 * stores LF while Windows installers (and git's own checkout filters) write
 * CRLF; without normalization every Windows-installed skill would look
 * locally modified.
 */
export async function computeSkillFolderTreeSha(
  dir: string,
  options: { signal?: AbortSignal; maxFiles?: number } = {},
): Promise<TreeHashResult> {
  const maxFiles = options.maxFiles ?? 4000
  const state = { files: 0, bytes: 0, fileHashes: {} as Record<string, string> }
  try {
    const walk = async (absoluteDir: string, relativeDir: string): Promise<TreeEntry[]> => {
      throwIfAborted(options.signal)
      const entries = await readdir(absoluteDir, { withFileTypes: true, encoding: 'utf8' })
      const treeEntries: TreeEntry[] = []
      for (const entry of entries) {
        if (entry.name === '.git') continue
        throwIfAborted(options.signal)
        const fullPath = join(absoluteDir, entry.name)
        const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
        let info
        try {
          info = await lstat(fullPath)
        } catch {
          continue
        }
        if (info.isDirectory()) {
          const children = await walk(fullPath, relativePath)
          // Git does not record empty directories; only real content forms a tree.
          if (children.length === 0) continue
          treeEntries.push({
            sortKey: `${entry.name}/`,
            header: treeHeader('40000', entry.name),
            sha: treeObjectSha(treeBody(children)),
          })
          continue
        }
        let mode = '100644'
        let sha: string
        if (info.isSymbolicLink()) {
          mode = '120000'
          sha = gitBlobSha(Buffer.from(await readlink(fullPath), 'utf8'), false)
        } else if (info.isFile()) {
          if (state.files >= maxFiles) throw new Error(`目录内文件超过上限 ${String(maxFiles)}`)
          const blob = await readFile(fullPath)
          mode = process.platform !== 'win32' && (info.mode & 0o111) !== 0 ? '100755' : '100644'
          sha = gitBlobSha(blob, true)
          state.files += 1
          state.bytes += blob.length
          state.fileHashes[relativePath] = sha
        } else {
          continue
        }
        treeEntries.push({ sortKey: entry.name, header: treeHeader(mode, entry.name), sha })
      }
      return treeEntries
    }
    const entries = await walk(dir, '')
    const sha = treeObjectSha(treeBody(entries))
    return { sha, files: state.files, bytes: state.bytes, fileHashes: state.fileHashes }
  } catch (error) {
    return {
      sha: '',
      files: state.files,
      bytes: state.bytes,
      fileHashes: state.fileHashes,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** `<mode> <name>\0` prefix of one git tree entry. */
function treeHeader(mode: string, name: string): Buffer {
  return Buffer.from(`${mode} ${name}\0`, 'utf8')
}

/** Serialize sorted entries into the raw tree object body. */
function treeBody(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((left, right) => compareCodePoints(left.sortKey, right.sortKey))
  return Buffer.concat(sorted.map(entry => Buffer.concat([entry.header, Buffer.from(entry.sha, 'hex')])))
}

/** Git object id for one tree body (header carries the byte length). */
function treeObjectSha(body: Buffer): string {
  return createHash('sha1').update(`tree ${String(body.length)}\0`).update(body).digest('hex')
}

/** Locate the repository owning `startDir` without following into worktrees. */
export function findGitRepository(startDir: string): { root: string; gitDir: string } | undefined {
  let current = resolve(startDir)
  while (true) {
    const entry = join(current, '.git')
    if (existsSync(entry)) {
      const gitDir = resolveGitDir(entry)
      if (gitDir !== undefined) return { root: current, gitDir }
      return undefined
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Resolve a `.git` directory entry, including worktree `gitdir:` files. */
function resolveGitDir(entry: string, depth = 0): string | undefined {
  if (depth > 4) return undefined
  try {
    const info = statSyncOrUndefined(entry)
    if (info?.isDirectory() === true) return entry
    const text = readFileSyncText(entry)
    const match = /^gitdir:\s*(.+)$/mu.exec(text ?? '')
    if (match?.[1] === undefined) return undefined
    const target = resolve(dirname(entry), match[1].trim())
    return resolveGitDir(target, depth + 1)
  } catch {
    return undefined
  }
}

/** Synchronous `stat` that returns undefined for missing paths. */
function statSyncOrUndefined(path: string): { isDirectory(): boolean } | undefined {
  try {
    return statSync(path)
  } catch {
    return undefined
  }
}

/** Synchronous text read helper (config/ref files are tiny). */
function readFileSyncText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Read git config / HEAD / refs for one repository without spawning git. */
export function readGitRepository(startDir: string): GitRepositoryInfo | undefined {
  const located = findGitRepository(startDir)
  if (located === undefined) return undefined
  const commonDir = commonGitDir(located.gitDir)
  const remoteUrl = readRemoteUrl(join(commonDir, 'config')) ?? readRemoteUrl(join(located.gitDir, 'config'))
  const head = readHead(located.gitDir, commonDir)
  return {
    root: located.root,
    gitDir: located.gitDir,
    ...(remoteUrl === undefined ? {} : { remoteUrl }),
    ...(head.branch === undefined ? {} : { branch: head.branch }),
    ...(head.commit === undefined ? {} : { commit: head.commit }),
  }
}

/** In a linked worktree, object/config data lives in the common git dir. */
function commonGitDir(gitDir: string): string {
  const text = readFileSyncText(join(gitDir, 'commondir'))
  if (text === undefined) return gitDir
  const target = text.trim()
  if (target === '') return gitDir
  return resolve(gitDir, target)
}

/** Parse `[remote "origin"] url = ...` from a git config file. */
function readRemoteUrl(configPath: string): string | undefined {
  const text = readFileSyncText(configPath)
  if (text === undefined) return undefined
  let inOrigin = false
  for (const line of text.split(/\r?\n/u)) {
    const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/u.exec(line)
    if (section !== null) {
      inOrigin = section[1] === 'origin'
      continue
    }
    if (!inOrigin) continue
    const url = /^\s*url\s*=\s*(.+)$/u.exec(line)
    if (url?.[1] !== undefined) return url[1].trim()
  }
  return undefined
}

/** Read the checked-out branch and commit from HEAD/refs/packed-refs. */
function readHead(gitDir: string, commonDir: string): { branch?: string; commit?: string } {
  // HEAD is per-worktree; refs and packed-refs live in the common git dir.
  const head = readFileSyncText(join(gitDir, 'HEAD'))?.trim() ?? readFileSyncText(join(commonDir, 'HEAD'))?.trim()
  if (head === undefined || head === '') return {}
  const refMatch = /^ref:\s*(.+)$/u.exec(head)
  if (refMatch?.[1] === undefined) return /^[0-9a-f]{40}$/u.test(head) ? { commit: head } : {}
  const refName = refMatch[1].trim()
  const branch = refName.startsWith('refs/heads/') ? refName.slice('refs/heads/'.length) : undefined
  const direct = readFileSyncText(join(commonDir, ...refName.split('/')))?.trim()
  if (direct !== undefined && /^[0-9a-f]{40}$/u.test(direct)) {
    return { ...(branch === undefined ? {} : { branch }), commit: direct }
  }
  const packed = readFileSyncText(join(commonDir, 'packed-refs'))
  if (packed !== undefined) {
    for (const line of packed.split(/\r?\n/u)) {
      if (line.startsWith('#') || line.startsWith('^')) continue
      const match = /^([0-9a-f]{40})\s+(.+)$/u.exec(line.trim())
      if (match?.[1] !== undefined && match[2] === refName) {
        return { ...(branch === undefined ? {} : { branch }), commit: match[1] }
      }
    }
  }
  return branch === undefined ? {} : { branch }
}

/** Run one git command and capture stdout; never uses a shell. */
function execGit(args: readonly string[], signal?: AbortSignal): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolvePromise) => {
    try {
      execFile(
        'git',
        [...args],
        {
          timeout: 10_000,
          windowsHide: true,
          maxBuffer: 4 << 20,
          encoding: 'utf8',
          ...(signal === undefined ? {} : { signal }),
        },
        (error, stdout, stderr) => {
          if (error !== null) {
            resolvePromise({ stdout: stdout ?? '', error: `${error.message}${stderr === '' ? '' : `: ${stderr.trim()}`}` })
            return
          }
          resolvePromise({ stdout: stdout ?? '' })
        },
      )
    } catch (error) {
      resolvePromise({ stdout: '', error: error instanceof Error ? error.message : String(error) })
    }
  })
}

/** POSIX-style path of `toPath` relative to `fromDir`. */
export function relativePosix(fromDir: string, toPath: string): string {
  const value = relative(resolve(fromDir), resolve(toPath))
  return value.split(sep).join('/')
}

/** Query `git status --porcelain` for one path inside a repository. */
export async function readGitWorktreeStatus(
  repoRoot: string,
  targetPath: string,
  options: { signal?: AbortSignal } = {},
): Promise<GitWorktreeStatus> {
  const relativePath = relativePosix(repoRoot, targetPath)
  const args = ['-C', repoRoot, 'status', '--porcelain=v1', '-z', '--', relativePath === '' ? '.' : relativePath]
  const result = await execGit(args, options.signal)
  if (result.error !== undefined) {
    return { state: 'unknown', files: [], error: result.error }
  }
  const files: string[] = []
  const parts = result.stdout.split('\u0000')
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === undefined || part.length < 4) continue
    const status = part.slice(0, 2)
    const file = part.slice(3)
    if (status === '!!') continue
    files.push(file)
    // Renames carry a second NUL-separated source path.
    if (status.includes('R') || status.includes('C')) index += 1
  }
  return files.length === 0
    ? { state: 'clean', files: [] }
    : { state: 'modified', files: files.slice(0, 40) }
}

/** Tree id of the committed content of one repository subdirectory. */
export async function readGitHeadTree(
  repoRoot: string,
  subdir: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ sha?: string; error?: string }> {
  const revision = subdir === '' ? 'HEAD^{tree}' : `HEAD:${subdir}`
  const result = await execGit(['-C', repoRoot, 'rev-parse', '--verify', revision], options.signal)
  const sha = result.stdout.trim()
  if (result.error !== undefined) return { error: result.error }
  if (!/^[0-9a-f]{40}$/u.test(sha)) return { error: `git rev-parse 返回了非 tree 对象：${sha}` }
  return { sha }
}

/**
 * Ordering facts one physical candidate must expose for realpath de-duplication.
 * The wrapper can be any object: the helper only reads these fields.
 */
export interface PhysicalCopyOrdering {
  id: string
  name: string
  rootKey: string
  rank?: number
  managed: boolean
  /** Root derived from the runtime catalog rather than the Loader configuration. */
  synthetic?: boolean
  /** Canonical skill directory (realpath of the resource dir). */
  realPath: string
  manifestPath: string
  dir: string
  /** Directory-bundle vs flat `<name>.md`; selects the de-duplication identity. */
  layout?: 'directory' | 'flat-file'
}

/** Physical identity used for alias de-duplication (skill dir, else manifest). */
function physicalCopyIdentity(copy: PhysicalCopyOrdering): string {
  if (copy.layout === 'directory') {
    if (copy.dir !== '') return copy.dir
    return copy.realPath !== '' ? copy.realPath : copy.manifestPath
  }
  return copy.realPath !== '' ? copy.realPath : copy.manifestPath
}

/** Result of collapsing junction/symlink aliases of the same physical skill. */
export interface PhysicalCopyDedupe<T extends PhysicalCopyOrdering> {
  /** One candidate per physical skill directory, in discovery order. */
  kept: T[]
  /** Alias candidates with the survivor they duplicate. */
  dropped: Array<{ copy: T; keptBy: T }>
}

/** Priority score: configured managed roots first, runtime-derived roots last. */
function physicalCopyPriority(copy: PhysicalCopyOrdering, index: number): number[] {
  return [
    copy.managed ? 0 : 1,
    copy.synthetic === true ? 1 : 0,
    copy.rank ?? Number.MAX_SAFE_INTEGER,
    index,
  ]
}

/** Compare two priority tuples lexicographically. */
function comparePriority(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Collapse physical copies that point at the same real skill directory through
 * a Windows Junction or a symbolic link. The survivor is the highest-priority
 * root (managed over unmanaged, configured over runtime-derived, then lower
 * DSH rank); every alias keeps its lexical path in `dropped` so the inventory
 * can explain and display it.
 *
 * Fail-safe: when realpath resolution failed during discovery, the literal
 * manifest path is used as the identity, so unrelated skills are never merged.
 */
export function dedupePhysicalCopies<T extends PhysicalCopyOrdering>(copies: readonly T[]): PhysicalCopyDedupe<T> {
  const order = copies.map((copy, index) => ({ copy, index, priority: physicalCopyPriority(copy, index) }))
  order.sort((left, right) => comparePriority(left.priority, right.priority))
  const winners = new Map<string, T>()
  const dropped: Array<{ copy: T; keptBy: T }> = []
  for (const entry of order) {
    const { copy } = entry
    const key = skillPathKey(physicalCopyIdentity(copy))
    const keptBy = winners.get(key)
    if (keptBy === undefined) {
      winners.set(key, copy)
      continue
    }
    dropped.push({ copy, keptBy })
  }
  const winnerIds = new Set([...winners.values()].map(copy => copy.id))
  const kept = copies.filter(copy => winnerIds.has(copy.id)
    && winners.get(skillPathKey(physicalCopyIdentity(copy))) === copy)
  return { kept, dropped }
}

/**
 * User-facing diagnostics explaining why an aliased copy was not counted twice.
 * `winner` is the surviving candidate, `aliases` are the dropped junction /
 * symlink copies that resolve to the same real directory.
 */
export function describePhysicalAliases(input: {
  winner: PhysicalCopyOrdering
  aliases: readonly PhysicalCopyOrdering[]
}): Diagnostic[] {
  const { winner, aliases } = input
  const aliasList = aliases.map(alias => `${alias.manifestPath}（根「${alias.rootKey}」）`).join('、')
  const winnerIsAlias = skillPathKey(dirname(winner.manifestPath)) !== skillPathKey(winner.dir)
  const message = winnerIsAlias
    ? `通过 Junction/符号链接别名发现：别名路径 ${winner.manifestPath}，真实路径 ${winner.dir}；同一物理目录还通过 ${aliasList} 被发现，已按 realpath 去重，只保留「${winner.rootKey}」一份。`
    : `同一物理目录「${winner.dir}」被多条扫描路径发现：保留「${winner.rootKey}」${winner.manifestPath}；已按 realpath 去重忽略 ${aliasList}。`
  return [{
    level: 'info',
    code: 'skill/alias',
    message,
    detail: {
      aliasPath: winnerIsAlias ? winner.manifestPath : aliases[0]?.manifestPath,
      aliasPaths: aliases.map(alias => alias.manifestPath),
      aliasRootKey: aliases[0]?.rootKey,
      keptRootKey: winner.rootKey,
      realPath: winner.dir,
      canonicalManifest: winner.manifestPath,
    },
  }]
}

/**
 * Resolve same-name physical copies with the DSH provider precedence: managed
 * roots win by rank (lower first), a managed copy always wins over a
 * non-managed one, and insertion order breaks a rank tie.
 */
export function resolvePhysicalOverrides(copies: readonly PhysicalSkillIdentity[]): OverrideResolution {
  const effective = new Set<string>()
  const shadowedBy = new Map<string, string>()
  const overriddenCopies = new Map<string, Array<{ rootKey: string; path: string }>>()
  const diagnostics: Diagnostic[] = []
  const groups = new Map<string, PhysicalSkillIdentity[]>()
  for (const copy of copies) {
    const group = groups.get(copy.name) ?? []
    group.push(copy)
    groups.set(copy.name, group)
  }
  for (const [name, group] of groups) {
    if (group.length < 2) {
      const only = group[0]
      if (only !== undefined && only.managed) effective.add(only.id)
      continue
    }
    const ranked = [...group].sort((left, right) => {
      const leftRank = left.managed ? (left.rank ?? FALLBACK_MANAGED_RANK) : Number.MAX_SAFE_INTEGER
      const rightRank = right.managed ? (right.rank ?? FALLBACK_MANAGED_RANK) : Number.MAX_SAFE_INTEGER
      return leftRank - rightRank
    })
    const winner = ranked[0]
    if (winner === undefined) continue
    if (!winner.managed) continue
    effective.add(winner.id)
    const overridden: Array<{ rootKey: string; path: string }> = []
    for (const loser of ranked.slice(1)) {
      shadowedBy.set(loser.id, winner.manifestPath)
      if (loser.managed) {
        overridden.push({ rootKey: loser.rootKey, path: loser.manifestPath })
        diagnostics.push({
          level: 'info',
          code: 'skill/shadowed',
          message: `技能「${name}」的副本 ${loser.manifestPath} 被更高优先级的 ${winner.manifestPath} 覆盖`,
          detail: { name, winner: winner.rootKey, loser: loser.rootKey },
        })
      }
    }
    if (overridden.length > 0) overriddenCopies.set(winner.id, overridden)
  }
  return { effective, shadowedBy, overriddenCopies, diagnostics }
}

/** Compare a runtime summary path with a physical canonical manifest path. */
function runtimePathMatches(summaryPath: string | undefined, realPath: string): boolean {
  if (summaryPath === undefined || summaryPath === '') return false
  return comparisonKey(summaryPath) === comparisonKey(realPath)
}

/**
 * Join the runtime catalog (list B) with the physical copies (list A):
 * effective/loaded copies, copies shadowed by a differently rooted runtime
 * candidate, and runtime skills with no physical copy in a scanned root.
 */
export function linkRuntimeCatalog(
  copies: readonly PhysicalSkillIdentity[],
  catalog: RuntimeCatalog | undefined,
): RuntimeLink {
  const effective = new Set<string>()
  const loaded = new Set<string>()
  const shadowedBy = new Map<string, string>()
  const representedNames = new Set<string>()
  const diagnostics: Diagnostic[] = []
  if (catalog === undefined || !catalog.available) {
    diagnostics.push({
      level: 'warning',
      code: 'skill/runtime-unavailable',
      message: '运行时技能目录不可用，无法确认物理副本是否真正生效；生效关系按 DSH 根优先级推断。',
    })
    return { effective, loaded, shadowedBy, virtual: [], representedNames, diagnostics }
  }
  const byName = new Map<string, RuntimeSkillSummary[]>()
  const byPath = new Map<string, RuntimeSkillSummary>()
  for (const summary of catalog.skills) {
    const list = byName.get(summary.name) ?? []
    list.push(summary)
    byName.set(summary.name, list)
    if (summary.path !== undefined && summary.path !== '') byPath.set(comparisonKey(summary.path), summary)
  }
  for (const copy of copies) {
    const matches = byName.get(copy.name) ?? []
    const pathMatch = byPath.get(comparisonKey(copy.realPath))
    if (pathMatch !== undefined) {
      effective.add(copy.id)
      loaded.add(copy.id)
      representedNames.add(copy.name)
      continue
    }
    if (matches.length > 0) {
      representedNames.add(copy.name)
      const winner = matches[0]
      if (winner !== undefined) {
        shadowedBy.set(copy.id, winner.path ?? `provider:${winner.provider ?? 'unknown'}`)
      }
      continue
    }
    if (copy.managed) {
      diagnostics.push({
        level: 'info',
        code: 'skill/not-loaded',
        message: `技能「${copy.name}」（${copy.rootKey}）未出现在运行时清单中：可能被更高优先级同名技能覆盖或所在工作区未激活`,
        detail: { path: copy.realPath, rootKey: copy.rootKey },
      })
    }
  }
  const virtual: RuntimeSkillSummary[] = []
  const seenVirtual = new Set<string>()
  for (const summary of catalog.skills) {
    if (summary.path !== undefined && summary.path !== ''
      && copies.some(copy => runtimePathMatches(summary.path, copy.realPath))) continue
    const key = `${summary.name}\0${summary.path ?? ''}`
    if (seenVirtual.has(key)) continue
    seenVirtual.add(key)
    virtual.push(summary)
  }
  if (virtual.length > 0) {
    diagnostics.push({
      level: 'info',
      code: 'skill/virtual',
      message: `运行时清单中有 ${String(virtual.length)} 个技能没有对应的物理副本（虚拟/内置/未扫描目录技能）`,
      detail: { names: virtual.map(item => item.name).slice(0, 20) },
    })
  }
  if (!catalog.complete) {
    diagnostics.push({
      level: 'warning',
      code: 'skill/runtime-incomplete',
      message: '运行时技能目录未完整采集，部分生效关系可能与实际不一致。',
      detail: { observations: [...catalog.observations] },
    })
  }
  return { effective, loaded, shadowedBy, virtual, representedNames, diagnostics }
}
