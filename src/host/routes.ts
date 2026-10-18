/**
 * HTTP surface of the Extension Manager Host plugin.
 *
 * Every route lives under `/api/dsh-extension-manager`. Requests pass the same
 * browser trust fence and signed-cookie admission as the official `/api`
 * bridge (`ctx.connection.admit`); mutations additionally require the
 * `x-dsh-extension-manager` marker header and a JSON content type, which a
 * cross-origin page cannot send without a CORS preflight this server never
 * answers. No route accepts a filesystem path from the client for writing:
 * records are addressed by inventory id and resolved server-side.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import {
  API_PREFIX,
  CLIENT_MARKER_HEADER,
  CLIENT_MARKER_VALUE,
  type CheckRequest,
  type CheckResponse,
  type DiagnosticsResponse,
  type HealthResponse,
  type HistoryResponse,
  type RefreshRequest,
  type RefreshResponse,
  type SkillSourceRequest,
  type SkillSourceResponse,
  type TaskResponse,
  type TasksResponse,
  type UpdatePlanRequest,
  type UpdatePlanResponse,
  type UpdateRequest,
  type UpdateResponse,
} from '../shared/api'
import type { HostServices, UpdateManager } from './contracts'
import type { UpdateCheckService } from './updates/checker'
import { managerPaths } from './state'
import { errorText } from './logs'
import { ownPackageDir, profileFacts, readEnvironment, readManagerVersion } from './env'

/** Everything the router needs from the Host wiring. */
export interface RouterDeps {
  services: HostServices
  checks: UpdateCheckService
  updates: UpdateManager
  /** Build the diagnostics/environment payload. */
  environment(): Promise<DiagnosticsResponse>
  version: string
}

const MAX_BODY_BYTES = 1 << 20

/** One HTTP failure with a stable machine code. */
class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Write one JSON document. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/** Read a bounded JSON request body. */
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new HttpError(415, 'content-type', '请求必须使用 application/json')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'body-too-large', '请求体超过 1 MiB 上限')
    chunks.push(buffer)
  }
  if (size === 0) throw new HttpError(400, 'empty-body', '请求体为空')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
  } catch {
    throw new HttpError(400, 'invalid-json', '请求体不是合法 JSON')
  }
}

/** Reject a mutation that does not carry the client marker header. */
function assertMarker(req: IncomingMessage): void {
  if (req.headers[CLIENT_MARKER_HEADER] !== CLIENT_MARKER_VALUE) {
    throw new HttpError(403, 'forbidden-mutation', '缺少扩展管理器请求标记')
  }
}

/** Apply the official browser trust fence and signed-cookie admission. */
function admitRequest(ctx: Context, req: IncomingMessage): { ok: true } | { ok: false; status: 401 | 403; code: string } {
  const connection = ctx.get('connection')
  if (connection !== undefined) {
    const admission = connection.admit({ headers: req.headers })
    if ('rejection' in admission) {
      return admission.rejection === 403
        ? { ok: false, status: 403, code: 'forbidden-host' }
        : { ok: false, status: 401, code: 'authentication-required' }
    }
    return { ok: true }
  }
  const host = String(req.headers.host ?? '')
  if (!/^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?$/u.test(host)) {
    return { ok: false, status: 403, code: 'forbidden-host' }
  }
  return { ok: true }
}

/** Path segments after the API prefix. */
function tailSegments(path: string): string[] {
  return path.split('/').filter(segment => segment !== '')
}

/** Normalize a path for comparison (trailing separators removed). */
function tidy(path: string): string {
  return path.replace(/[\\/]+$/u, '')
}

/**
 * Validate an optional workspace path: only a registered workspace, the
 * running profile's cwd, or a directory inside the DSH home may be scanned.
 * Client-supplied paths are never used for writes.
 */
function validateWorkspace(ctx: Context, value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new HttpError(400, 'invalid-workspace', '工作区参数必须是字符串')
  if (!/^[A-Za-z]:[\\/]/u.test(value) && !value.startsWith('/')) {
    throw new HttpError(400, 'invalid-workspace', '工作区必须是绝对路径')
  }
  const candidate = tidy(value)
  const facts = profileFacts(ctx)
  if (facts !== undefined && tidy(facts.cwd) === candidate) return candidate
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined) {
    for (const workspace of registry.list()) {
      if (tidy(workspace.path) === candidate) return candidate
    }
  }
  throw new HttpError(400, 'invalid-workspace', '只允许访问已在 DSH 中注册的工作区')
}

