/**
 * Transport layer of the Extension Manager Web client.
 *
 * Every request is same-origin JSON under `/api/dsh-extension-manager` and
 * carries the client marker header; mutations additionally send
 * `content-type: application/json`. Failures are normalized into one error
 * type so the UI can tell four situations apart:
 *
 *  - `network`: the Host never answered (offline, restarted, proxy error),
 *  - `http`: the Host answered with a non-2xx status and a machine code,
 *  - `timeout`: the request (or a polled task) exceeded its deadline,
 *  - `invalid`: the Host answered 2xx with a body this contract cannot read.
 *
 * A failed task is *not* a transport failure: `waitForTask` resolves with the
 * final `TaskState` and the caller renders its failure detail.
 */
import {
  API_PREFIX,
  CLIENT_MARKER_HEADER,
  CLIENT_MARKER_VALUE,
  ENDPOINTS,
  type CheckRequest,
  type DiagnosticsResponse,
  type HealthResponse,
  type HistoryResponse,
  type RefreshRequest,
  type RefreshResponse,
  type TaskResponse,
  type UpdatePlanRequest,
  type UpdatePlanResponse,
  type UpdateRequest,
  type UpdateResponse,
} from '../shared/api'
import type {
  HistoryEntry,
  PluginInventoryPayload,
  SkillsInventoryPayload,
  TaskState,
  UpdatePlan,
} from '../shared/types'
import { createFixtureTransport as fixtureTransportFactory } from './fixture'

/** How one request failed, from the renderer's point of view. */
export type ApiErrorKind = 'network' | 'http' | 'timeout' | 'aborted' | 'invalid'

/** One normalized transport failure. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind
  readonly status: number | undefined
  readonly code: string | undefined

  constructor(kind: ApiErrorKind, message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ApiError'
    this.kind = kind
    this.status = options.status
    this.code = options.code
  }
}

/** True when an abort signal, not the Host, ended the request. */
export function isAbortError(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'aborted'
}

/** Chinese, actionable sentence for any thrown value. */
export function apiErrorText(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error && error.message !== '') return error.message
  return '扩展管理器发生未知错误'
}

/** Short HTTP-level hint (used under the generic sentence). */
export function apiErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined
  if (error.kind !== 'http') return undefined
  const parts: string[] = []
  if (error.status !== undefined) parts.push(`HTTP ${String(error.status)}`)
  if (error.code !== undefined) parts.push(error.code)
  return parts.length === 0 ? undefined : parts.join(' · ')
}

const READ_TIMEOUT_MS = 25_000
const MUTATION_TIMEOUT_MS = 40_000
const POLL_TIMEOUT_MS = 15 * 60_000
const POLL_INTERVAL_MS = 700

/** Parse the Host's `{ ok:false, error, code }` body without trusting its shape. */
async function readFailure(response: Response): Promise<{ message: string; code?: string }> {
  try {
    const body = await response.json() as unknown
    if (typeof body === 'object' && body !== null) {
      const record = body as Record<string, unknown>
      const message = typeof record['error'] === 'string' && record['error'].trim() !== ''
        ? record['error']
        : `Host 返回 HTTP ${String(response.status)}`
      const code = typeof record['code'] === 'string' ? record['code'] : undefined
      return code === undefined ? { message } : { message, code }
    }
  } catch {
    // fall through to the generic sentence
  }
  return { message: `Host 返回 HTTP ${String(response.status)}` }
}

interface RequestInitLite {
  method: 'GET' | 'POST'
  body?: unknown
  signal?: AbortSignal | undefined
  timeoutMs?: number
}

