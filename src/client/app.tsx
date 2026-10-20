/**
 * Extension Manager settings page: owns the two inventories, per-page view
 * state (search/filter/sort/collapse survive tab switches), the async task
 * lifecycle, dialogs and all banners.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconRefreshOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DiagnosticsResponse } from '../shared/api'
import type {
  HistoryEntry,
  PluginInventoryPayload,
  SkillsInventoryPayload,
  TaskState,
  UpdatePlan,
} from '../shared/types'
import {
  ApiError,
  apiErrorDetail,
  apiErrorText,
  createTransport,
  isAbortError,
  type Transport,
} from './api'
import { DiagnosticsDialog, failedSources } from './components/diagnostics-dialog'
import { DetailsDialog } from './components/details-dialog'
import { HeaderBar } from './components/header'
import { RecordList } from './components/record-list'
import { StatsBar } from './components/stats'
import { TaskPanel } from './components/task-panel'
import { Toolbar } from './components/toolbar'
import { UpdateDialog, type UpdateDialogMode } from './components/update-dialog'
import {
  buildGroups,
  checkTaskIsComplete,
  defaultFilters,
  formatClock,
  formatDateTime,
  formatDuration,
  isSkillCopy,
  pendingRestartCount,
  pluginStatCells,
  pluginStatsSummary,
  PLUGIN_RANGE_OPTIONS,
  recordName,
  recordsOf,
  skillStatCells,
  skillStatsSummary,
  sourceGroupOptions,
  unmanagedRootKeys,
  type ExtensionRecord,
  type RecordFilters,
  type StatCell,
  type ViewScope,
} from './model'
import { InlineNotice, RunningLine } from './ui'
import { fallbackUseWorkspaces } from './workspaces'
import {
  beginInventoryRequest,
  inventoryCacheKey,
  readInventoryCache,
  writeInventoryCache,
  INVENTORY_FRESH_MS,
} from './inventory-cache'
import { loadUiState, saveUiScroll, saveUiState } from './ui-state'

type SectionProps = PropsRuntime<'settings.section'>

/** One inventory load, independent per page. */
type LoadState<Payload> =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; data: Payload; loadedAt: number; staleError?: string | undefined }
  | { phase: 'error'; error: ApiError }

/** The task currently shown in the task panel. */
interface ActiveTask {
  id: string
  task: TaskState | null
  scope: ViewScope
  origin: 'check' | 'update'
  /** Transport-level failure of the polling itself. */
  pollError?: string | undefined
}

/** Per-page result-panel display state; business results live separately. */
interface TaskPanelView {
  dismissed: boolean
  showItems: boolean
}

/** The task result belongs to one scope and is never rendered on the other. */
type ActiveTaskMap = Record<ViewScope, ActiveTask | null>
type TaskViewMap = Record<ViewScope, TaskPanelView>

/** State of the update confirmation dialog. */
interface UpdateDialogState {
  open: boolean
  mode: UpdateDialogMode
  plan: UpdatePlan | null
  loading: boolean
  error?: string | undefined
  /** Record ids the plan was requested for (kept for retry). */
  ids?: string[] | undefined
}

/** One transient toast. */
interface ToastState {
  key: number
  text: string
  success: boolean
}

/** Result of one completed check, tied to the inventory shape it was computed from. */
interface CheckViewState {
  /** True only when the whole check finished successfully. */
  valid: boolean
  /** Stable inventory signature captured after the check. */
  signature: string
  /** Number of entries the existing batch plan would run without confirmation. */
  batchCount?: number
  /** Lightweight result text for the toolbar when the batch button stays hidden. */
  message?: string
}

/** Identity/version/eligibility snapshot; search and filtering do not affect it. */
function recordsSignature(records: readonly ExtensionRecord[]): string {
  return records.map(record => [
    record.id,
    record.version.current ?? '',
    record.version.available ?? '',
    record.version.status,
    record.actions.canUpdate ? '1' : '0',
    record.actions.requiresConfirmation === true ? '1' : '0',
    record.source.kind,
    record.source.spec ?? '',
    record.source.ref ?? '',
    record.source.commit ?? '',
    record.localModification.state,
  ].join('')).sort().join('')
}

/** Read data from a settled load state. */
function readyData<Payload>(state: LoadState<Payload>): Payload | undefined {
  return state.phase === 'ready' ? state.data : undefined
}

/** Placeholder cells shown while the first inventory load runs (or failed). */
function loadingCells(scope: ViewScope): StatCell[] {
  const labels = ['已安装', '可更新', '异常']
  return labels.map((label, index) => ({ key: `loading-${String(index)}`, label, value: 0, valueText: '—', hint: '清单尚未加载' }))
}

/** Whether a task is still executing. */
function taskIsRunning(task: TaskState | null): boolean {
  return task !== null && (task.status === 'queued' || task.status === 'running')
}

