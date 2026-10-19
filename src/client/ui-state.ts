/**
 * Persisted, non-sensitive UI state for the manager section: active page,
 * search/filter/sort, collapsed groups and the filter panel. Only IDs/keys, no
 * user data or paths beyond the selected Skills workspace id are stored.
 */
import type { SortKey, StatusFilter, RecordFilters, ViewScope } from './model'
import { defaultFilters, SORT_OPTIONS, STATUS_OPTIONS } from './model'

const KEY = 'dsh-extension-manager.ui.v1'
const VALID_STATUS: Record<ViewScope, ReadonlySet<string>> = {
  plugins: new Set(STATUS_OPTIONS.plugins.map(option => option.value)),
  skills: new Set(STATUS_OPTIONS.skills.map(option => option.value)),
}
const VALID_SORT = new Set(SORT_OPTIONS.map(option => option.value))

/** Serializable UI state; everything is validated on read. */
export interface PersistedUiState {
  scope: ViewScope
  pluginFilters: RecordFilters
  skillFilters: RecordFilters
  pluginCollapsed: string[]
  skillCollapsed: string[]
  pluginFiltersOpen: boolean
  skillFiltersOpen: boolean
  skillWorkspace: string | undefined
}

function validFilters(value: unknown, scope: ViewScope): RecordFilters {
  const fallback = defaultFilters()
  if (typeof value !== 'object' || value === null) return fallback
  const raw = value as Record<string, unknown>
  const status = typeof raw.status === 'string' && VALID_STATUS[scope].has(raw.status)
    ? raw.status as StatusFilter
    : fallback.status
  const sort = typeof raw.sort === 'string' && VALID_SORT.has(raw.sort as SortKey)
    ? raw.sort as SortKey
    : fallback.sort
  return {
    query: typeof raw.query === 'string' ? raw.query.slice(0, 200) : '',
    source: typeof raw.source === 'string' ? raw.source : 'all',
    status,
    range: typeof raw.range === 'string' ? raw.range : 'all',
    sort,
  }
}

function validCollapsed(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item !== '').slice(0, 50)
}

/** Read and validate the persisted UI state; any malformed field falls back safely. */
export function loadUiState(): PersistedUiState {
  const fallback: PersistedUiState = {
    scope: 'plugins',
    pluginFilters: defaultFilters(),
    skillFilters: defaultFilters(),
    pluginCollapsed: [],
    skillCollapsed: [],
    pluginFiltersOpen: false,
    skillFiltersOpen: false,
    skillWorkspace: undefined,
  }
  if (typeof window === 'undefined') return fallback
  try {
    const text = window.localStorage.getItem(KEY)
    if (text === null) return fallback
    const raw = JSON.parse(text) as Record<string, unknown>
    return {
      scope: raw.scope === 'skills' ? 'skills' : 'plugins',
      pluginFilters: validFilters(raw.pluginFilters, 'plugins'),
      skillFilters: validFilters(raw.skillFilters, 'skills'),
      pluginCollapsed: validCollapsed(raw.pluginCollapsed),
      skillCollapsed: validCollapsed(raw.skillCollapsed),
      pluginFiltersOpen: raw.pluginFiltersOpen === true,
      skillFiltersOpen: raw.skillFiltersOpen === true,
      skillWorkspace: typeof raw.skillWorkspace === 'string' && raw.skillWorkspace !== '' ? raw.skillWorkspace : undefined,
    }
  } catch {
    return fallback
  }
}

let pending: ReturnType<typeof setTimeout> | undefined

/** Persist UI state with a short debounce; storage failures are ignored. */
export function saveUiState(state: PersistedUiState): void {
  if (typeof window === 'undefined') return
  if (pending !== undefined) clearTimeout(pending)
  pending = setTimeout(() => {
    pending = undefined
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state))
    } catch {
      // Quota/private-mode failures must never affect the page.
    }
  }, 250)
}
