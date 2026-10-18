/**
 * Host environment facts: paths, versions, registries and the resolution
 * helpers every inventory module shares. Read once per scan, cached briefly.
 */
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { EnvironmentInfo, SourceInfo } from '../shared/types'

/** Name of this plugin package; used for self-identification and self-update guards. */
export const SELF_PACKAGE_NAME = 'dsh-extension-manager'

/** Absolute root of this installed plugin package. */
export function ownPackageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** Read and parse a JSON file; `undefined` when absent or unreadable. */
export function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Read one string field from a JSON file without throwing. */
export function readJsonString(path: string, field: string): string | undefined {
  const value = readJsonFile(path)?.[field]
  return typeof value === 'string' ? value : undefined
}

/** Strip a trailing separator and resolve a path for display/comparison. */
export function tidyPath(path: string): string {
  return path.replace(/[\\/]+$/u, '')
}

/** The running profile's launcher facts. */
export interface ProfileFacts {
  name: string
  dir: string
  home: string
  installAnchor: string
  cwd: string
  startedBundles: readonly string[]
}

/** Read the launcher-provided profile context. */
export function profileFacts(ctx: Context): ProfileFacts | undefined {
  const value = ctx.get('profileContext') as ProfileFacts | undefined
  if (value === undefined || typeof value.name !== 'string' || typeof value.dir !== 'string') return undefined
  return value
}

/** Per-process cached `pnpm --version` / `git --version` probes. */
const commandVersions = new Map<string, Promise<string | undefined>>()

