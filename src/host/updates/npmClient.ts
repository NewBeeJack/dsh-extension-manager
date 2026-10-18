/**
 * npm Registry access for plugin update checks.
 *
 * This module is deliberately self-contained: apart from Node builtins it only
 * imports `semver` and (lazily, on the proxy path) `undici`. Both are bundled
 * into the Host half by esbuild, and the pure helpers below are unit-tested by
 * Node's native TypeScript runner without a DSH runtime.
 *
 * Registry rules mirror the DSH plugin manager (`@deepseek-ai/dsh-plugin-manager/registry`):
 *  - a private (non-public) registry is asked alone — a private registry never
 *    falls through to a public mirror;
 *  - only the two public mirrors, registry.npmjs.org and registry.npmmirror.com,
 *    may fall back to each other;
 *  - `null` stands for "the registry pnpm's own configuration names"; it can
 *    only be asked when `registries().resolved` says which URL that is.
 *
 * A check that could not reach any registry is reported as such
 * (`unavailable` / `network-error`) and never as "up to date".
 */
import semver from 'semver'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plugin-manager'

/** npm's own registry; the one public registry a plan trusts as such. */
export const OFFICIAL_NPM_REGISTRY = 'https://registry.npmjs.org/'
/** Public npmmirror URL used as the built-in public fallback. */
export const NPMMIRROR_REGISTRY = 'https://registry.npmmirror.com/'
/** Accept header for the abbreviated ("corgi") packument: smaller, still carries engines/peers. */
export const CORGI_ACCEPT = 'application/vnd.npm.install-v1+json'
/** Default bound on one registry lookup performed by an update check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 12_000
/** Default bound on a tarball download (bigger than a lookup, still bounded). */
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000
/** Default bound on one packument response. */
export const DEFAULT_MAX_PACKUMENT_BYTES = 32 * 1024 * 1024
/** Default bound on one tarball response. */
export const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024

/** A registry URL, or `null` for "whatever pnpm's own configuration names". */
export type Registry = string | null

/** Raw registry facts, as `ctx.pluginManager.registries()` reports them. */
export interface RegistryConfig {
  readonly registry: Registry
  readonly fallbackRegistries: readonly string[]
  readonly resolved: string | null
}

/**
 * The registries one update check asks, in order, with the privacy rules
 * already applied. `plan` is what the client iterates; `registry` is its first
 * entry so it can be passed straight to `pluginManager.installBundle`.
 */
export interface NpmRegistryPolicy {
  /** First registry asked (normalized URL, or `null` for pnpm's own registry). */
  readonly registry: Registry
  /** Every registry asked, first to last (normalized; `null` = pnpm's own). */
  readonly plan: readonly Registry[]
  /** Registries used only after the first one fails (normalized URLs; empty for a private registry). */
  readonly fallbackRegistries: readonly string[]
  /** The URL pnpm's own configuration resolves to (normalized); `null` when unreadable. */
  readonly resolved: string | null
  /** Whether falling back to another registry is allowed at all. */
  readonly allowFallback: boolean
  /** The facts the policy was derived from (used to plan per-record lookups). */
  readonly configured: RegistryConfig
}

/** Hosts recognized as public npm mirrors: the only sources allowed to fall back to each other. */
const PUBLIC_REGISTRY_HOSTS: ReadonlySet<string> = new Set(['registry.npmjs.org', 'registry.npmmirror.com'])

/** Hosts whose URLs are accepted as public mirrors in their canonical form. */
const DEFAULT_PUBLIC_CONFIG: RegistryConfig = {
  registry: OFFICIAL_NPM_REGISTRY,
  fallbackRegistries: [NPMMIRROR_REGISTRY],
  resolved: OFFICIAL_NPM_REGISTRY,
}

/**
 * Parse a registry URL into the form pnpm compares registries in: trailing
 * slash kept, host lower-cased by `URL`.
 * @throws {Error} for anything that is not an http(s) URL.
 */
export function normalizeRegistryUrl(url: string): string {
  const parsed = new URL(url.trim())
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`a registry must be an http(s) URL: ${url}`)
  }
  if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
  return parsed.href
}

/** Normalize when possible; return `null` for an unusable registry value. */
export function tryNormalizeRegistryUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url.trim() === '') return null
  try {
    return normalizeRegistryUrl(url)
  } catch {
    return null
  }
}