/** Build the diagnostics payload shared by `/environment` and `/diagnostics`. */
export async function buildDiagnostics(ctx: Context, services: HostServices): Promise<DiagnosticsResponse> {
  const paths = managerPaths(ctx)
  const environment = await readEnvironment(ctx, readManagerVersion(), [
    'Skills 没有官方的逐技能启停机制，管理器只展示真实状态，不提供伪造的启停。',
    '管理器自身以本地构建安装，暂不提供页面内自更新；失败时请按维护说明重新打包安装。',
    '其他 Profile 的插件为只读展示，不会在这里被修改。',
    '随 DSH 安装提供的组件随 DSH 发行版更新。',
    'GitHub API 匿名访问受限流影响，失败会明确显示为网络/限流错误。',
  ])
  const probes: DiagnosticsResponse['probes'] = []
  if (paths !== undefined) {
    probes.push(await probeDirectory('状态目录', paths.stateDir))
    probes.push(await probeDirectory('日志目录', paths.logDir))
    probes.push(await probeDirectory('备份目录', paths.backupDir))
  }
  const skills = await services.skills.scan()
  const fallback: DiagnosticsResponse['environment'] = {
    hostPid: process.pid,
    profile: { name: 'unknown', dir: '', dshHome: '', installAnchor: '' },
    platform: `${process.platform} ${process.arch}`,
    nodeVersion: process.version,
    hmrEnabled: false,
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    manager: {
      version: readManagerVersion(),
      ownPackageName: 'dsh-extension-manager',
      updatesSupported: false,
      selfUpdateSupported: false,
      stateDir: paths?.stateDir ?? '',
      logDir: paths?.logDir ?? '',
      backupDir: paths?.backupDir ?? '',
    },
    skillProviders: [],
    limitations: ['当前 Host 没有提供 profileContext，管理能力不可用。'],
  }
  const info = environment?.info ?? fallback
  if (paths !== undefined) {
    info.manager.stateDir = paths.stateDir
    info.manager.logDir = paths.logDir
    info.manager.backupDir = paths.backupDir
  }
  info.skillProviders = skills.roots.map(root => ({ key: root.key, managed: root.managed, path: root.path }))
  return {
    ok: true,
    environment: info,
    probes,
    logs: {
      stateDir: paths?.stateDir ?? '',
      logDir: paths?.logDir ?? '',
      ...(paths === undefined ? {} : { latestLog: paths.logFile }),
    },
  }
}

/** Check that a directory exists and accepts a probe write. */
async function probeDirectory(name: string, path: string): Promise<DiagnosticsResponse['probes'][number]> {
  try {
    const { mkdir, writeFile, rm } = await import('node:fs/promises')
    const { join } = await import('node:path')
    await mkdir(path, { recursive: true })
    const probe = join(path, `.write-probe-${String(process.pid)}`)
    await writeFile(probe, 'ok', 'utf8')
    await rm(probe, { force: true })
    return { name, ok: true, detail: path }
  } catch (error) {
    return { name, ok: false, detail: `${path}: ${errorText(error)}` }
  }
}

/** Sentinel reserving the single update slot while a request plans. */
const UPDATE_STARTING = '__update_starting__'

/** Instance state that outlives one request. */
interface RouterState {
  activeUpdateTask: string | undefined
}

/**
 * Register the manager's route table.
 * @returns the disposer that removes the route registration.
 */
