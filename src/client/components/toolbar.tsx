/**
 * Toolbar above the list: one compact action row plus an optional filter panel.
 *
 * The first row keeps only high-frequency actions (search, filters, refresh,
 * check all, update all). Source/status/range/workspace/sort and diagnostics
 * live in the collapsible panel. Every disabled control states why, and the
 * panel repeats the two bulk-action reasons.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconChecklistOutlineRegular,
  IconDownloadOutlineRegular,
  IconInspectOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconSlidersTwoOutlineRegular,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  formatUpdateAllLabel,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  type ExtensionRecord,
  type RangeOption,
  type RecordFilters,
  type ViewScope,
} from '../model'
import { MenuSelect, type MenuSelectOption } from '../ui'

/** Props of the toolbar. */
export interface ToolbarProps {
  scope: ViewScope
  filters: RecordFilters
  onFiltersChange: (next: RecordFilters) => void
  sourceOptions: ReadonlyArray<{ value: string; label: string }>
  rangeOptions: readonly RangeOption[]
  /**
   * Skills only: registered-workspace picker. Selecting one rescans the project
   * skill roots with `?workspace=<path>`; omitted when no workspace is
   * registered behind the default Host working directory.
   */
  workspaceSelector?: {
    value: string
    options: readonly MenuSelectOption[]
    onChange: (id: string) => void
  } | undefined
  records: readonly ExtensionRecord[]
  filtersOpen: boolean
  onToggleFilters: () => void
  matchedCount: number
  totalCount: number
  onClearFilters: () => void
  /** False while the first load is running or failed: bulk actions stay locked. */
  ready: boolean
  taskRunning: boolean
  refreshing: boolean
  checking: boolean
  /** True only for a completed, fully successful check of the current scope. */
  checkValid: boolean
  /** Number of items the existing batch plan can execute without confirmation. */
  batchCount: number
  /** Lightweight result/error text shown below the toolbar. */
  checkNotice?: string | undefined
  onRefresh: () => void
  onCheckAll: () => void
  onUpdateAll: () => void
  onOpenDiagnostics: () => void
}

/** Build one menu option list for the status select. */
function statusOptions(scope: ViewScope): MenuSelectOption[] {
  return STATUS_OPTIONS[scope].map(option => ({ id: option.value, label: option.label }))
}

/** Build the source menu options. */
function sourceOptionsOf(options: ReadonlyArray<{ value: string; label: string }>): MenuSelectOption[] {
  return [{ id: 'all', label: '全部来源' }, ...options.map(option => ({ id: option.value, label: option.label }))]
}

/** Build the range menu options. */
function rangeOptionsOf(options: readonly RangeOption[]): MenuSelectOption[] {
  return options.map(option => ({
    id: option.value,
    label: option.hint === undefined || option.label.includes(option.hint)
      ? option.label
      : `${option.label}（${option.hint}）`,
  }))
}