/** Whether a registry URL points at one of the two public npm mirrors. */
export function isPublicRegistry(url: string | null | undefined): boolean {
  const normalized = tryNormalizeRegistryUrl(url)
  if (normalized === null) return false
  return PUBLIC_REGISTRY_HOSTS.has(new URL(normalized).hostname.toLowerCase())
}

/** Human-readable registry label used in diagnostics. */
export function describeRegistry(registry: Registry): string {
  if (registry === null) return 'pnpm 配置的 registry'
  const normalized = tryNormalizeRegistryUrl(registry)
  if (normalized === null) return registry
  return new URL(normalized).hostname
}

/** The registry URL a plan entry stands for: `null` resolves to pnpm's own resolved URL. */
export function registryUrlOf(entry: Registry, resolved: string | null): string | null {
  return entry === null ? tryNormalizeRegistryUrl(resolved) : tryNormalizeRegistryUrl(entry)
}

/**
 * Build the registry policy that mirrors `registryPlan()` from the plugin
 * manager: a requested registry is asked first when it belongs to the
 * configured set and alone otherwise; pnpm's own registry belongs to the set
 * only while it names a public URL; duplicates are asked once.
 */
export function buildRegistryPolicy(configured: RegistryConfig, requested?: Registry): NpmRegistryPolicy {
  const own = tryNormalizeRegistryUrl(configured.resolved)
  const fallbacks = configured.fallbackRegistries
    .map(registry => tryNormalizeRegistryUrl(registry))
    .filter((registry): registry is string => registry !== null)
  const ownIsPublic = own !== null && (own === OFFICIAL_NPM_REGISTRY || fallbacks.includes(own))
  const keyOf = (registry: Registry): string | null => registry === null ? own : tryNormalizeRegistryUrl(registry)
  const known: Registry[] = []
  const knownKeys: (string | null)[] = []
  for (const registry of [configured.registry, ...configured.fallbackRegistries]) {
    if (registry === null && !ownIsPublic) continue
    const key = keyOf(registry)
    if (knownKeys.includes(key)) continue
    known.push(registry === null ? null : tryNormalizeRegistryUrl(registry))
    knownKeys.push(key)
  }
  // An unreadable or invalid request is ignored: the configured first registry is asked.
  const configuredFirst = configured.registry === null || tryNormalizeRegistryUrl(configured.registry) !== null
    ? configured.registry
    : null
  const first: Registry = requested === undefined || (requested !== null && tryNormalizeRegistryUrl(requested) === null)
    ? configuredFirst
    : requested
  const firstKey = keyOf(first)
  const normalizedFirst: Registry = first === null ? null : tryNormalizeRegistryUrl(first)
  let plan: Registry[]
  if ((first === null || firstKey === own) && !ownIsPublic) {
    // A private or unknown registry of pnpm's own is asked alone.
    plan = [normalizedFirst]
  } else if (!knownKeys.includes(firstKey)) {
    plan = [normalizedFirst]
  } else {
    plan = [normalizedFirst, ...known.filter((_registry, index) => knownKeys[index] !== firstKey)]
  }
  const firstEntry = plan[0]
  const registry: Registry = firstEntry === undefined ? null : firstEntry
  return {
    registry,
    plan,
    fallbackRegistries: plan.slice(1).filter((entry): entry is string => entry !== null),
    resolved: own,
    allowFallback: plan.length > 1,
    configured,
  }
}

/**
 * Read the running plugin manager's registry configuration and turn it into a
 * query policy. Without a plugin manager (or when it cannot answer) the
 * built-in public configuration is used; when it answers with an unreadable
 * registry configuration the policy asks nothing rather than leaking a package
 * name to a public registry.
 */
export async function registryPolicy(ctx: Context): Promise<NpmRegistryPolicy> {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) return buildRegistryPolicy(DEFAULT_PUBLIC_CONFIG)
  try {
    const registries = await manager.registries()
    return buildRegistryPolicy({
      registry: registries.registry,
      fallbackRegistries: Array.isArray(registries.fallbackRegistries)
        ? registries.fallbackRegistries.filter((item): item is string => typeof item === 'string')
        : [],
      resolved: typeof registries.resolved === 'string' ? registries.resolved : null,
    })
  } catch {
    return buildRegistryPolicy({ registry: null, fallbackRegistries: [], resolved: null })
  }
}