export function registerRoutes(ctx: Context, deps: RouterDeps): () => void {
  const state: RouterState = { activeUpdateTask: undefined }
  const log = deps.services.log
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = Date.now()
    let route = 'unknown'
    try {
      const admission = admitRequest(ctx, req)
      if (!admission.ok) {
        sendJson(res, admission.status, { ok: false, error: admission.code })
        return
      }
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) : url.pathname
      const segments = tailSegments(path)
      const method = req.method ?? 'GET'
      route = `${method} ${path}`
      if (method !== 'GET' && method !== 'HEAD') assertMarker(req)

      if (method === 'GET' && segments[0] === 'health') {
        const body: HealthResponse = {
          ok: true,
          plugin: 'extension-manager',
          version: deps.version,
          pid: process.pid,
          now: new Date().toISOString(),
        }
        sendJson(res, 200, body)
        return
      }
      if (method === 'GET' && (segments[0] === 'environment' || segments[0] === 'diagnostics')) {
        sendJson(res, 200, await deps.environment())
        return
      }
      if (method === 'GET' && segments[0] === 'plugins') {
        sendJson(res, 200, await deps.services.plugins.scan({ refresh: url.searchParams.get('refresh') === '1' }))
        return
      }
      if (method === 'GET' && segments[0] === 'skills') {
        const workspace = validateWorkspace(ctx, url.searchParams.get('workspace') ?? undefined)
        const refresh = url.searchParams.get('refresh') === '1'
        sendJson(res, 200, await deps.services.skills.scan({ refresh, ...(workspace === undefined ? {} : { workspace }) }))
        return
      }
      if (method === 'GET' && segments[0] === 'tasks') {
        const body: TasksResponse = { ok: true, tasks: deps.services.tasks.list() }
        sendJson(res, 200, body)
        return
      }
      if (method === 'GET' && segments[0] === 'task' && segments[1] !== undefined) {
        const task = deps.services.tasks.get(segments[1])
        if (task === undefined) {
          const body: TaskResponse = { ok: false, error: '任务不存在或已过期' }
          sendJson(res, 404, body)
          return
        }
        const body: TaskResponse = { ok: true, task, pending: task.status === 'queued' || task.status === 'running' }
        sendJson(res, 200, body)
        return
      }
      if (method === 'GET' && segments[0] === 'history') {
        const body: HistoryResponse = { ok: true, entries: deps.services.state.history(200) }
        sendJson(res, 200, body)
        return
      }
      if (method === 'POST' && segments[0] === 'refresh') {
        const body = await readJson<RefreshRequest>(req)
        const scope = body.scope ?? 'all'
        const workspace = validateWorkspace(ctx, body.workspace)
        deps.services.plugins.invalidate()
        deps.services.skills.invalidate()
        const response: RefreshResponse = { ok: true }
        if (scope === 'plugins' || scope === 'all') response.plugins = await deps.services.plugins.scan({ refresh: true })
        if (scope === 'skills' || scope === 'all') {
          response.skills = await deps.services.skills.scan({ refresh: true, ...(workspace === undefined ? {} : { workspace }) })
        }
        sendJson(res, 200, response)
        return
      }
      if (method === 'POST' && segments[0] === 'check') {
        const body = await readJson<CheckRequest>(req)
        if (body.scope !== 'plugins' && body.scope !== 'skills' && body.scope !== 'all') {
          throw new HttpError(400, 'invalid-scope', 'scope 必须是 plugins / skills / all')
        }
        const workspace = validateWorkspace(ctx, body.workspace)
        const task = await deps.checks.start({
          scope: body.scope,
          ...(Array.isArray(body.ids) ? { ids: body.ids.filter((id): id is string => typeof id === 'string') } : {}),
          refresh: body.refresh === true,
          ...(workspace === undefined ? {} : { workspace }),
        })
        const response: CheckResponse = { ok: true, task }
        sendJson(res, 200, response)
        return
      }
      if (method === 'POST' && segments[0] === 'update-plan') {
        const body = await readJson<UpdatePlanRequest>(req)
        if (body.scope !== 'plugins' && body.scope !== 'skills' && body.scope !== 'all') {
          throw new HttpError(400, 'invalid-scope', 'scope 必须是 plugins / skills / all')
        }
        const workspace = validateWorkspace(ctx, body.workspace)
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : undefined
        const plan = await deps.updates.plan(body.scope, ids, workspace)
        const response: UpdatePlanResponse = { ok: true, plan }
        sendJson(res, 200, response)
        return
      }
      if (method === 'POST' && segments[0] === 'update') {
        const body = await readJson<UpdateRequest>(req)
        if (body.confirmed !== true) throw new HttpError(400, 'confirmation-required', '更新必须在用户确认后执行')
        if (!Array.isArray(body.ids) || body.ids.length === 0) throw new HttpError(400, 'no-targets', '没有指定要更新的项目')
        if (body.ids.length > 100) throw new HttpError(400, 'too-many-targets', '单次最多更新 100 项')
        const reservation = state.activeUpdateTask
        if (reservation === UPDATE_STARTING) throw new HttpError(409, 'update-busy', '已有更新请求正在准备，请稍候')
        const active = reservation === undefined ? undefined : deps.services.tasks.get(reservation)
        if (active !== undefined && (active.status === 'queued' || active.status === 'running')) {
          throw new HttpError(409, 'update-busy', '已有更新任务正在执行，请等待完成')
        }
        // Reserve the one update slot synchronously, before any await: two
        // concurrent requests must not both pass the guard while planning.
        state.activeUpdateTask = UPDATE_STARTING
        const ids = body.ids.filter((id): id is string => typeof id === 'string')
        const workspace = validateWorkspace(ctx, body.workspace)
        try {
          const plan = await deps.updates.plan(body.scope, ids, workspace)
          if (plan.entries.length === 0 && plan.excluded.length === 0) throw new HttpError(400, 'no-plan', '没有匹配的可更新项目')
          // Entries flagged requiresConfirmation (prerelease, unverified source or
          // local modifications) are executable only through an explicit request;
          // their confirmation is checked again by the executor's PREFLIGHT.
          const executable = plan.entries.filter(entry => entry.eligible
            || (entry.requiresConfirmation === true && (body.overwriteLocalModifications === true || plan.entries.length === 1)))
          if (executable.length === 0) {
            throw new HttpError(400, 'no-eligible', plan.entries[0]?.excludedReason ?? plan.excluded[0]?.excludedReason ?? '没有可安全自动更新的项目')
          }
          const task = deps.services.tasks.create({
            kind: executable.length > 1 ? 'batch-update' : 'update',
            scope: body.scope,
            items: executable.map(entry => ({
              id: entry.id,
              name: entry.displayName,
              ...(entry.currentVersion === undefined ? {} : { fromVersion: entry.currentVersion }),
              ...(entry.targetVersion === undefined ? {} : { toVersion: entry.targetVersion }),
            })),
            plan,
          })
          state.activeUpdateTask = task.id
          const signal = new AbortController().signal
          void deps.updates.execute({
            plan,
            confirmed: true,
            overwriteLocalModifications: body.overwriteLocalModifications === true,
            taskId: task.id,
            signal,
            ...(workspace === undefined ? {} : { workspace }),
          }).then(() => {
            const current = deps.services.tasks.get(task.id)
            if (current === undefined) return
            if (current.status !== 'queued' && current.status !== 'running') return
            const failed = current.items.filter(item => item.status === 'failed').length
            deps.services.tasks.finish(task.id, failed > 0 ? 'failed' : 'done', failed > 0 ? `${String(failed)} 项更新失败` : '更新流程完成')
          }).catch((error: unknown) => {
            deps.services.tasks.finish(task.id, 'failed', '更新失败', errorText(error))
          }).finally(() => {
            if (state.activeUpdateTask === task.id) state.activeUpdateTask = undefined
          })
          const response: UpdateResponse = { ok: true, task, plan }
          sendJson(res, 200, response)
          return
        } catch (error) {
          if (state.activeUpdateTask === UPDATE_STARTING) state.activeUpdateTask = undefined
          throw error
        }
      }
      if (method === 'POST' && segments[0] === 'skill-source') {
        const body = await readJson<SkillSourceRequest>(req)
        const associate = deps.services.skills.associateSource
        if (associate === undefined) throw new HttpError(501, 'not-implemented', '技能来源关联接口尚未启用')
        const result = await associate.call(deps.services.skills, {
          id: body.id,
          url: body.url,
          ...(body.ref === undefined ? {} : { ref: body.ref }),
          ...(body.subdir === undefined ? {} : { subdir: body.subdir }),
          ...(body.baseline === undefined ? {} : { baseline: body.baseline }),
        })
        if (result.error !== undefined) throw new HttpError(400, 'skill-source-failed', result.error)
        const payload: SkillSourceResponse = { ok: true, ...result }
        sendJson(res, 200, payload)
        return
      }
      throw new HttpError(404, 'not-found', `未知端点：${route}`)
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { ok: false, error: error.message, code: error.code })
        return
      }
      log.error('http.failed', { route, durationMs: Date.now() - started, message: errorText(error) })
      sendJson(res, 500, { ok: false, error: '扩展管理器内部错误', code: 'internal' })
    }
  }
  log.info('http.routes-registered', { prefix: API_PREFIX, packageDir: ownPackageDir() })
  return ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
}