/** Render the toolbar. */
export function Toolbar({
  scope, filters, onFiltersChange, sourceOptions, rangeOptions, workspaceSelector, records,
  filtersOpen, onToggleFilters, matchedCount, totalCount, onClearFilters,
  ready, taskRunning, refreshing, checking, checkValid, batchCount, checkNotice,
  onRefresh, onCheckAll, onUpdateAll, onOpenDiagnostics,
}: ToolbarProps): ReactNode {
  const rowRef = useRef<HTMLDivElement | null>(null)
  const actionsRef = useRef<HTMLDivElement | null>(null)
  const [singleLine, setSingleLine] = useState(true)
  const checkable = records.filter(record => record.actions.canCheck).length
  const total = records.length
  const activeFilterCount = (filters.query.trim() === '' ? 0 : 1)
    + (filters.source === 'all' ? 0 : 1)
    + (filters.status === 'all' ? 0 : 1)
    + (filters.range === 'all' ? 0 : 1)

  const showUpdateAll = ready && !taskRunning && !refreshing && checkValid && batchCount > 0
  const checkAllReason = !ready
    ? '清单尚未加载完成'
    : taskRunning
      ? '有任务正在执行，完成后才能再次检查'
      : checking
        ? '正在检查更新…'
        : checkable === 0
          ? '清单中没有可用于检查的远程来源'
          : total === 0
            ? '清单为空，暂无可检查的项'
            : undefined
  const refreshReason = taskRunning || refreshing
    ? '任务执行中，完成后再刷新清单'
    : undefined

  const hint = !ready
    ? '检查更新：清单尚未加载完成'
    : taskRunning
      ? '有任务正在执行，完成后才能开始新的检查或更新'
      : checking
        ? '正在检查更新…'
        : checkNotice !== undefined
          ? checkNotice
          : checkValid && batchCount === 0
            ? '检查完成，暂无可批量更新的项目。'
            : checkAllReason !== undefined
              ? `检查更新：${checkAllReason}`
              : undefined

  const update = (patch: Partial<RecordFilters>): void => {
    onFiltersChange({ ...filters, ...patch })
  }

  // Measure the real content width rather than using a viewport breakpoint.
  // If the minimum search width plus the natural button widths fits, pin the
  // row to one line; otherwise let the right-hand action group wrap as a unit.
  useLayoutEffect(() => {
    const row = rowRef.current
    const actions = actionsRef.current
    if (row === null || actions === null) return
    const measure = (): void => {
      const search = row.querySelector<HTMLElement>('.em-search')
      const filter = row.querySelector<HTMLElement>('button.em-toolbarAction')
      if (search === null || filter === null) return
      const gap = Number.parseFloat(getComputedStyle(row).columnGap) || 0
      const searchMin = Number.parseFloat(getComputedStyle(search).minWidth) || 150
      const required = searchMin + filter.getBoundingClientRect().width + actions.scrollWidth + gap * 2
      setSingleLine(required <= row.clientWidth + 0.5)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    observer.observe(actions)
    return () => { observer.disconnect() }
  }, [showUpdateAll, batchCount, ready, taskRunning, refreshing, checkValid])

  return (
    <div className="em-toolbar">
      <div className={singleLine ? "em-toolRow em-toolRowSingle" : "em-toolRow"} ref={rowRef}>
        <Input
          type="search"
          className="em-search"
          icon={<IconSearchOutlineRegular size={15} />}
          aria-label="搜索扩展"
          placeholder="搜索名称、来源或路径"
          value={filters.query}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => { update({ query: event.currentTarget.value }) }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="em-toolbarAction"
          icon={<IconSlidersTwoOutlineRegular size={14} />}
          aria-expanded={filtersOpen}
          title={activeFilterCount === 0 ? '展开来源、状态、范围与排序筛选' : `已启用 ${String(activeFilterCount)} 个筛选条件`}
          onClick={onToggleFilters}
        >
          筛选
        </Button>
        <div className="em-toolActions" ref={actionsRef}>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="em-toolbarAction"
            icon={<IconRefreshOutlineRegular size={14} />}
            disabled={refreshReason !== undefined}
            title={refreshReason ?? '重新读取当前类别的本地安装清单'}
            onClick={onRefresh}
          >
            刷新列表
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="em-toolbarAction"
            icon={<IconChecklistOutlineRegular size={14} />}
            disabled={checkAllReason !== undefined}
            title={checkAllReason ?? '检查当前类别的远程版本'}
            onClick={onCheckAll}
          >
            检查更新
          </Button>
          {showUpdateAll ? (
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="em-toolbarAction"
              icon={<IconDownloadOutlineRegular size={14} />}
              title="打开批量更新计划，仅自动执行可安全批量更新的项目"
              onClick={onUpdateAll}
            >
              {formatUpdateAllLabel(batchCount)}
            </Button>
          ) : null}
        </div>
      </div>
      {filtersOpen ? (
        <div className="em-filterPanel">
          <div className="em-filterPanelRow">
            <MenuSelect
              label="来源"
              value={filters.source}
              options={sourceOptionsOf(sourceOptions)}
              onChange={(id) => { update({ source: id }) }}
            />
            <MenuSelect
              label="状态"
              value={filters.status}
              options={statusOptions(scope)}
              onChange={(id) => { update({ status: id as RecordFilters['status'] }) }}
            />
            {scope === 'skills' && workspaceSelector !== undefined
              ? (
                <MenuSelect
                  label="工作区"
                  value={workspaceSelector.value}
                  options={workspaceSelector.options}
                  onChange={workspaceSelector.onChange}
                />
              )
              : (
                <MenuSelect
                  label="范围"
                  value={filters.range}
                  options={rangeOptionsOf(rangeOptions)}
                  onChange={(id) => { update({ range: id }) }}
                />
              )}
            <MenuSelect
              label="排序"
              value={filters.sort}
              options={SORT_OPTIONS.map(option => ({ id: option.value, label: option.label }))}
              onChange={(id) => { update({ sort: id as RecordFilters['sort'] }) }}
            />
            <span className="em-toolSpacer" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              icon={<IconInspectOutlineRegular size={14} />}
              title="打开诊断信息：环境、探测结果与清单完整性"
              onClick={onOpenDiagnostics}
            >
              诊断
            </Button>
          </div>
          <div className="em-filterPanelFoot">
            <span className="em-filterMatch">
              {matchedCount === totalCount
                ? `共 ${String(totalCount)} 条记录`
                : `当前匹配 ${String(matchedCount)} 项 · 共 ${String(totalCount)} 条记录`}
            </span>
            <span className="em-toolSpacer" />
            <button
              type="button"
              className="em-linkButton"
              disabled={activeFilterCount === 0 && filters.sort === 'name'}
              onClick={onClearFilters}
            >
              清除筛选
            </button>
          </div>
        </div>
      ) : null}
      {hint === undefined ? null : <p className="em-toolHint" role="status">{hint}</p>}
    </div>
  )
}