/** One packument version manifest (the subset update checks need). */
export interface NpmVersionManifest {
  name?: string
  version?: string
  description?: string
  dist?: {
    tarball?: string
    integrity?: string
    shasum?: string
    fileCount?: number
    unpackedSize?: number
  }
  engines?: Record<string, string>
  peerDependencies?: Record<string, string>
  deprecated?: string
}

/** One npm packument (abbreviated corgi document by default). */
export interface NpmDocument {
  name?: string
  description?: string
  'dist-tags'?: Record<string, string>
  versions?: Record<string, NpmVersionManifest>
  time?: Record<string, string>
}

/** How one registry lookup failed. */
export type NpmFetchFailureKind =
  | 'timeout'
  | 'network'
  | 'http'
  | 'not-found'
  | 'invalid-json'
  | 'aborted'
  | 'unconfigured'
  | 'too-large'

/** One failed registry attempt, kept so the caller can explain *why* a check failed. */
export interface NpmFetchFailure {
  /** Registry asked (normalized URL, or a label for an unreadable configuration). */
  registry: string
  kind: NpmFetchFailureKind
  message: string
  /** HTTP status for `http`/`not-found` failures. */
  status?: number
}

/** Result of asking the configured registries for one package document. */
export type NpmDocumentOutcome =
  | { status: 'ok'; document: NpmDocument; registry: string; url: string; attempts: NpmFetchFailure[] }
  | { status: 'not-found'; attempts: NpmFetchFailure[] }
  | { status: 'unavailable'; attempts: NpmFetchFailure[] }
  | { status: 'invalid'; message: string; attempts: NpmFetchFailure[] }

/** Options for one packument lookup. */
export interface FetchNpmDocumentOptions {
  /** Policy produced by `registryPolicy()` (or `buildRegistryPolicy()`). */
  policy: NpmRegistryPolicy
  /** Abort the lookup (an aborted lookup is never reported as "up to date"). */
  signal?: AbortSignal
  /** Bound on each registry attempt; defaults to `DEFAULT_CHECK_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Ask one recorded registry first for this record (private packages keep their registry). */
  registry?: Registry
  /** Bound on the response body; defaults to `DEFAULT_MAX_PACKUMENT_BYTES`. */
  maxBytes?: number
}

/** Error thrown by `downloadTarball` for every transport or HTTP failure. */
export class NpmFetchError extends Error {
  readonly kind: NpmFetchFailureKind
  readonly url: string
  readonly status: number | undefined

  constructor(url: string, kind: NpmFetchFailureKind, message: string, status?: number) {
    super(message)
    this.name = 'NpmFetchError'
    this.kind = kind
    this.url = url
    this.status = status
  }
}

const USER_AGENT = 'dsh-extension-manager/update-check'

/** Minimal response surface shared by the global fetch and undici's fetch. */
interface MinimalResponse {
  readonly status: number
  readonly statusText: string
  readonly headers: { get(name: string): string | null }
  readonly url?: string
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}

/** Internal transport failure, before a registry label is attached. */
interface HttpFailure {
  kind: NpmFetchFailureKind
  message: string
  status?: number
}

/** Minimal NodeJS.ProcessEnv surface `proxyForUrl` needs (keeps it testable). */
export type ProxyEnvironment = Readonly<Record<string, string | undefined>>

/**
 * The proxy URL to use for one request, honoring `HTTPS_PROXY`/`HTTP_PROXY`
 * (upper- or lower-case) and `NO_PROXY`. Returns `undefined` for a direct
 * connection: no proxy configured, an unusable proxy value, or a bypassed host.
 */
export function proxyForUrl(env: ProxyEnvironment, url: string): string | undefined {
  const proxy = firstNonEmpty([
    env.HTTPS_PROXY,
    env.https_proxy,
    env.HTTP_PROXY,
    env.http_proxy,
  ])
  if (proxy === undefined) return undefined
  let proxyUrl: URL
  try {
    proxyUrl = new URL(proxy)
  } catch {
    return undefined
  }
  if (proxyUrl.protocol !== 'http:' && proxyUrl.protocol !== 'https:') return undefined
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return undefined
  }
  if (isBypassed(env.NO_PROXY ?? env.no_proxy, target)) return undefined
  return proxyUrl.href
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value
  }
  return undefined
}