/** Resolve one executable through PATH (and the common Windows shim locations). */
export function findExecutable(command: string): string | undefined {
  const separators = process.platform === 'win32' ? [';', ':'] : [':']
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['']
  const directories = separators
    .flatMap(separator => (process.env.PATH ?? '').split(separator))
    .map(entry => entry.trim().replace(/^"+|"+$/gu, ''))
    .filter(entry => entry !== '')
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    const localAppData = process.env.LOCALAPPDATA
    const programFiles = process.env.ProgramFiles
    const guesses = [
      ...(appData === undefined ? [] : [join(appData, 'npm', `${command}.cmd`)]),
      ...(localAppData === undefined ? [] : [join(localAppData, 'pnpm', `${command}.exe`)]),
      ...(programFiles === undefined ? [] : [join(programFiles, 'nodejs', `${command}.cmd`)]),
    ]
    for (const candidate of guesses) if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Run one command briefly and resolve its first trimmed output line. */
function probeCommand(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    try {
      const executable = findExecutable(command) ?? command
      // Windows batch shims need cmd.exe; the command and arguments here are
      // fixed internal probes, never client input.
      const shell = process.platform === 'win32' && /\.(?:cmd|bat)$/iu.test(executable)
      execFile(executable, args, { timeout: 8000, windowsHide: true, maxBuffer: 1 << 20, shell }, (error, stdout, stderr) => {
        if (error !== null) { resolve(undefined); return }
        const line = `${stdout}\n${stderr}`.split(/\r?\n/u).map(text => text.trim()).find(text => text !== '')
        resolve(line)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/** Run a CLI version probe through the resolved executable. */
export function commandVersion(command: string, args: readonly string[]): Promise<string | undefined> {
  const key = `${command} ${args.join(' ')}`
  const cached = commandVersions.get(key)
  if (cached !== undefined) return cached
  const probe = probeCommand(command, args)
  commandVersions.set(key, probe)
  return probe
}

/**
 * Create a resolver for packages visible from one manifest directory or from
 * an explicit `package.json` path (the launcher supplies the installation
 * anchor as the file itself).
 */
export function packageResolver(from: string): (specifier: string) => string | undefined {
  let require: NodeRequire | undefined
  try {
    const manifest = /\.json$/u.test(from) ? from : join(from, 'package.json')
    require = createRequire(pathToFileURL(manifest))
  } catch {
    require = undefined
  }
  return (specifier: string): string | undefined => {
    if (require === undefined) return undefined
    try {
      return require.resolve(specifier)
    } catch {
      return undefined
    }
  }
}

/**
 * Resolve an installed package directory using the profile first and the DSH
 * installation second — the same order the Loader's bundle resolution uses.
 */
export function resolvePackageDirectory(facts: ProfileFacts, packageName: string): string | undefined {
  for (const from of [facts.dir, facts.installAnchor]) {
    const resolved = packageResolver(from)(`${packageName}/package.json`)
    if (resolved !== undefined) return dirname(resolved)
  }
  return undefined
}

/** The runtime version of the DSH installation serving this profile. */
export function runtimeVersion(facts: ProfileFacts): string | undefined {
  const manifest = /\.json$/u.test(facts.installAnchor) ? facts.installAnchor : join(facts.installAnchor, 'package.json')
  return readJsonString(manifest, 'version')
}

/** Classify one recorded dependency spec into a provenance source. */
export function classifyDependencySpec(name: string, spec: string, profileDir: string, profileName: string): SourceInfo {
  const local = /^(file|link):(.*)$/su.exec(spec)
  if (local !== null) {
    const raw = (local[2] ?? '').replace(/^~(?=$|[\\/])/u, () => process.env.USERPROFILE ?? '~')
    const resolved = /^[A-Za-z]:[\\/]/u.test(raw) || raw.startsWith('/') ? raw : join(profileDir, raw)
    return {
      kind: local[1] === 'link' ? 'local-link' : 'local-path',
      trust: 'local-custom',
      label: local[1] === 'link' ? '本地链接安装' : '本地目录安装',
      spec,
      packageName: name,
      detail: `来自 Profile「${profileName}」的本地路径安装，不执行远端更新`,
    }
  }
  // git+<scheme>:// URLs (git+https, git+ssh, git+file, …): strip the pnpm
  // protocol marker, keep the real clone URL, and split an optional #ref.
  const gitUrl = /^git\+(?<scheme>[a-z]+):\/\/(?<rest>[^#]*)(?:#(?<ref>.*))?$/su.exec(spec)
  if (gitUrl?.groups !== undefined) {
    const scheme = gitUrl.groups.scheme ?? 'https'
    const rest = gitUrl.groups.rest ?? ''
    const ref = gitUrl.groups.ref
    const cloneUrl = `${scheme}://${rest}`
    let host = scheme
    try { host = new URL(cloneUrl).hostname || scheme } catch { host = scheme }
    const repoMatch = /(?:^|\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(rest)
    return {
      kind: 'git',
      trust: 'verified',
      label: `Git 安装 · ${host}`,
      url: cloneUrl,
      spec,
      packageName: name,
      ...(ref === undefined || ref === '' ? {} : { ref }),
      ...(host !== 'github.com' || repoMatch === null ? {} : { repo: `${repoMatch[1] ?? ''}/${repoMatch[2] ?? ''}` }),
    }
  }
  const gitShorthand = /^(git:|github:|gitlab:|bitbucket:)(.+)$/su.exec(spec)
  if (gitShorthand !== null) {
    const prefix = gitShorthand[1] ?? ''
    const target = gitShorthand[2] ?? ''
    const hashAt = target.indexOf('#')
    const urlPart = hashAt === -1 ? target : target.slice(0, hashAt)
    const ref = hashAt === -1 ? undefined : target.slice(hashAt + 1)
    const host = prefix === 'github:' ? 'github.com'
      : prefix === 'gitlab:' ? 'gitlab.com'
        : prefix === 'bitbucket:' ? 'bitbucket.org'
          : 'git'
    const pair = /^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/u.exec(urlPart)
    const cloneUrl = pair === null
      ? (urlPart.includes('://') ? urlPart : `https://${host}/${urlPart}`)
      : `https://${host}/${pair[1] ?? ''}/${pair[2] ?? ''}`
    return {
      kind: 'git',
      trust: 'verified',
      label: `Git 安装 · ${host}`,
      url: cloneUrl,
      spec,
      packageName: name,
      ...(ref === undefined || ref === '' ? {} : { ref }),
      ...(pair === null || host === 'git' ? {} : { repo: `${pair[1] ?? ''}/${pair[2] ?? ''}` }),
    }
  }
  if (/^https?:\/\//u.test(spec) && /\.(tgz|tar\.gz)(\?|#|$)/u.test(spec)) {
    return { kind: 'tarball', trust: 'needs-confirmation', label: '压缩包安装', spec, packageName: name, url: spec }
  }
  if (/^[A-Za-z]:[\\/]/u.test(spec) || /^\.{0,2}[\\/]/u.test(spec) || spec.startsWith('/')) {
    return { kind: 'local-path', trust: 'local-custom', label: '本地路径安装', spec, packageName: name }
  }
  // Registry spec: optional alias followed by a version range, tag or alias.
  const registryName = name
  return {
    kind: 'npm',
    trust: 'verified',
    label: 'npm Registry',
    spec: `${registryName}@${spec}`,
    packageName: registryName,
  }
}

/** Whether an existing file for this package version exists in the profile lockfile. */
export function lockfilePath(facts: ProfileFacts): string {
  return join(facts.dir, 'pnpm-lock.yaml')
}

/** Wire shape for the environment panel. */
export interface HostEnvironment {
  info: EnvironmentInfo
  facts: ProfileFacts
}

/** Collect the environment snapshot shown in diagnostics. */
export async function readEnvironment(
  ctx: Context,
  managerVersion: string,
  limitations: readonly string[],
): Promise<HostEnvironment | undefined> {
  const facts = profileFacts(ctx)
  if (facts === undefined) return undefined
  const pluginManager = ctx.get('pluginManager')
  const registries = pluginManager === undefined
    ? { registry: null, fallbackRegistries: [] as string[], resolved: null }
    : await pluginManager.registries().catch(() => ({ registry: null, fallbackRegistries: [] as string[], resolved: null }))
  const [pnpmVersion, gitVersion] = await Promise.all([
    commandVersion('pnpm', ['--version']),
    commandVersion('git', ['--version']),
  ])
  const stateDir = join(facts.home, 'extension-manager')
  const ownManifestPath = join(ownPackageDir(), 'package.json')
  const ownName = readJsonString(ownManifestPath, 'name') ?? SELF_PACKAGE_NAME
  const profileManifest = readJsonFile(join(facts.dir, 'package.json'))
  const dependencies = (profileManifest?.dependencies ?? {}) as Record<string, string>
  const runtime = runtimeVersion(facts)
  const ownSpec = dependencies[ownName]
  const installSource = ownSpec === undefined
    ? undefined
    : classifyDependencySpec(ownName, ownSpec, facts.dir, facts.name)
  const info: EnvironmentInfo = {
    ...(runtime === undefined ? {} : { runtimeVersion: runtime }),
    hostPid: process.pid,
    profile: { name: facts.name, dir: facts.dir, dshHome: facts.home, installAnchor: facts.installAnchor },
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    ...(pnpmVersion === undefined ? {} : { pnpmVersion }),
    ...(gitVersion === undefined ? {} : { gitVersion }),
    hmrEnabled: ctx.get('hmr') !== undefined,
    registries: { registry: registries.registry, fallbackRegistries: [...registries.fallbackRegistries], resolved: registries.resolved },
    ...(process.env.HTTPS_PROXY === undefined && process.env.HTTP_PROXY === undefined
      ? {} : { networkProxy: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? '' }),
    manager: {
      version: managerVersion,
      ownPackageName: ownName,
      ...(installSource === undefined ? {} : { installSource }),
      updatesSupported: true,
      selfUpdateSupported: false,
      selfUpdateReason: '当前为本地构建安装，未配置可信的上游发布源；管理器自身更新需重新打包安装。',
      stateDir,
      logDir: join(stateDir, 'logs'),
      backupDir: join(stateDir, 'backups'),
    },
    skillProviders: [],
    limitations: [...limitations],
  }
  return { info, facts }
}

/** Whether a path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && readFileSync(path) instanceof Buffer !== undefined
      ? true
      : existsSync(path)
  } catch {
    return false
  }
}

let managerVersionCache: string | undefined
/** Version of this plugin package, read from its shipped manifest. */
export function readManagerVersion(): string {
  if (managerVersionCache !== undefined) return managerVersionCache
  managerVersionCache = readJsonString(join(ownPackageDir(), 'package.json'), 'version') ?? '0.0.0'
  return managerVersionCache
}