/** Format the quiet scan metadata line of one page. */
function scanMetadata(
  scope: ViewScope,
  plugins: PluginInventoryPayload | undefined,
  skills: SkillsInventoryPayload | undefined,
): { meta: string | undefined; title: string | undefined } {
  const payload = scope === 'plugins' ? plugins : skills
  if (payload === undefined) return { meta: undefined, title: undefined }
  const reconciliation = payload.reconciliation
  const clock = formatClock(reconciliation.scannedAt)
  const duration = formatDuration(reconciliation.durationMs)
  const workspace = scope === 'skills' && 'workspace' in payload && payload.workspace?.name !== undefined
    ? `工作区 ${payload.workspace.name}`
    : undefined
  const parts = [workspace, clock === undefined ? undefined : `扫描于 ${clock}`, duration === undefined ? undefined : `用时 ${duration}`]
  const meta = parts.filter((part): part is string => part !== undefined).join(' · ')
  const failed = reconciliation.sources.filter(source => !source.complete).length
  const title = [
    `扫描时间：${formatDateTime(reconciliation.scannedAt) ?? '未知'}`,
    `${String(reconciliation.sources.length)} 个来源${failed === 0 ? '，全部读取完整' : `，${String(failed)} 个不完整`}`,
  ].join('\n')
  return { meta: meta === '' ? undefined : meta, title }
}

const EMPTY_COLLISIONS: ReadonlyMap<string, number> = new Map()
const EMPTY_ROOTS: ReadonlySet<string> = new Set()