/** Whether `NO_PROXY` exempts `target` from proxying. */
function isBypassed(noProxy: string | undefined, target: URL): boolean {
  if (noProxy === undefined || noProxy.trim() === '') return false
  const host = target.hostname.toLowerCase()
  const port = target.port === '' ? (target.protocol === 'https:' ? '443' : '80') : target.port
  for (const rawEntry of noProxy.split(',')) {
    const entry = rawEntry.trim().toLowerCase()
    if (entry === '') continue
    if (entry === '*') return true
    const colon = entry.lastIndexOf(':')
    const hasPort = colon > 0 && entry[(colon + 1)] !== undefined && /^\d+$/u.test(entry.slice(colon + 1))
    const hostPart = hasPort ? entry.slice(0, colon) : entry
    const portPart = hasPort ? entry.slice(colon + 1) : undefined
    if (portPart !== undefined && portPart !== port) continue
    const suffix = hostPart.replace(/^\*?\./u, '').replace(/^\./u, '')
    if (suffix === '') continue
    if (host === suffix || host.endsWith(`.${suffix}`)) return true
  }
  return false
}

interface ProxyDispatcherCache {
  key: string
  dispatcher: unknown
}

let proxyDispatcherCache: ProxyDispatcherCache | undefined

/** Create (and cache) an undici `ProxyAgent` for the first proxied request. */
async function proxyDispatcherFor(url: string): Promise<unknown | undefined> {
  const proxy = proxyForUrl(process.env, url)
  if (proxy === undefined) return undefined
  if (proxyDispatcherCache !== undefined && proxyDispatcherCache.key === proxy) return proxyDispatcherCache.dispatcher
  const { ProxyAgent } = await import('undici')
  const dispatcher: unknown = new ProxyAgent(proxy)
  proxyDispatcherCache = { key: proxy, dispatcher }
  return dispatcher
}

/** Combine the caller's signal with this request's timeout. */
function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs))
  if (signal === undefined) return timeout
  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
  if (typeof anySignal === 'function') return anySignal([signal, timeout])
  const controller = new AbortController()
  const abort = (): void => { controller.abort() }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
  if (timeout.aborted) abort()
  else timeout.addEventListener('abort', abort, { once: true })
  return controller.signal
}

/** Turn a fetch/undici rejection into a stable failure kind. */
function classifyFetchError(error: unknown, external: AbortSignal | undefined): NpmFetchFailureKind {
  if (external?.aborted === true) return 'aborted'
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError') return 'timeout'
  if (name === 'AbortError') return 'timeout'
  const cause = error instanceof Error
    ? (error as Error & { cause?: unknown }).cause
    : undefined
  const code = typeof cause === 'object' && cause !== null
    ? (cause as { code?: unknown }).code
    : undefined
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT' || code === 'ETIMEDOUT') return 'timeout'
  return 'network'
}

/** Short human-readable message for a thrown value. */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

interface OpenResponse {
  ok: true
  response: MinimalResponse
  url: string
}

type OpenResponseResult = OpenResponse | { ok: false; failure: HttpFailure }

/** Perform one GET, mapping transport and HTTP-level failures. */
async function openResponse(
  url: string,
  options: { accept: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<OpenResponseResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const signal = requestSignal(options.signal, timeoutMs)
  const headers: Record<string, string> = {
    accept: options.accept,
    'user-agent': USER_AGENT,
    'cache-control': 'no-cache',
  }
  let response: MinimalResponse
  try {
    const dispatcher = await proxyDispatcherFor(url)
    if (dispatcher === undefined) {
      response = await fetch(url, { method: 'GET', headers, signal, redirect: 'follow' }) as unknown as MinimalResponse
    } else {
      const { fetch: undiciFetch } = await import('undici')
      response = await undiciFetch(url, {
        method: 'GET',
        headers,
        signal,
        redirect: 'follow',
        dispatcher,
      } as never) as unknown as MinimalResponse
    }
  } catch (error) {
    return { ok: false, failure: { kind: classifyFetchError(error, options.signal), message: errorMessage(error) } }
  }
  if (response.status === 404 || response.status === 410) {
    return { ok: false, failure: { kind: 'not-found', message: `HTTP ${String(response.status)}`, status: response.status } }
  }
  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      failure: {
        kind: 'http',
        message: `HTTP ${String(response.status)}${response.statusText === '' ? '' : ` ${response.statusText}`}`,
        status: response.status,
      },
    }
  }
  return { ok: true, response, url: response.url ?? url }
}

