/**
 * HTTP contract between the Extension Manager Host plugin and its Web client
 * bundle. Every endpoint is same-origin, JSON-only, and served under
 * `/api/dsh-extension-manager`.
 */
import type {
  EnvironmentInfo,
  HistoryEntry,
  PluginInventoryPayload,
  SkillsInventoryPayload,
  SkillStats,
  TaskState,
  UpdatePlan,
  UpdatePlanEntry,
} from './types'

export const API_PREFIX = '/api/dsh-extension-manager'

/** Header every request must carry; it also makes cross-origin requests preflight. */
export const CLIENT_MARKER_HEADER = 'x-dsh-extension-manager'
export const CLIENT_MARKER_VALUE = '1'

/** Endpoints (joined with API_PREFIX). */
export const ENDPOINTS = {
  health: '/health',
  environment: '/environment',
  plugins: '/plugins',
  skills: '/skills',
  task: '/task',
  tasks: '/tasks',
  refresh: '/refresh',
  check: '/check',
  updatePlan: '/update-plan',
  update: '/update',
  history: '/history',
  skillSource: '/skill-source',
  diagnostics: '/diagnostics',
  shutdown: '/shutdown',
} as const

export interface HealthResponse {
  ok: boolean
  plugin: string
  version: string
  pid: number
  now: string
}

export interface RefreshRequest {
  /** Inventory kinds to rescan; omitted means both. */
  scope?: 'plugins' | 'skills' | 'all'
  /** Workspace directory whose project skill roots should be scanned. */
  workspace?: string
}

export interface RefreshResponse {
  ok: boolean
  plugins?: PluginInventoryPayload
  skills?: SkillsInventoryPayload
}

export interface CheckRequest {
  scope: 'plugins' | 'skills' | 'all'
  /** Record ids to check; omitted checks every record with a usable source. */
  ids?: string[]
  /** Ignore the cached check result and ask upstream again. */
  refresh?: boolean
  /** Workspace directory for skill checks (project copies). */
  workspace?: string
}

export interface CheckResponse {
  ok: boolean
  task: TaskState
}

/** Build one update plan without executing anything. */
export interface UpdatePlanRequest {
  scope: 'plugins' | 'skills' | 'all'
  /** Record ids to include; omitted includes every eligible record. */
  ids?: string[]
  /** Workspace directory for project skill copies. */
  workspace?: string
}

export interface UpdatePlanResponse {
  ok: boolean
  plan: UpdatePlan
}

export interface UpdateRequest {
  scope: 'plugins' | 'skills' | 'all'
  /** Record ids to update. */
  ids: string[]
  /** The user explicitly accepted the listed risks. */
  confirmed: boolean
  /** Accept overwriting local modifications, which the plan flagged. */
  overwriteLocalModifications?: boolean
  /** Workspace for project skill copies. */
  workspace?: string
}

export interface UpdateResponse {
  ok: boolean
  task: TaskState
  plan: UpdatePlan
}

export interface TaskResponse {
  ok: boolean
  task?: TaskState
  /** True when the task exists but has not finished. */
  pending?: boolean
  error?: string
}

export interface TasksResponse {
  ok: boolean
  tasks: TaskState[]
}

export interface HistoryResponse {
  ok: boolean
  entries: HistoryEntry[]
}

export interface DiagnosticsResponse {
  ok: boolean
  environment: EnvironmentInfo
  /** Structured probe results, e.g. writability of the state directory. */
  probes: Array<{ name: string; ok: boolean; detail?: string }>
  logs: { stateDir: string; logDir: string; latestLog?: string }
}

export interface SkillSourceRequest {
  /** Skill record id (server resolves the physical copy; no client paths are trusted). */
  id: string
  /** GitHub repository URL (https only). */
  url: string
  /** Branch, tag or commit; omitted means the repository default branch. */
  ref?: string
  /** Repository-relative directory of the skill (monorepo support). */
  subdir?: string
  /** The local version baseline the user claims, when known. */
  baseline?: { version?: string; commit?: string; tree?: string }
}

export interface SkillSourceResponse {
  ok: boolean
  task?: TaskState
  record?: import('./types').SkillRecord
  error?: string
}

/** Pushed over polling: aggregate update status for the stat bars. */
export interface UpdateSummary {
  plugins: { available: number; checked: number; total: number }
  skills: { available: number; checked: number; total: number }
}

/** Convert one plan entry to the user-facing risk lines shown before confirmation. */
export function planEntryRiskText(entry: UpdatePlanEntry): string {
  if (entry.excludedReason !== undefined) return entry.excludedReason
  const parts: string[] = []
  if (entry.needsRestart) parts.push('更新后需要重启 DSH 才能生效')
  if (entry.requiresConfirmation) parts.push('需要确认来源或覆盖本地修改')
  if (entry.risk !== undefined) parts.push(entry.risk)
  return parts.join('；') || '这项更新可以安全自动完成'
}

/** Empty skill stats constant, useful for clients while data loads. */
export const EMPTY_SKILL_STATS: SkillStats = {
  physical: 0,
  runtime: 0,
  effective: 0,
  shadowed: 0,
  notManaged: 0,
  updatesAvailable: 0,
  abnormal: 0,
}