/** The settings section body. */
export function ExtensionManagerSection(props: SectionProps): ReactNode {
  const [transport] = useState<Transport>(() => createTransport())
  // Global standard hook supplied by ui-workspace; the fallback only exists for
  // profiles that do not load that plugin.
  const useWorkspaces = props.useWorkspaces ?? fallbackUseWorkspaces
  const workspaceItems = useWorkspaces(snapshot => snapshot.items)
  const preview = transport.preview
  const savedUi = useMemo(loadUiState, [])
  const initialPluginCache = readInventoryCache<PluginInventoryPayload>('plugins')
  const initialSkillCache = readInventoryCache<SkillsInventoryPayload>(inventoryCacheKey('skills', savedUi.skillWorkspace))
  const [scope, setScope] = useState<ViewScope>(savedUi.scope)
  const [plugins, setPlugins] = useState<LoadState<PluginInventoryPayload>>(() => initialPluginCache === undefined
    ? { phase: 'idle' }
    : { phase: 'ready', data: initialPluginCache.data, loadedAt: initialPluginCache.loadedAt })
  const [skills, setSkills] = useState<LoadState<SkillsInventoryPayload>>(() => initialSkillCache === undefined
    ? { phase: 'idle' }
    : { phase: 'ready', data: initialSkillCache.data, loadedAt: initialSkillCache.loadedAt })
  const [pluginsRefreshing, setPluginsRefreshing] = useState(false)
  const [skillsRefreshing, setSkillsRefreshing] = useState(false)
  const [pluginFilters, setPluginFilters] = useState<RecordFilters>(savedUi.pluginFilters)
  const [skillFilters, setSkillFilters] = useState<RecordFilters>(savedUi.skillFilters)
  const [pluginFiltersOpen, setPluginFiltersOpen] = useState(savedUi.pluginFiltersOpen)
  const [skillFiltersOpen, setSkillFiltersOpen] = useState(savedUi.skillFiltersOpen)
  const [pluginCollapsed, setPluginCollapsed] = useState<ReadonlySet<string>>(() => new Set(savedUi.pluginCollapsed))
  const [skillCollapsed, setSkillCollapsed] = useState<ReadonlySet<string>>(() => new Set(savedUi.skillCollapsed))
  const [activeTasks, setActiveTasks] = useState<ActiveTaskMap>({ plugins: null, skills: null })
  const [taskViews, setTaskViews] = useState<TaskViewMap>({
    plugins: { dismissed: false, showItems: false },
    skills: { dismissed: false, showItems: false },
  })
  const activeTaskIdsRef = useRef<Record<ViewScope, string | undefined>>({ plugins: undefined, skills: undefined })
  const scopeRef = useRef<ViewScope>(scope)
  const [selected, setSelected] = useState<ExtensionRecord | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState>({ open: false, mode: 'batch', plan: null, loading: false })
  const [updateBusy, setUpdateBusy] = useState(false)
  const [checkingAction, setCheckingAction] = useState(false)
  const [checkStates, setCheckStates] = useState<Partial<Record<ViewScope, CheckViewState>>>({})
  const [actionError, setActionError] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [online, setOnline] = useState<boolean>(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  const [skillWorkspace, setSkillWorkspace] = useState<string | undefined>(savedUi.skillWorkspace)
  const skillWorkspaceRef = useRef<string | undefined>(savedUi.skillWorkspace)
  const rootRef = useRef<HTMLElement | null>(null)
  const pluginScrollRef = useRef(savedUi.pluginsScrollTop)
  const skillScrollRef = useRef(savedUi.skillsScrollTop)

  /* ---------------------------------------------------------------- *
   * Network status
   * ---------------------------------------------------------------- */
  useEffect(() => {
    const goOnline = (): void => { setOnline(true) }
    const goOffline = (): void => { setOnline(false) }
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  useEffect(() => { scopeRef.current = scope }, [scope])

  /* ---------------------------------------------------------------- *
   * Inventory loading
   * ---------------------------------------------------------------- */
  const loadPlugins = useCallback(async (options: { refresh?: boolean; background?: boolean } = {}): Promise<PluginInventoryPayload | undefined> => {
    const key = 'plugins' as const
    const cached = readInventoryCache<PluginInventoryPayload>(key)
    if (cached !== undefined) {
      setPlugins(current => current.phase === 'ready'
        ? current
        : { phase: 'ready', data: cached.data, loadedAt: cached.loadedAt })
      if (options.refresh !== true && Date.now() - cached.loadedAt < INVENTORY_FRESH_MS) return cached.data
    }
    if (options.background !== true) {
      setPlugins(current => current.phase === 'ready' ? { ...current, staleError: undefined } : { phase: 'loading' })
      setPluginsRefreshing(true)
    }
    const request = beginInventoryRequest(key)
    try {
      const payload = await transport.plugins({ refresh: options.refresh === true, signal: request.signal })
      if (!request.isCurrent()) return undefined
      writeInventoryCache(key, payload)
      setPlugins({ phase: 'ready', data: payload, loadedAt: Date.now() })
      return payload
    } catch (caught) {
      if (!request.isCurrent() || isAbortError(caught)) return undefined
      const message = apiErrorText(caught)
      setPlugins(current => current.phase === 'ready'
        ? { ...current, staleError: message }
        : { phase: 'error', error: caught instanceof ApiError ? caught : new ApiError('invalid', message) })
      return undefined
    } finally {
      if (request.isCurrent()) setPluginsRefreshing(false)
    }
  }, [transport])

  const loadSkills = useCallback(async (
    options: { refresh?: boolean; background?: boolean; workspace?: string | undefined } = {},
  ): Promise<SkillsInventoryPayload | undefined> => {
    const workspace = options.workspace ?? skillWorkspaceRef.current
    const key = inventoryCacheKey('skills', workspace)
    const cached = readInventoryCache<SkillsInventoryPayload>(key)
    if (cached !== undefined) {
      setSkills(current => current.phase === 'ready'
        ? current
        : { phase: 'ready', data: cached.data, loadedAt: cached.loadedAt })
      if (options.refresh !== true && Date.now() - cached.loadedAt < INVENTORY_FRESH_MS) return cached.data
    }
    if (options.background !== true) {
      setSkills(current => current.phase === 'ready' ? { ...current, staleError: undefined } : { phase: 'loading' })
      setSkillsRefreshing(true)
    }
    const request = beginInventoryRequest(key)
    try {
      const payload = await transport.skills({
        refresh: options.refresh === true,
        ...(workspace === undefined ? {} : { workspace }),
        signal: request.signal,
      })
      if (!request.isCurrent() || workspace !== skillWorkspaceRef.current) return undefined
      writeInventoryCache(key, payload)
      setSkills({ phase: 'ready', data: payload, loadedAt: Date.now() })
      return payload
    } catch (caught) {
      if (!request.isCurrent() || workspace !== skillWorkspaceRef.current || isAbortError(caught)) return undefined
      const message = apiErrorText(caught)
      setSkills(current => current.phase === 'ready'
        ? { ...current, staleError: message }
        : { phase: 'error', error: caught instanceof ApiError ? caught : new ApiError('invalid', message) })
      return undefined
    } finally {
      if (request.isCurrent() && workspace === skillWorkspaceRef.current) setSkillsRefreshing(false)
    }
  }, [transport])

  useEffect(() => { void loadPlugins({ background: true }) }, [loadPlugins])

  // Load a page on first visit, and quietly prefetch the other one afterwards.
  useEffect(() => {
    if (scope === 'skills' && skills.phase === 'idle') void loadSkills({ background: true })
  }, [scope, skills.phase, loadSkills])

  useEffect(() => {
    if (plugins.phase !== 'ready' || skills.phase !== 'idle') return
    const timer = setTimeout(() => { void loadSkills({ background: true }) }, 900)
    return () => { clearTimeout(timer) }
  }, [plugins.phase, skills.phase, loadSkills])

  /* ---------------------------------------------------------------- *
   * Task lifecycle
   * ---------------------------------------------------------------- */
  const finishTask = useCallback((task: TaskState, taskScope: ViewScope, origin: 'check' | 'update'): void => {
    // A finished check/update changes the records' cached statuses; always
    // re-read both the Host inventory and the check cache instead of reusing a
    // fresh-looking snapshot from before the task.
    const reloaded = taskScope === 'plugins'
      ? loadPlugins({ refresh: true, background: true })
      : loadSkills({ refresh: true, background: true })
    const announce = (text: string, success: boolean): void => {
      // A completion toast follows the page that owns the task, not whichever
      // page happens to be selected when the task finishes.
      if (scopeRef.current === taskScope) setToast({ key: Date.now(), text, success })
    }
    void reloaded.then(async (payload) => {
      if (origin === 'check' && task.kind === 'check') {
        const freshRecords = payload === undefined ? undefined : recordsOf(payload)
        const failedItems = task.items.filter(item => item.status === 'failed')
        let complete = checkTaskIsComplete(task) && freshRecords !== undefined
        let message = complete
          ? undefined
          : task.status === 'failed'
            ? `检查失败：${task.error ?? task.message ?? '请重试'}`
            : task.status === 'cancelled'
              ? '检查已取消，请重新检查。'
              : freshRecords === undefined
                ? '检查完成，但清单刷新失败，请刷新列表后重试。'
                : `检查未完整成功${failedItems.length === 0 ? '' : `（${String(failedItems.length)} 项失败）`}，请重新检查。`
        let batchCount: number | undefined
        if (complete && freshRecords !== undefined) {
          try {
            // Use the existing read-only plan to count entries that the batch
            // confirmation flow would actually execute without confirmation.
            const plan = await transport.updatePlan({ scope: taskScope })
            batchCount = plan.entries.filter(entry => entry.eligible && entry.requiresConfirmation !== true).length
            if (batchCount === 0) message = '检查完成，暂无可批量更新的项目。'
          } catch (caught) {
            complete = false
            message = `检查完成，但无法生成批量更新计划：${apiErrorText(caught)}`
          }
        }
        setCheckStates(previous => ({
          ...previous,
          [taskScope]: {
            valid: complete,
            signature: freshRecords === undefined ? '' : recordsSignature(freshRecords),
            ...(batchCount === undefined ? {} : { batchCount }),
            ...(message === undefined ? {} : { message }),
          },
        }))
        if (!complete) {
          announce(message ?? '检查未完整成功，请重新检查', false)
        } else {
          announce(task.message ?? '检查完成', true)
        }
        return
      }
      if (origin === 'update') {
        // An update changes versions and eligibility; never keep an old batch
        // result around even if the refreshed inventory is not available yet.
        setCheckStates(previous => {
          const next = { ...previous }
          delete next[taskScope]
          return next
        })
      }
      if (task.status === 'done') {
        announce(task.message ?? '任务已完成', true)
      } else if (task.status === 'failed') {
        announce(`任务失败：${task.error ?? task.message ?? '请在任务面板查看详情'}`, false)
      }
    })
  }, [loadPlugins, loadSkills, transport])

  useEffect(() => {
    const entries: Array<[ViewScope, ActiveTask]> = []
    for (const slot of ['plugins', 'skills'] as const) {
      const active = activeTasks[slot]
      if (active === null) continue
      const current = active.task
      if (current !== null && (current.status === 'done' || current.status === 'failed' || current.status === 'cancelled')) continue
      entries.push([slot, active])
    }
    if (entries.length === 0) return
    const controllers: AbortController[] = []
    let cancelled = false
    for (const [slot, active] of entries) {
      const controller = new AbortController()
      controllers.push(controller)
      void transport.waitForTask(active.id, {
        signal: controller.signal,
        onTask: (task) => {
          if (cancelled || activeTaskIdsRef.current[slot] !== task.id) return
          setActiveTasks(previous => {
            const current = previous[slot]
            if (current === null || current.id !== task.id) return previous
            return { ...previous, [slot]: { ...current, task } }
          })
        },
      }).then((task) => {
        if (cancelled || activeTaskIdsRef.current[slot] !== task.id) return
        setActiveTasks(previous => {
          const current = previous[slot]
          if (current === null || current.id !== task.id) return previous
          return { ...previous, [slot]: { ...current, task } }
        })
        finishTask(task, slot, active.origin)
      }).catch((caught: unknown) => {
        if (cancelled || isAbortError(caught) || activeTaskIdsRef.current[slot] !== active.id) return
        const message = apiErrorText(caught)
        // A task snapshot can disappear when the Host plugin graph reloads.
        setActiveTasks(previous => {
          const current = previous[slot]
          if (current === null || current.id !== active.id) return previous
          const failedTask: TaskState | null = current.task === null
            ? null
            : {
              ...current.task,
              status: 'failed',
              finishedAt: new Date().toISOString(),
              error: message,
              message: '无法获取任务状态：Host 可能已重载或任务已过期',
            }
          return { ...previous, [slot]: { ...current, task: failedTask, pollError: message } }
        })
        void (slot === 'plugins'
          ? loadPlugins({ refresh: true, background: true })
          : loadSkills({ refresh: true, background: true }))
      })
    }
    return () => {
      cancelled = true
      for (const controller of controllers) controller.abort()
    }
    // Polling is keyed by task ids; per-task status updates flow through state.
  }, [activeTasks.plugins?.id, activeTasks.skills?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Adopt a running task for the selected page after a page reload.
  useEffect(() => {
    if (activeTasks[scope] !== null) return
    const payload = scope === 'plugins' ? readyData(plugins) : readyData(skills)
    const check = payload?.check
    if (check?.running !== true || check.taskId === undefined) return
    let cancelled = false
    void transport.task(check.taskId).then((response) => {
      if (cancelled || response.task === undefined) return
      if (response.pending !== true) return
      const adopted = response.task
      const actualSlot = adopted.scope === 'plugins' || adopted.scope === 'skills' ? adopted.scope : scope
      activeTaskIdsRef.current[actualSlot] = adopted.id
      setActiveTasks(previous => previous[actualSlot] === null
        ? { ...previous, [actualSlot]: { id: adopted.id, task: adopted, scope: actualSlot, origin: adopted.kind === 'check' ? 'check' : 'update' } }
        : previous)
      setTaskViews(previous => ({ ...previous, [actualSlot]: { dismissed: false, showItems: false } }))
    }).catch(() => { /* stale task id: the Host forgot it, nothing to adopt */ })
    return () => { cancelled = true }
  }, [activeTasks, scope, plugins, skills, transport])

  const beginTask = useCallback((task: TaskState, taskScope: ViewScope, origin: 'check' | 'update'): void => {
    const actualSlot = task.scope === 'plugins' || task.scope === 'skills' ? task.scope : taskScope
    if (actualSlot !== taskScope) {
      setActionError('另一类扩展的检查任务正在执行，请等待完成后再试；完成结果会保留在所属页面。')
    }
    activeTaskIdsRef.current[actualSlot] = task.id
    setActiveTasks(previous => ({
      ...previous,
      [actualSlot]: { id: task.id, task, scope: actualSlot, origin },
    }))
    setTaskViews(previous => ({ ...previous, [actualSlot]: { dismissed: false, showItems: false } }))
    if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
      finishTask(task, actualSlot, origin)
    }
  }, [finishTask])

  const runCheck = useCallback(async (ids?: string[]): Promise<void> => {
    setActionError(null)
    // The old count must never authorize a new batch while this check runs.
    setCheckStates(previous => {
      const next = { ...previous }
      delete next[scope]
      return next
    })
    setCheckingAction(true)
    try {
      const task = await transport.check({ scope, ...(ids === undefined ? {} : { ids }) })
      beginTask(task, scope, 'check')
    } catch (caught) {
      setActionError(apiErrorText(caught))
    } finally {
      setCheckingAction(false)
    }
  }, [scope, transport, beginTask])

  const requestPlan = useCallback(async (mode: UpdateDialogMode, ids?: string[]): Promise<void> => {
    setActionError(null)
    setSelected(null)
    setUpdateDialog({ open: true, mode, plan: null, loading: true, ...(ids === undefined ? {} : { ids }) })
    try {
      const plan = await transport.updatePlan({ scope, ...(ids === undefined ? {} : { ids }) })
      if (plan.entries.length === 0 && plan.excluded.length === 0) {
        setUpdateDialog({ open: false, mode, plan: null, loading: false })
        setToast({ key: Date.now(), text: '没有可更新的项目', success: false })
        return
      }
      setUpdateDialog({ open: true, mode, plan, loading: false, ...(ids === undefined ? {} : { ids }) })
    } catch (caught) {
      setUpdateDialog({
        open: true,
        mode,
        plan: null,
        loading: false,
        ...(ids === undefined ? {} : { ids }),
        error: apiErrorText(caught),
      })
    }
  }, [scope, transport])

  const confirmUpdate = useCallback(async (ids: string[], overwriteLocalModifications: boolean): Promise<void> => {
    setUpdateBusy(true)
    try {
      const response = await transport.update({
        scope,
        ids,
        confirmed: true,
        ...(overwriteLocalModifications ? { overwriteLocalModifications: true } : {}),
      })
      setUpdateDialog({ open: false, mode: 'batch', plan: null, loading: false })
      beginTask(response.task, scope, 'update')
    } catch (caught) {
      const message = apiErrorText(caught)
      setUpdateDialog(current => ({ ...current, error: message, loading: false }))
    } finally {
      setUpdateBusy(false)
    }
  }, [scope, transport, beginTask])

  const refreshActive = useCallback((): void => {
    setActionError(null)
    void (scope === 'plugins' ? loadPlugins({ refresh: true }) : loadSkills({ refresh: true }))
  }, [scope, loadPlugins, loadSkills])

  const reloadScope = useCallback((): void => {
    setActionError(null)
    void (scope === 'plugins' ? loadPlugins({ refresh: true }) : loadSkills({ refresh: true }))
  }, [scope, loadPlugins, loadSkills])

  const loadDiagnostics = useCallback((): Promise<DiagnosticsResponse> => transport.diagnostics(), [transport])
  const loadHistory = useCallback((): Promise<HistoryEntry[]> => transport.history(), [transport])

  /* ---------------------------------------------------------------- *
   * Derived data
   * ---------------------------------------------------------------- */
  const pluginsData = readyData(plugins)
  const skillsData = readyData(skills)
  const activePayload = scope === 'plugins' ? pluginsData : skillsData
  const pluginRecords = useMemo<ExtensionRecord[]>(
    () => pluginsData === undefined ? [] : recordsOf(pluginsData),
    [pluginsData],
  )
  const skillRecords = useMemo<ExtensionRecord[]>(
    () => skillsData === undefined ? [] : recordsOf(skillsData),
    [skillsData],
  )
  const activeRecords = scope === 'plugins' ? pluginRecords : skillRecords
  const activeSignature = useMemo(() => recordsSignature(activeRecords), [activeRecords])
  const activeCheckState = checkStates[scope]
  const checkValid = activeCheckState?.valid === true && activeCheckState.signature === activeSignature
  const checkNotice = activeCheckState !== undefined && activeCheckState.signature === activeSignature
    ? activeCheckState.message
    : undefined
  const unmanagedRoots = useMemo(() => unmanagedRootKeys(skillsData), [skillsData])
  const skillCollisions = useMemo<ReadonlyMap<string, number>>(() => {
    const counts = new Map<string, number>()
    for (const record of skillRecords) {
      if (!isSkillCopy(record) || unmanagedRoots.has(record.rootKey) || record.rootNote !== undefined) continue
      const name = recordName(record)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return counts
  }, [skillRecords, unmanagedRoots])
  const activeFilters = scope === 'plugins' ? pluginFilters : skillFilters
  const activeCollapsed = scope === 'plugins' ? pluginCollapsed : skillCollapsed
  const groups = useMemo(
    () => buildGroups(activeRecords, activeFilters, scope, unmanagedRoots),
    [activeRecords, activeFilters, scope, unmanagedRoots],
  )
  const statCells = useMemo<StatCell[]>(() => {
    if (scope === 'plugins') {
      return pluginsData === undefined ? loadingCells('plugins') : pluginStatCells(pluginsData.stats)
    }
    return skillsData === undefined ? loadingCells('skills') : skillStatCells(skillsData.stats)
  }, [scope, pluginsData, skillsData])
  const statSummary = scope === 'plugins'
    ? (pluginsData === undefined ? '' : pluginStatsSummary(pluginsData.stats))
    : (skillsData === undefined ? '' : skillStatsSummary(skillsData.stats))
  const matchedCount = groups.reduce((sum, group) => sum + group.records.length, 0)
  const filtersOpen = scope === 'plugins' ? pluginFiltersOpen : skillFiltersOpen
  const toggleFilters = useCallback((): void => {
    if (scope === 'plugins') setPluginFiltersOpen(open => !open)
    else setSkillFiltersOpen(open => !open)
  }, [scope])
  const dialogOpen = selected !== null || diagnosticsOpen || updateDialog.open
  const onRootKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target as HTMLElement
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
    if (event.key === '/' && !typing && !dialogOpen) {
      event.preventDefault()
      rootRef.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
      return
    }
    if (event.key !== 'Escape' || dialogOpen) return
    if (filtersOpen) {
      event.preventDefault()
      toggleFilters()
      return
    }
    if (activeFilters.query !== '') {
      event.preventDefault()
      setActiveFilters({ ...activeFilters, query: '' })
      return
    }
    const search = rootRef.current?.querySelector<HTMLInputElement>('input[type="search"]')
    if (search !== undefined && search !== null && document.activeElement === search) {
      event.preventDefault()
      search.blur()
    }
  }
  const title = scanMetadata(scope, pluginsData, skillsData)
  const currentTask = activeTasks[scope]
  const currentTaskView = taskViews[scope]
  const busy = taskIsRunning(currentTask?.task ?? null) || updateBusy || checkingAction
  const checkingIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>()
    if (currentTask?.origin !== 'check' || currentTask.task === null) return ids
    for (const item of currentTask.task.items) {
      if (item.status === 'running' || item.status === 'pending') ids.add(item.id)
    }
    return ids
  }, [currentTask])
  const reconciliation = activePayload?.reconciliation
  const restartPending = pendingRestartCount(activeRecords)
  const activeSourceOptions = useMemo(() => sourceGroupOptions(activeRecords), [activeRecords])
  const workspaceSelector = useMemo(() => {
    if (workspaceItems.length === 0) return undefined
    const options = [
      { id: '', label: '默认（Host 工作目录）' },
      ...workspaceItems.map(workspace => ({
        id: workspace.path,
        label: `${workspace.title} · ${workspace.path}`,
      })),
    ]
    return { value: skillWorkspace ?? '', options }
  }, [workspaceItems, skillWorkspace])
  /* ---------------------------------------------------------------- *
   * Handlers
   * ---------------------------------------------------------------- */
  const setActiveFilters = (next: RecordFilters): void => {
    if (scope === 'plugins') setPluginFilters(next)
    else setSkillFilters(next)
  }

  const toggleGroup = useCallback((key: string): void => {
    const update = (previous: ReadonlySet<string>): ReadonlySet<string> => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    }
    if (scope === 'plugins') setPluginCollapsed(update)
    else setSkillCollapsed(update)
  }, [scope])

  const toggleStatFilter = useCallback((filter: RecordFilters['status']): void => {
    const next: RecordFilters = { ...activeFilters, status: activeFilters.status === filter ? 'all' : filter }
    if (scope === 'plugins') setPluginFilters(next)
    else setSkillFilters(next)
  }, [scope, activeFilters])

  const clearFilters = useCallback((): void => {
    const fresh = defaultFilters()
    if (scope === 'plugins') setPluginFilters(fresh)
    else setSkillFilters(fresh)
  }, [scope])

  /** Rescan the project skill roots for one registered workspace (or the default). */
  const selectSkillWorkspace = useCallback((id: string): void => {
    const workspace = id === '' ? undefined : id
    if (workspace === skillWorkspaceRef.current) return
    skillWorkspaceRef.current = workspace
    setSkillWorkspace(workspace)
    setSkills({ phase: 'loading' })
    void loadSkills({ workspace })
  }, [loadSkills])

  const retryFailed = useCallback((ids: string[]): void => {
    void requestPlan('retry', ids)
  }, [requestPlan])

  // Keep an open details dialog on the freshest record after a refresh: match by
  // id so a re-scan that replaces the object never leaves stale facts on screen.
  const selectedRecord = selected === null
    ? null
    : activeRecords.find(record => record.id === selected.id) ?? selected

  /* ---------------------------------------------------------------- *
   * Persisted UI state
   * ---------------------------------------------------------------- */
  useEffect(() => {
    saveUiState({
      scope,
      pluginFilters,
      skillFilters,
      pluginCollapsed: [...pluginCollapsed],
      skillCollapsed: [...skillCollapsed],
      pluginFiltersOpen,
      skillFiltersOpen,
      skillWorkspace,
      pluginsScrollTop: pluginScrollRef.current,
      skillsScrollTop: skillScrollRef.current,
    })
  }, [scope, pluginFilters, skillFilters, pluginCollapsed, skillCollapsed, pluginFiltersOpen, skillFiltersOpen, skillWorkspace])

  /* Restore and remember the page's list scroll offset (the nearest scrollable
   * ancestor of this section inside the Settings panel). */
  useEffect(() => {
    const root = rootRef.current
    if (root === null) return
    let parent: HTMLElement | null = root.parentElement
    while (parent !== null) {
      const overflow = getComputedStyle(parent).overflowY
      if ((overflow === 'auto' || overflow === 'scroll') && parent.scrollHeight > parent.clientHeight) break
      parent = parent.parentElement
    }
    if (parent === null) return
    const target = parent
    target.scrollTop = scope === 'plugins' ? pluginScrollRef.current : skillScrollRef.current
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (scope === 'plugins') pluginScrollRef.current = target.scrollTop
        else skillScrollRef.current = target.scrollTop
        saveUiScroll(scope, target.scrollTop)
      }, 150)
    }
    target.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      target.removeEventListener('scroll', onScroll)
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [scope])

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */
  const incomplete = reconciliation !== undefined && !reconciliation.complete
  const incompleteSources = reconciliation?.sources.filter(source => !source.complete) ?? []
  const staleError = plugins.phase === 'ready' && scope === 'plugins'
    ? plugins.staleError
    : skills.phase === 'ready' && scope === 'skills' ? skills.staleError : undefined
  const loading = activePayload === undefined && (scope === 'plugins' ? plugins.phase === 'loading' || plugins.phase === 'idle' : skills.phase === 'loading' || skills.phase === 'idle')
  const error = scope === 'plugins' ? (plugins.phase === 'error' ? plugins.error : undefined) : (skills.phase === 'error' ? skills.error : undefined)
  const taskInFlight = taskIsRunning(currentTask?.task ?? null)

  return (
    <section className="em-root" aria-label="扩展管理器" ref={rootRef} onKeyDown={onRootKeyDown}>
      <HeaderBar
        scope={scope}
        onScopeChange={setScope}
        preview={preview}
        scanMeta={title.meta}
        scanTitle={title.title}
        onOpenDiagnostics={() => { setDiagnosticsOpen(true) }}
      />

      {preview ? (
        <InlineNotice tone="warning" title="预览数据（?emFixture=1）">
          当前页面使用本地示例数据做视觉与交互预览，所有数字与记录都不是本机真实状态；默认访问不会加载预览数据。
        </InlineNotice>
      ) : null}
      {online ? null : (
        <InlineNotice tone="danger" title="网络不可用">
          浏览器报告离线，扩展管理器无法连接 Host；恢复网络后点击刷新重试。
        </InlineNotice>
      )}
      {incomplete ? (
        <InlineNotice
          tone="warning"
          title={`清单不完整（${String(failedSources(reconciliation))} 个来源读取失败）`}
          actions={(
            <Button variant="outline" size="sm" onClick={() => { setDiagnosticsOpen(true) }}>查看诊断</Button>
          )}
        >
          <ul className="em-noticeList">
            {incompleteSources.slice(0, 4).map(source => (
              <li key={source.id}>
                <strong>{source.label}</strong>
                {source.error === undefined ? '：读取未完成' : `：${source.error}`}
              </li>
            ))}
            {incompleteSources.length > 4 ? <li>还有 {String(incompleteSources.length - 4)} 个来源读取失败，详情见诊断信息。</li> : null}
          </ul>
        </InlineNotice>
      ) : null}
      {restartPending === 0 ? null : (
        <InlineNotice tone="warning" title={`有 ${String(restartPending)} 项更新等待重启后生效`}>
          更新文件已经写入，但运行中的 DSH 仍在使用旧版本；请按你自己的节奏重启 DSH。扩展管理器不会自动重启服务。
        </InlineNotice>
      )}
      {staleError === undefined ? null : (
        <InlineNotice
          tone="danger"
          title="刷新清单失败，当前显示上次数据"
          actions={<Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={reloadScope}>重试</Button>}
        >
          {staleError}
        </InlineNotice>
      )}
      {actionError === null ? null : (
        <InlineNotice
          tone="danger"
          title="操作未完成"
          actions={<Button variant="ghost" size="sm" onClick={() => { setActionError(null) }}>关闭</Button>}
        >
          {actionError}
        </InlineNotice>
      )}

      <StatsBar
        cells={statCells}
        activeStatus={activeFilters.status}
        onToggleFilter={toggleStatFilter}
        loading={loading}
      />
      {loading || statSummary === '' ? null : (
        <details className="em-statsDetails">
          <summary>统计详情</summary>
          <p>{statSummary}</p>
        </details>
      )}

      <Toolbar
        scope={scope}
        filters={activeFilters}
        onFiltersChange={setActiveFilters}
        sourceOptions={activeSourceOptions}
        rangeOptions={PLUGIN_RANGE_OPTIONS}
        workspaceSelector={scope === 'skills' && workspaceSelector !== undefined
          ? { value: workspaceSelector.value, options: workspaceSelector.options, onChange: selectSkillWorkspace }
          : undefined}
        records={activeRecords}
        filtersOpen={filtersOpen}
        onToggleFilters={toggleFilters}
        matchedCount={matchedCount}
        totalCount={activeRecords.length}
        onClearFilters={clearFilters}
        ready={!loading && error === undefined}
        taskRunning={taskInFlight || updateBusy}
        refreshing={scope === 'plugins' ? pluginsRefreshing : skillsRefreshing}
        checking={checkingAction}
        checkValid={checkValid}
        checkNotice={checkNotice}
        batchCount={checkValid ? (activeCheckState?.batchCount ?? 0) : 0}
        onRefresh={refreshActive}
        onCheckAll={() => { void runCheck() }}
        onUpdateAll={() => { void requestPlan('batch') }}
      />

      {currentTask === null || currentTaskView.dismissed ? null : currentTask.task === null ? (
        <div className="em-task">
          <RunningLine text="正在启动任务…" />
        </div>
      ) : (
        <TaskPanel
          task={currentTask.task}
          showItems={currentTaskView.showItems}
          onToggleItems={() => {
            setTaskViews(previous => ({
              ...previous,
              [scope]: { ...previous[scope], showItems: !previous[scope].showItems },
            }))
          }}
          onRetryFailed={retryFailed}
          onDismiss={() => {
            setTaskViews(previous => ({
              ...previous,
              [scope]: { ...previous[scope], dismissed: true },
            }))
          }}
        />
      )}
      {currentTask?.pollError === undefined || currentTaskView.dismissed ? null : (
        <InlineNotice
          tone="danger"
          title="任务状态获取失败"
          actions={(
            <>
              <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={refreshActive}>
                刷新清单
              </Button>
              <Button variant="ghost" size="sm" onClick={() => {
                setTaskViews(previous => ({
                  ...previous,
                  [scope]: { ...previous[scope], dismissed: true },
                }))
              }}>关闭</Button>
            </>
          )}
        >
          {currentTask.pollError}。Host 可能已重载，任务状态已丢失；刷新清单可查看实际安装状态，中断的更新会由 Host 在下次启动时恢复或回滚。
        </InlineNotice>
      )}

      <div
        className="em-panel"
        role="tabpanel"
        id={`em-scope-${scope}-panel`}
        aria-labelledby={`em-scope-${scope}`}
        aria-busy={loading}
      >
        {loading ? (
          <div className="em-loading">
            <p className="em-loadingLine" role="status">正在读取 {scope === 'plugins' ? 'Plugins' : 'Skills'} 清单…</p>
            <div className="em-skeletonList" aria-hidden="true">
              {[0, 1, 2, 3].map(index => (
                <div key={index} className="em-skeletonRow">
                  <span className="em-skeletonIcon" />
                  <span className="em-skeletonBody">
                    <span className="em-skeletonBar" />
                    <span className="em-skeletonBar em-skeletonBarWide" />
                    <span className="em-skeletonBar em-skeletonBarShort" />
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {error === undefined || loading ? null : (
          <div className="em-errorBlock">
            <InlineNotice tone="danger" title={`${scope === 'plugins' ? 'Plugins' : 'Skills'}清单加载失败`}>
              {error.message}
              {apiErrorDetail(error) === undefined ? '' : `（${apiErrorDetail(error) ?? ''}）`}
            </InlineNotice>
            <div className="em-errorActions">
              <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={reloadScope}>重试</Button>
              <Button variant="ghost" size="sm" onClick={() => { setDiagnosticsOpen(true) }}>诊断信息</Button>
            </div>
            {preview ? <p className="em-detailMuted">预览模式下不会发生真实网络错误。</p> : null}
          </div>
        )}
        {loading || error !== undefined ? null : (
          <>
            <RecordList
              scope={scope}
              groups={groups}
              filters={activeFilters}
              collapsed={activeCollapsed}
              forceOpen={false}
              totalRecords={activeRecords.length}
              unmanagedRoots={unmanagedRoots}
              collisions={scope === 'skills' ? skillCollisions : EMPTY_COLLISIONS}
              onToggleGroup={toggleGroup}
              onOpenDetails={setSelected}
              onClearFilters={clearFilters}
              onRefresh={reloadScope}
            />
            <p className="em-panelFooter">
              {reconciliation === undefined
                ? ''
                : reconciliation.complete
                  ? `清单完整 · ${String(reconciliation.sources.length)} 个来源全部读取成功`
                  : `清单不完整 · ${String(failedSources(reconciliation))} 个来源读取失败`}
              {' '}
              <button type="button" className="em-linkButton" onClick={() => { setDiagnosticsOpen(true) }}>诊断信息</button>
            </p>
          </>
        )}
      </div>

      <DetailsDialog
        record={selectedRecord}
        busy={busy}
        checking={selectedRecord === null ? false : checkingIds.has(selectedRecord.id)}
        preview={preview}
        onClose={() => { setSelected(null) }}
        onCheck={(record) => { void runCheck([record.id]) }}
        onUpdate={(record) => { void requestPlan('single', [record.id]) }}
        onOpenDiagnostics={() => { setSelected(null); setDiagnosticsOpen(true) }}
        loadHistory={loadHistory}
        allRecords={scope === 'skills' ? skillRecords : pluginRecords}
        unmanagedRoots={scope === 'skills' ? unmanagedRoots : EMPTY_ROOTS}
      />
      <UpdateDialog
        open={updateDialog.open}
        mode={updateDialog.mode}
        plan={updateDialog.plan}
        loading={updateDialog.loading}
        error={updateDialog.error}
        busy={updateBusy}
        preview={preview}
        records={activeRecords}
        onClose={() => {
          if (updateBusy) return
          setUpdateDialog({ open: false, mode: 'batch', plan: null, loading: false })
        }}
        onRetry={() => { void requestPlan(updateDialog.mode, updateDialog.ids) }}
        onConfirm={(ids, overwrite) => { void confirmUpdate(ids, overwrite) }}
      />
      <DiagnosticsDialog
        open={diagnosticsOpen}
        preview={preview}
        plugins={pluginsData?.reconciliation}
        skills={skillsData?.reconciliation}
        skillRoots={skillsData?.roots}
        onClose={() => { setDiagnosticsOpen(false) }}
        loadDiagnostics={loadDiagnostics}
      />
      {toast === null ? null : (
        <Toast
          key={toast.key}
          text={toast.text}
          holdMs={Math.min(6000, 2600 + toast.text.length * 60)}
          {...(toast.success ? { tone: 'success' as const } : { icon: <IconWarningTriangleOutlineRegular size={14} /> })}
          onDone={() => { setToast(current => current !== null && current.key === toast.key ? null : current) }}
        />
      )}
    </section>
  )
}