interface TextResponse {
  ok: true
  text: string
  status: number
  url: string
}

type TextResponseResult = TextResponse | { ok: false; failure: HttpFailure }

/** GET a text body with a size bound. */
async function getText(
  url: string,
  options: { accept: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number },
): Promise<TextResponseResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PACKUMENT_BYTES
  const opened = await openResponse(url, options)
  if (!opened.ok) return opened
  try {
    const declared = Number(opened.response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, failure: { kind: 'too-large', message: `响应超过 ${String(maxBytes)} 字节上限` } }
    }
    const text = await opened.response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      return { ok: false, failure: { kind: 'too-large', message: `响应超过 ${String(maxBytes)} 字节上限` } }
    }
    return { ok: true, text, status: opened.response.status, url: opened.url }
  } catch (error) {
    return { ok: false, failure: { kind: classifyFetchError(error, options.signal), message: errorMessage(error) } }
  }
}

interface BytesResponse {
  ok: true
  bytes: Uint8Array
  status: number
  url: string
}

type BytesResponseResult = BytesResponse | { ok: false; failure: HttpFailure }

/** GET a binary body with a size bound. */
async function getBytes(
  url: string,
  options: { accept: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number },
): Promise<BytesResponseResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TARBALL_BYTES
  const opened = await openResponse(url, options)
  if (!opened.ok) return opened
  try {
    const declared = Number(opened.response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, failure: { kind: 'too-large', message: `响应超过 ${String(maxBytes)} 字节上限` } }
    }
    const buffer = await opened.response.arrayBuffer()
    if (buffer.byteLength > maxBytes) {
      return { ok: false, failure: { kind: 'too-large', message: `响应超过 ${String(maxBytes)} 字节上限` } }
    }
    return { ok: true, bytes: new Uint8Array(buffer), status: opened.response.status, url: opened.url }
  } catch (error) {
    return { ok: false, failure: { kind: classifyFetchError(error, options.signal), message: errorMessage(error) } }
  }
}

/**
 * The document URL for a package name, in the form registries accept:
 * `@scope/name` becomes `@scope%2Fname`.
 */