/** One JSON round trip with marker header, credentials and a hard deadline. */
async function request<T>(path: string, init: RequestInitLite): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const forwardAbort = (): void => { controller.abort() }
  init.signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, init.timeoutMs ?? READ_TIMEOUT_MS)

  const headers: Record<string, string> = { [CLIENT_MARKER_HEADER]: CLIENT_MARKER_VALUE }
  if (init.body !== undefined) headers['content-type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method: init.method,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  } catch (caught) {
    if (init.signal?.aborted === true) throw new ApiError('aborted', '请求已取消', { cause: caught })
    if (timedOut) throw new ApiError('timeout', '扩展管理器 Host 响应超时，请稍后重试', { cause: caught })
    throw new ApiError('network', '无法连接扩展管理器 Host 服务（网络不可用或 Host 未启动）', { cause: caught })
  } finally {
    clearTimeout(timer)
    init.signal?.removeEventListener('abort', forwardAbort)
  }

  if (!response.ok) {
    const failure = await readFailure(response)
    throw new ApiError('http', failure.message, {
      status: response.status,
      ...(failure.code === undefined ? {} : { code: failure.code }),
    })
  }
  try {
    return await response.json() as T
  } catch (caught) {
    throw new ApiError('invalid', 'Host 返回了无法解析的数据', { cause: caught })
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function invalidPayload(what: string): ApiError {
  return new ApiError('invalid', `${what}数据格式不符合契约，请更新扩展管理器与 DSH 到同一版本`)
}

/** Read the plugin inventory (and optionally rescan it). */
export async function fetchPlugins(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PluginInventoryPayload> {
  const query = options.refresh === true ? '?refresh=1' : ''
  const payload = await request<PluginInventoryPayload>(`${ENDPOINTS.plugins}${query}`, {
    method: 'GET',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const record = asObject(payload)
  if (record === undefined || !Array.isArray(record['bundles']) || !Array.isArray(record['rows'])) {
    throw invalidPayload('Plugins 清单')
  }
  return payload
}

/** Read the skills inventory (and optionally rescan it for one workspace). */
export async function fetchSkills(options: { refresh?: boolean; workspace?: string; signal?: AbortSignal } = {}): Promise<SkillsInventoryPayload> {
  const search = new URLSearchParams()
  if (options.refresh === true) search.set('refresh', '1')
  if (options.workspace !== undefined && options.workspace !== '') search.set('workspace', options.workspace)
  const query = search.size === 0 ? '' : `?${search.toString()}`
  const payload = await request<SkillsInventoryPayload>(`${ENDPOINTS.skills}${query}`, {
    method: 'GET',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })
  const record = asObject(payload)
  if (record === undefined || !Array.isArray(record['physical']) || !Array.isArray(record['virtual'])) {
    throw invalidPayload('Skills 清单')
  }
  return payload
}

/** Host health probe (used by the diagnostics dialog). */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return await request<HealthResponse>(ENDPOINTS.health, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
}

/** Update history, newest first. */
export async function fetchHistory(signal?: AbortSignal): Promise<HistoryEntry[]> {
  const response = await request<HistoryResponse>(ENDPOINTS.history, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!Array.isArray(response.entries)) throw invalidPayload('更新历史')
  return response.entries
}

/** Environment, probes and log locations for the diagnostics drawer. */
export async function fetchDiagnostics(signal?: AbortSignal): Promise<DiagnosticsResponse> {
  const response = await request<DiagnosticsResponse>(`${ENDPOINTS.diagnostics}`, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
  if (asObject(response.environment) === undefined) throw invalidPayload('诊断信息')
  return response
}

/** Ask the Host to rescan inventories (optionally for one workspace). */
export async function requestRefresh(body: RefreshRequest): Promise<RefreshResponse> {
  return await request<RefreshResponse>(ENDPOINTS.refresh, {
    method: 'POST',
    body,
    timeoutMs: MUTATION_TIMEOUT_MS,
  })
}

/** Start an update check task. */
export async function startCheck(body: CheckRequest): Promise<TaskState> {
  const response = await request<{ ok: boolean; task?: TaskState }>(ENDPOINTS.check, {
    method: 'POST',
    body,
    timeoutMs: MUTATION_TIMEOUT_MS,
  })
  if (response.task === undefined) throw invalidPayload('检查任务')
  return response.task
}

/** Build an update plan without executing anything. */
export async function fetchUpdatePlan(body: UpdatePlanRequest): Promise<UpdatePlan> {
  const response = await request<UpdatePlanResponse>(ENDPOINTS.updatePlan, {
    method: 'POST',
    body,
    timeoutMs: MUTATION_TIMEOUT_MS,
  })
  if (asObject(response.plan) === undefined) throw invalidPayload('更新计划')
  return response.plan
}

/** Execute an already confirmed update plan. */
export async function startUpdate(body: UpdateRequest): Promise<UpdateResponse> {
  const response = await request<UpdateResponse>(ENDPOINTS.update, {
    method: 'POST',
    body,
    timeoutMs: MUTATION_TIMEOUT_MS,
  })
  return response
}

/** Read one task snapshot. */
export async function fetchTask(id: string, signal?: AbortSignal): Promise<TaskResponse> {
  const response = await request<TaskResponse>(`${ENDPOINTS.task}/${encodeURIComponent(id)}`, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.task === undefined && response.error === undefined) throw invalidPayload('任务状态')
  return response
}

/** Read the newest tasks (used to adopt a task started before a reload). */
export async function fetchTasks(signal?: AbortSignal): Promise<TaskState[]> {
  const response = await request<{ ok: boolean; tasks?: TaskState[] }>(ENDPOINTS.tasks, {
    method: 'GET',
    ...(signal === undefined ? {} : { signal }),
  })
  return Array.isArray(response.tasks) ? response.tasks : []
}

function isFinished(task: TaskState): boolean {
  return task.status === 'done' || task.status === 'failed' || task.status === 'cancelled'
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new ApiError('aborted', '请求已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new ApiError('aborted', '请求已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Options for {@link waitForTask}. */
export interface TaskPollOptions {
  signal?: AbortSignal | undefined
  /** Called with every snapshot, including the final one. */
  onTask?: ((task: TaskState) => void) | undefined
  intervalMs?: number | undefined
  timeoutMs?: number | undefined
  /**
   * Task reader override; the HTTP transport keeps the default. The preview
   * transport supplies its own so tasks that only exist in the fixture are
   * polled locally.
   */
  readTask?: ((id: string, signal?: AbortSignal) => Promise<TaskResponse>) | undefined
}

/**
 * Poll `GET /task/:id` until the task settles and return its final state.
 * A task that fails settles normally; only transport errors throw.
 */
export async function waitForTask(id: string, options: TaskPollOptions = {}): Promise<TaskState> {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS
  const deadline = Date.now() + (options.timeoutMs ?? POLL_TIMEOUT_MS)
  const read = options.readTask ?? fetchTask
  let last: TaskState | undefined
  for (;;) {
    if (options.signal?.aborted === true) throw new ApiError('aborted', '请求已取消')
    const response = await read(id, options.signal)
    if (response.task === undefined) {
      throw new ApiError('http', response.error ?? '任务状态不可用', { status: 404 })
    }
    last = response.task
    options.onTask?.(response.task)
    if (isFinished(response.task)) return response.task
    if (Date.now() > deadline) {
      throw new ApiError('timeout', '任务执行超时；可在「诊断」中查看 Host 日志后重试')
    }
    await sleep(interval, options.signal)
  }
  /* c8 ignore next -- the loop only exits by return or throw. */
  throw new ApiError('timeout', '任务状态未知', { cause: last })
}

/**
 * Everything the page needs from the Host. The HTTP implementation talks to
 * the real routes; the fixture implementation (only behind `?emFixture=1`)
 * serves local preview data and never runs on the default path.
 */
export interface Transport {
  /** True when this transport serves preview data. */
  readonly preview: boolean
  plugins(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<PluginInventoryPayload>
  skills(options?: { refresh?: boolean; workspace?: string; signal?: AbortSignal }): Promise<SkillsInventoryPayload>
  refresh(body: RefreshRequest): Promise<RefreshResponse>
  check(body: CheckRequest): Promise<TaskState>
  /** Poll a task until it settles (preview transports poll their own tasks). */
  waitForTask(id: string, options?: TaskPollOptions): Promise<TaskState>
  task(id: string, signal?: AbortSignal): Promise<TaskResponse>
  tasks(signal?: AbortSignal): Promise<TaskState[]>
  updatePlan(body: UpdatePlanRequest): Promise<UpdatePlan>
  update(body: UpdateRequest): Promise<UpdateResponse>
  history(signal?: AbortSignal): Promise<HistoryEntry[]>
  diagnostics(signal?: AbortSignal): Promise<DiagnosticsResponse>
  health(signal?: AbortSignal): Promise<HealthResponse>
}

/** The real same-origin HTTP transport. */
export const httpTransport: Transport = {
  preview: false,
  plugins: fetchPlugins,
  skills: fetchSkills,
  refresh: requestRefresh,
  check: startCheck,
  waitForTask: (id, options = {}) => waitForTask(id, options),
  task: fetchTask,
  tasks: fetchTasks,
  updatePlan: fetchUpdatePlan,
  update: startUpdate,
  history: fetchHistory,
  diagnostics: fetchDiagnostics,
  health: fetchHealth,
}

/** True when the page URL explicitly asks for preview data. */
export function isPreviewMode(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const search = new URLSearchParams(window.location.search)
    return search.get('emFixture') === '1'
  } catch {
    return false
  }
}

/** Pick the transport for this page load. */
export function createTransport(): Transport {
  if (isPreviewMode()) {
    // Imported lazily so the fixture (and its sample records) is only pulled
    // into the module graph; the code is still bundled but never used by default.
    return fixtureTransportFactory()
  }
  return httpTransport
}
