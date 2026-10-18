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
  defaultFilters,
  formatClock,
  formatDateTime,
  formatDuration,
  pendingRestartCount,
  pluginStatCells,
  PLUGIN_RANGE_OPTIONS,
  recordsOf,
  skillStatCells,
  sourceGroupOptions,
  unmanagedRootKeys,
  type ExtensionRecord,
  type RecordFilters,
  type StatCell,
  type ViewScope,
} from './model'
import { InlineNotice, RunningLine } from './ui'
import { fallbackUseWorkspaces } from './workspaces'

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

/** Read data from a settled load state. */
function readyData<Payload>(state: LoadState<Payload>): Payload | undefined {
  return state.phase === 'ready' ? state.data : undefined
}

/** Placeholder cells shown while the first inventory load runs (or failed). */
function loadingCells(scope: ViewScope): StatCell[] {
  const labels = scope === 'plugins'
    ? ['已安装', '已启用', '运行中', '可更新', '异常']
    : ['物理副本', '运行时生效', '已覆盖', '可更新', '异常']
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

/** The settings section body. */
export function ExtensionManagerSection(props: SectionProps): ReactNode {
  const [transport] = useState<Transport>(() => createTransport())
  // Global standard hook supplied by ui-workspace; the fallback only exists for
  // profiles that do not load that plugin.
  const useWorkspaces = props.useWorkspaces ?? fallbackUseWorkspaces
  const workspaceItems = useWorkspaces(snapshot => snapshot.items)
  const preview = transport.preview
  const [scope, setScope] = useState<ViewScope>('plugins')
  const [plugins, setPlugins] = useState<LoadState<PluginInventoryPayload>>({ phase: 'idle' })
  const [skills, setSkills] = useState<LoadState<SkillsInventoryPayload>>({ phase: 'idle' })
  const [pluginsRefreshing, setPluginsRefreshing] = useState(false)
  const [skillsRefreshing, setSkillsRefreshing] = useState(false)
  const [pluginFilters, setPluginFilters] = useState<RecordFilters>(defaultFilters)
  const [skillFilters, setSkillFilters] = useState<RecordFilters>(defaultFilters)
  const [pluginCollapsed, setPluginCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [skillCollapsed, setSkillCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [activeTask, setActiveTask] = useState<ActiveTask | null>(null)
  const [selected, setSelected] = useState<ExtensionRecord | null>(null)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [updateDialog, setUpdateDialog] = useState<UpdateDialogState>({ open: false, mode: 'batch', plan: null, loading: false })
  const [updateBusy, setUpdateBusy] = useState(false)
  const [checkingAction, setCheckingAction] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [online, setOnline] = useState<boolean>(() => typeof navigator === 'undefined' ? true : navigator.onLine)
  const [skillWorkspace, setSkillWorkspace] = useState<string | undefined>(undefined)
  const skillWorkspaceRef = useRef<string | undefined>(undefined)
  const pluginSeq = useRef(0)
  const skillSeq = useRef(0)

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

  /* ---------------------------------------------------------------- *
   * Inventory loading
   * ---------------------------------------------------------------- */
  const loadPlugins = useCallback(async (options: { refresh?: boolean; background?: boolean } = {}): Promise<void> => {
    const seq = ++pluginSeq.current
    if (options.background !== true) {
      setPlugins(current => current.phase === 'ready' ? { ...current, staleError: undefined } : { phase: 'loading' })
      setPluginsRefreshing(true)
    }
    try {
      const payload = await transport.plugins({ refresh: options.refresh === true })
      if (seq !== pluginSeq.current) return
      setPlugins({ phase: 'ready', data: payload, loadedAt: Date.now() })
    } catch (caught) {
      if (seq !== pluginSeq.current || isAbortError(caught)) return
      const message = apiErrorText(caught)
      setPlugins(current => current.phase === 'ready'
        ? { ...current, staleError: message }
        : { phase: 'error', error: caught instanceof ApiError ? caught : new ApiError('invalid', message) })
    } finally {
      if (seq === pluginSeq.current) setPluginsRefreshing(false)
    }
  }, [transport])

  const loadSkills = useCallback(async (
    options: { refresh?: boolean; background?: boolean; workspace?: string | undefined } = {},
  ): Promise<void> => {
    const seq = ++skillSeq.current
    if (options.background !== true) {
      setSkills(current => current.phase === 'ready' ? { ...current, staleError: undefined } : { phase: 'loading' })
      setSkillsRefreshing(true)
    }
    const workspace = options.workspace ?? skillWorkspaceRef.current
    try {
      const payload = await transport.skills({
        refresh: options.refresh === true,
        ...(workspace === undefined ? {} : { workspace }),
      })
      if (seq !== skillSeq.current) return
      setSkills({ phase: 'ready', data: payload, loadedAt: Date.now() })
    } catch (caught) {
      if (seq !== skillSeq.current || isAbortError(caught)) return
      const message = apiErrorText(caught)
      setSkills(current => current.phase === 'ready'
        ? { ...current, staleError: message }
        : { phase: 'error', error: caught instanceof ApiError ? caught : new ApiError('invalid', message) })
    } finally {
      if (seq === skillSeq.current) setSkillsRefreshing(false)
    }
  }, [transport])

  useEffect(() => { void loadPlugins() }, [loadPlugins])

  // Load a page on first visit, and quietly prefetch the other one afterwards.
  useEffect(() => {
    if (scope === 'skills' && skills.phase === 'idle') void loadSkills()
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
    void (taskScope === 'plugins'
      ? loadPlugins({ refresh: origin === 'update', background: true })
      : loadSkills({ refresh: origin === 'update', background: true }))
    if (task.status === 'done') {
      setToast({ key: Date.now(), text: task.message ?? '任务已完成', success: true })
    } else if (task.status === 'failed') {
      setToast({
        key: Date.now(),
        text: `任务失败：${task.error ?? task.message ?? '请在任务面板查看详情'}`,
        success: false,
      })
    }
  }, [loadPlugins, loadSkills])

  useEffect(() => {
    if (activeTask === null) return
    const current = activeTask.task
    if (current !== null && (current.status === 'done' || current.status === 'failed' || current.status === 'cancelled')) return
    const controller = new AbortController()
    let cancelled = false
    void transport.waitForTask(activeTask.id, {
      signal: controller.signal,
      onTask: (task) => {
        if (cancelled) return
        setActiveTask(previous => previous !== null && previous.id === task.id ? { ...previous, task } : previous)
      },
    }).then((task) => {
      if (cancelled) return
      setActiveTask(previous => previous !== null && previous.id === task.id ? { ...previous, task } : previous)
      finishTask(task, activeTask.scope, activeTask.origin)
    }).catch((caught: unknown) => {
      if (cancelled || isAbortError(caught)) return
      const message = apiErrorText(caught)
      // A task snapshot can disappear when the Host plugin graph reloads (e.g.
      // a Host-side plugin update restarted the manager). Settle the panel as a
      // failure so the page is no longer "busy", and rescan so the list shows
      // the real post-recovery state instead of stale running markers.
      setActiveTask(previous => {
        if (previous === null || previous.id !== activeTask.id) return previous
        const failedTask: TaskState | null = previous.task === null
          ? null
          : {
            ...previous.task,
            status: 'failed',
            finishedAt: new Date().toISOString(),
            error: message,
            message: '无法获取任务状态：Host 可能已重载或任务已过期',
          }
        return { ...previous, task: failedTask, pollError: message }
      })
      void (activeTask.scope === 'plugins'
        ? loadPlugins({ refresh: true, background: true })
        : loadSkills({ refresh: true, background: true }))
    })
    return () => {
      cancelled = true
      controller.abort()
    }
    // Polling is keyed by task id only: status updates flow through setState.
  }, [activeTask?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Adopt a task that a previous page load started (Host reports it as running).
  useEffect(() => {
    if (activeTask !== null) return
    const payload = scope === 'plugins' ? readyData(plugins) : readyData(skills)
    const check = payload?.check
    if (check?.running !== true || check.taskId === undefined) return
    let cancelled = false
    void transport.task(check.taskId).then((response) => {
      if (cancelled || response.task === undefined) return
      if (response.pending === true) {
        setActiveTask({
          id: response.task.id,
          task: response.task,
          scope,
          origin: response.task.kind === 'check' ? 'check' : 'update',
        })
      }
    }).catch(() => { /* stale task id: the Host forgot it, nothing to adopt */ })
    return () => { cancelled = true }
  }, [activeTask, scope, plugins, skills, transport])

  const beginTask = useCallback((task: TaskState, taskScope: ViewScope, origin: 'check' | 'update'): void => {
    setActiveTask({ id: task.id, task, scope: taskScope, origin })
  }, [])

  const runCheck = useCallback(async (ids?: string[]): Promise<void> => {
    setActionError(null)
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
    void (scope === 'plugins' ? loadPlugins() : loadSkills())
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
  const unmanagedRoots = useMemo(() => unmanagedRootKeys(skillsData), [skillsData])
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
  const title = scanMetadata(scope, pluginsData, skillsData)
  const busy = taskIsRunning(activeTask?.task ?? null) || updateBusy || checkingAction
  const checkingIds = useMemo<ReadonlySet<string>>(() => {
    const ids = new Set<string>()
    if (activeTask?.origin !== 'check' || activeTask.task === null) return ids
    for (const item of activeTask.task.items) {
      if (item.status === 'running' || item.status === 'pending') ids.add(item.id)
    }
    return ids
  }, [activeTask])
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
  const multipleFilters = activeFilters.query.trim() !== '' || activeFilters.source !== 'all'
    || activeFilters.status !== 'all' || activeFilters.range !== 'all'

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
   * Render
   * ---------------------------------------------------------------- */
  const incomplete = reconciliation !== undefined && !reconciliation.complete
  const incompleteSources = reconciliation?.sources.filter(source => !source.complete) ?? []
  const staleError = plugins.phase === 'ready' && scope === 'plugins'
    ? plugins.staleError
    : skills.phase === 'ready' && scope === 'skills' ? skills.staleError : undefined
  const loading = activePayload === undefined && (scope === 'plugins' ? plugins.phase === 'loading' || plugins.phase === 'idle' : skills.phase === 'loading' || skills.phase === 'idle')
  const error = scope === 'plugins' ? (plugins.phase === 'error' ? plugins.error : undefined) : (skills.phase === 'error' ? skills.error : undefined)
  const taskInFlight = taskIsRunning(activeTask?.task ?? null)

  return (
    <section className="em-root" aria-label="扩展管理器">
      <HeaderBar
        scope={scope}
        onScopeChange={setScope}
        preview={preview}
        scanMeta={title.meta}
        scanTitle={title.title}
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
        ready={!loading && error === undefined}
        taskRunning={taskInFlight || updateBusy}
        refreshing={scope === 'plugins' ? pluginsRefreshing : skillsRefreshing}
        checking={checkingAction}
        onRefresh={refreshActive}
        onCheckAll={() => { void runCheck() }}
        onUpdateAll={() => { void requestPlan('batch') }}
        onOpenDiagnostics={() => { setDiagnosticsOpen(true) }}
      />

      {activeTask === null ? null : activeTask.task === null ? (
        <div className="em-task">
          <RunningLine text="正在启动任务…" />
        </div>
      ) : (
        <TaskPanel
          task={activeTask.task}
          onRetryFailed={retryFailed}
          onDismiss={() => { setActiveTask(null) }}
        />
      )}
      {activeTask !== null && activeTask.pollError !== undefined ? (
        <InlineNotice
          tone="danger"
          title="任务状态获取失败"
          actions={(
            <>
              <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={refreshActive}>
                刷新清单
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setActiveTask(null) }}>关闭</Button>
            </>
          )}
        >
          {activeTask.pollError}。Host 可能已重载，任务状态已丢失；刷新清单可查看实际安装状态，中断的更新会由 Host 在下次启动时恢复或回滚。
        </InlineNotice>
      ) : null}

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
              forceOpen={multipleFilters}
              totalRecords={activeRecords.length}
              unmanagedRoots={unmanagedRoots}
              checkingIds={checkingIds}
              busy={busy}
              onToggleGroup={toggleGroup}
              onOpenDetails={setSelected}
              onCheck={(record) => { void runCheck([record.id]) }}
              onUpdate={(record) => { setSelected(null); void requestPlan('single', [record.id]) }}
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