export function packageDocumentUrl(name: string, registry: string): string {
  const base = normalizeRegistryUrl(registry)
  const encoded = name.startsWith('@')
    ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/giu, '%2F')}`
    : encodeURIComponent(name)
  return `${base}${encoded}`
}

/** Parse a packument body; `undefined` when it is not a usable npm document. */
export function parsePackument(text: string): NpmDocument | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const fields = raw as Record<string, unknown>
  if (typeof fields.error === 'string' && fields.versions === undefined) return undefined
  const document: NpmDocument = {}
  if (typeof fields.name === 'string') document.name = fields.name
  if (typeof fields.description === 'string') document.description = fields.description
  const tags: Record<string, string> = {}
  const rawTags = fields['dist-tags']
  if (typeof rawTags === 'object' && rawTags !== null && !Array.isArray(rawTags)) {
    for (const [tag, version] of Object.entries(rawTags as Record<string, unknown>)) {
      if (typeof version === 'string' && version.trim() !== '') tags[tag] = version
    }
  }
  document['dist-tags'] = tags
  const versions: Record<string, NpmVersionManifest> = {}
  const rawVersions = fields.versions
  if (typeof rawVersions === 'object' && rawVersions !== null && !Array.isArray(rawVersions)) {
    for (const [version, manifest] of Object.entries(rawVersions as Record<string, unknown>)) {
      if (typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest)) {
        versions[version] = manifest as NpmVersionManifest
      }
    }
  }
  if (Object.keys(versions).length > 0) document.versions = versions
  const time: Record<string, string> = {}
  const rawTime = fields.time
  if (typeof rawTime === 'object' && rawTime !== null && !Array.isArray(rawTime)) {
    for (const [version, at] of Object.entries(rawTime as Record<string, unknown>)) {
      if (typeof at === 'string') time[version] = at
    }
  }
  if (Object.keys(time).length > 0) document.time = time
  return document
}

/** HTTP statuses after which asking another registry cannot help (auth/refusal, not a mirror staleness). */
function isTerminalHttpStatus(status: number | undefined): boolean {
  if (status === undefined) return false
  return status === 400 || status === 401 || status === 403 || status === 405 || status === 451
}

/**
 * Ask the configured registries for one package's packument, first to last.
 * Falls back only along the policy's plan (which already keeps private
 * registries alone); 404s and transport failures move on, auth failures stop.
 */
export async function fetchNpmDocument(name: string, options: FetchNpmDocumentOptions): Promise<NpmDocumentOutcome> {
  const attempts: NpmFetchFailure[] = []
  const policy = options.policy
  const plan = options.registry === undefined
    ? policy.plan
    : buildRegistryPolicy(policy.configured, options.registry).plan
  for (const entry of plan) {
    if (options.signal?.aborted === true) {
      attempts.push({ registry: describeRegistry(entry), kind: 'aborted', message: '检查已取消' })
      return { status: 'unavailable', attempts }
    }
    const registry = registryUrlOf(entry, policy.resolved)
    if (registry === null) {
      attempts.push({
        registry: describeRegistry(entry),
        kind: 'unconfigured',
        message: '无法确定 pnpm 自身配置的 registry 地址',
      })
      continue
    }
    const url = packageDocumentUrl(name, registry)
    const response = await getText(url, {
      accept: CORGI_ACCEPT,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      timeoutMs: options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_PACKUMENT_BYTES,
    })
    if (!response.ok) {
      attempts.push({
        registry,
        kind: response.failure.kind,
        message: response.failure.message,
        ...(response.failure.status === undefined ? {} : { status: response.failure.status }),
      })
      if (response.failure.kind === 'aborted' || response.failure.kind === 'too-large') break
      if (response.failure.kind === 'http' && isTerminalHttpStatus(response.failure.status)) break
      continue
    }
    const document = parsePackument(response.text)
    if (document === undefined) {
      attempts.push({ registry, kind: 'invalid-json', message: '返回内容不是合法的 npm packument' })
      return { status: 'invalid', message: `Registry ${describeRegistry(registry)} 返回的包文档无法解析`, attempts }
    }
    return { status: 'ok', document, registry, url: response.url, attempts }
  }
  if (attempts.length > 0 && attempts.every(attempt => attempt.kind === 'not-found')) {
    return { status: 'not-found', attempts }
  }
  return { status: 'unavailable', attempts }
}

/** Download one npm tarball into memory. Throws `NpmFetchError` on failure. */
export async function downloadTarball(
  url: string,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Uint8Array> {
  const response = await getBytes(url, {
    accept: 'application/octet-stream',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    timeoutMs: options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_TARBALL_BYTES,
  })
  if (!response.ok) {
    throw new NpmFetchError(
      url,
      response.failure.kind,
      response.failure.message,
      response.failure.status,
    )
  }
  return response.bytes
}

/** The manifest of one exact version inside a packument, when present. */
export function manifestOf(document: NpmDocument, version: string): NpmVersionManifest | undefined {
  const versions = document.versions
  if (versions === undefined) return undefined
  const direct = versions[version]
  if (direct !== undefined) return direct
  const normalized = normalizeSemver(version)
  if (normalized === undefined) return undefined
  for (const [key, manifest] of Object.entries(versions)) {
    if (normalizeSemver(key) === normalized) return manifest
  }
  return undefined
}

/** The tarball URL declared by one version manifest, when present. */
export function tarballUrlOf(manifest: NpmVersionManifest | undefined): string | undefined {
  const tarball = manifest?.dist?.tarball
  return typeof tarball === 'string' && tarball.trim() !== '' ? tarball.trim() : undefined
}

/**
 * Normalize a recorded version into a semver string. Accepts leading `v`/`=`
 * and whitespace; returns `undefined` when the value is not a semantic version
 * (ranges are not versions).
 */
export function normalizeSemver(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  const direct = semver.valid(trimmed)
  if (direct !== null) return direct
  const cleaned = semver.clean(trimmed)
  return cleaned === null ? undefined : cleaned
}

/** One release candidate taken from a dist-tag. */
export interface UpdateCandidate {
  /** Version text exactly as published. */
  version: string
  /** The dist-tag it came from. */
  tag: string
  /** Stable when the version has no prerelease identifiers. */
  channel: 'stable' | 'prerelease'
  /** Parsed form used for comparison. */
  parsed: semver.SemVer
}

/** Outcome of comparing the installed version with the upstream dist-tags. */
export type CandidateEvaluation =
  | {
    kind: 'update-available'
    candidate: UpdateCandidate
    current: semver.SemVer
    currentIsPrerelease: boolean
  }
  | {
    kind: 'prerelease-only'
    candidate: UpdateCandidate
    current: semver.SemVer
    stable?: UpdateCandidate
  }
  | {
    kind: 'up-to-date'
    current: semver.SemVer
    version?: string
    channel?: 'stable' | 'prerelease'
  }
  | {
    kind: 'no-candidate'
    current?: semver.SemVer
    detail: string
  }

/** dist-tag priority when two tags point at the same version. */
const TAG_PRIORITY: Readonly<Record<string, number>> = {
  latest: 0,
  stable: 1,
  next: 2,
  beta: 3,
  rc: 4,
  canary: 5,
  alpha: 6,
  dev: 7,
  prerelease: 8,
}

function tagRank(tag: string): number {
  return TAG_PRIORITY[tag] ?? 100
}

function pickMax(candidates: readonly UpdateCandidate[]): UpdateCandidate | undefined {
  let best: UpdateCandidate | undefined
  for (const candidate of candidates) {
    if (best === undefined || semver.gt(candidate.parsed, best.parsed)) best = candidate
  }
  return best
}

/**
 * Compare the installed version with the tagged upstream versions.
 *
 * `dist-tags.latest` (and any other tag pointing at a prerelease-free version)
 * is the stable candidate; the highest tagged prerelease is the candidate for
 * the `next`/`rc`/`beta` channel. A newer stable release always wins; a newer
 * prerelease is only an update when the installed version is itself a
 * prerelease, otherwise it is reported as `prerelease-only`. A downgrade is
 * never proposed.
 */
export function selectUpdateCandidate(
  distTags: Readonly<Record<string, string>> | undefined,
  currentRaw: string | undefined,
): CandidateEvaluation {
  const current = normalizeSemver(currentRaw)
  if (current === undefined) {
    return { kind: 'no-candidate', detail: '当前安装版本不是合法的 semver，无法与上游比较' }
  }
  const currentParsed = semver.parse(current)
  if (currentParsed === null) {
    return { kind: 'no-candidate', detail: '当前安装版本不是合法的 semver，无法与上游比较' }
  }
  const tags = distTags ?? {}
  const ordered = Object.keys(tags).sort((a, b) => tagRank(a) - tagRank(b) || a.localeCompare(b))
  const seen = new Set<string>()
  const candidates: UpdateCandidate[] = []
  for (const tag of ordered) {
    const raw = tags[tag]
    if (typeof raw !== 'string') continue
    const version = normalizeSemver(raw)
    if (version === undefined) continue
    const parsed = semver.parse(version)
    if (parsed === null) continue
    const key = parsed.version
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ version, tag, channel: parsed.prerelease.length === 0 ? 'stable' : 'prerelease', parsed })
  }
  if (candidates.length === 0) {
    return { kind: 'no-candidate', current: currentParsed, detail: '上游 dist-tags 中没有可解析的版本' }
  }
  const stable = pickMax(candidates.filter(candidate => candidate.channel === 'stable'))
  const prerelease = pickMax(candidates.filter(candidate => candidate.channel === 'prerelease'))
  const currentIsPrerelease = currentParsed.prerelease.length > 0
  // A published release always outranks a prerelease of the same version.
  if (stable !== undefined && semver.gt(stable.parsed, currentParsed)) {
    return { kind: 'update-available', candidate: stable, current: currentParsed, currentIsPrerelease }
  }
  if (prerelease !== undefined && semver.gt(prerelease.parsed, currentParsed)) {
    if (currentIsPrerelease) {
      return { kind: 'update-available', candidate: prerelease, current: currentParsed, currentIsPrerelease }
    }
    return {
      kind: 'prerelease-only',
      candidate: prerelease,
      current: currentParsed,
      ...(stable === undefined ? {} : { stable }),
    }
  }
  const known = stable ?? prerelease
  return {
    kind: 'up-to-date',
    current: currentParsed,
    ...(known === undefined ? {} : { version: known.version, channel: known.channel }),
  }
}

/** How a candidate version's declared DSH requirements compare with the running DSH. */
export interface CompatibilityEvaluation {
  compatibility: 'compatible' | 'incompatible' | 'unknown'
  /** Unmet requirements, as `key: range` entries (empty when compatible). */
  requirements: Record<string, string>
  /** Chinese explanation for an unknown or failed evaluation. */
  detail?: string
}

/** `engines.dsh` or dsh peers, matched with prereleases included — exactly like app-boot. */
function rangeSatisfied(runtimeVersion: string, range: string): boolean {
  const trimmed = range.trim()
  if (trimmed === '') return false
  try {
    return semver.satisfies(runtimeVersion, trimmed, { includePrerelease: true })
  } catch {
    return false
  }
}

function manifestFields(manifest: NpmVersionManifest): Record<string, unknown> {
  return manifest as unknown as Record<string, unknown>
}

/**
 * Evaluate one plugin manifest against a DSH runtime version with the same
 * semantics as `@deepseek-ai/dsh-app-boot`'s `evaluatePluginCompatibility`:
 * an own `engines.dsh` range decides alone and peer dependencies are then
 * ignored; otherwise every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer must
 * be satisfied, with `workspace:^|~|*` meaning "the current runtime".
 *
 * Unlike app-boot this never throws: malformed fields or a missing manifest
 * produce `unknown`, which callers must not present as compatible.
 */
export function evaluatePluginCompatibility(
  manifest: NpmVersionManifest | undefined,
  runtimeVersion: string | undefined,
): CompatibilityEvaluation {
  const runtime = normalizeSemver(runtimeVersion)
  if (runtime === undefined) {
    return { compatibility: 'unknown', requirements: {}, detail: '无法确定当前 DSH 运行版本，未校验兼容性' }
  }
  if (manifest === undefined) {
    return { compatibility: 'unknown', requirements: {}, detail: '上游没有提供该版本的 manifest 数据，无法校验 DSH 兼容性' }
  }
  const fields = manifestFields(manifest)
  const engines = Object.hasOwn(fields, 'engines') ? fields.engines : undefined
  if (engines !== undefined) {
    if (typeof engines !== 'object' || engines === null || Array.isArray(engines)) {
      return { compatibility: 'unknown', requirements: {}, detail: '上游 manifest 的 engines 字段格式非法' }
    }
    const engineFields = engines as Record<string, unknown>
    if (Object.hasOwn(engineFields, 'dsh')) {
      const range = engineFields.dsh
      if (typeof range !== 'string') {
        return { compatibility: 'unknown', requirements: {}, detail: '上游 manifest 的 engines.dsh 不是字符串' }
      }
      return rangeSatisfied(runtime, range)
        ? { compatibility: 'compatible', requirements: {} }
        : { compatibility: 'incompatible', requirements: { 'engines.dsh': range } }
    }
  }
  const peers = Object.hasOwn(fields, 'peerDependencies') ? fields.peerDependencies : undefined
  if (peers === undefined) {
    // No declared DSH requirement: app-boot treats the plugin as compatible.
    return { compatibility: 'compatible', requirements: {} }
  }
  if (typeof peers !== 'object' || peers === null || Array.isArray(peers)) {
    return { compatibility: 'unknown', requirements: {}, detail: '上游 manifest 的 peerDependencies 字段格式非法' }
  }
  const requirements: Record<string, string> = {}
  for (const [name, rawRange] of Object.entries(peers as Record<string, unknown>)) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    if (typeof rawRange !== 'string') {
      return {
        compatibility: 'unknown',
        requirements: {},
        detail: `上游 manifest 的 peerDependencies.${name} 不是字符串`,
      }
    }
    const requirement = rawRange === 'workspace:^' || rawRange === 'workspace:~' || rawRange === 'workspace:*'
      ? runtime
      : rawRange
    if (!rangeSatisfied(runtime, requirement)) requirements[name] = rawRange
  }
  return Object.keys(requirements).length === 0
    ? { compatibility: 'compatible', requirements: {} }
    : { compatibility: 'incompatible', requirements }
}
