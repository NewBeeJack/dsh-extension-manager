/**
 * Toolbar above the list: one compact action row plus an optional filter panel.
 *
 * The first row keeps only high-frequency actions (search, filters, refresh,
 * check all, update all). Source/status/range/workspace/sort and diagnostics
 * live in the collapsible panel. Every disabled control states why, and the
 * panel repeats the two bulk-action reasons.
 */
import type { ReactNode } from 'react'
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
  isSafeUpdate,
  SORT_OPTIONS,
  STATUS_OPTIONS,
  type ExtensionRecord,
  type RangeOption,
  type RecordFilters,
  type ViewScope,
} from '../model'
import { cx, IconAction, MenuSelect, type MenuSelectOption } from '../ui'

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
  ready, taskRunning, refreshing, checking, onRefresh, onCheckAll, onUpdateAll, onOpenDiagnostics,
}: ToolbarProps): ReactNode {
  const checkable = records.filter(record => record.actions.canCheck).length
  const safeUpdates = records.filter(record => isSafeUpdate(record)).length
  const checked = records.filter(record => record.version.status !== 'unchecked').length
  const total = records.length
  const activeFilterCount = (filters.query.trim() === '' ? 0 : 1)
    + (filters.source === 'all' ? 0 : 1)
    + (filters.status === 'all' ? 0 : 1)
    + (filters.range === 'all' ? 0 : 1)

  const updateAllReason = !ready
    ? '清单尚未加载完成'
    : taskRunning
      ? '有任务正在执行，完成后才能开始新的更新'
      : safeUpdates === 0
        ? checked === 0
          ? '还没有检查过更新；请先点击「检查全部更新」'
          : '没有可安全自动更新的项；需要确认或覆盖本地修改的项目请逐项更新'
        : undefined
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

  const hint = !ready || taskRunning || (checking && updateAllReason === undefined)
    ? undefined
    : updateAllReason !== undefined
      ? `更新全部：${updateAllReason}`
      : checkAllReason !== undefined
        ? `检查全部更新：${checkAllReason}`
        : undefined

  const update = (patch: Partial<RecordFilters>): void => {
    onFiltersChange({ ...filters, ...patch })
  }

  return (
    <div className="em-toolbar">
      <div className="em-toolRow">
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
          icon={<IconSlidersTwoOutlineRegular size={14} />}
          aria-expanded={filtersOpen}
          title="展开来源、状态、范围与排序筛选"
          onClick={onToggleFilters}
        >
          {activeFilterCount === 0 ? '筛选' : `筛选（${String(activeFilterCount)}）`}
        </Button>
        <IconAction
          label="刷新清单"
          disabled={refreshReason !== undefined}
          disabledReason={refreshReason}
          busy={refreshing}
          onClick={onRefresh}
        >
          <IconRefreshOutlineRegular size={14} />
        </IconAction>
        <Button
          type="button"
          variant="outline"
          size="sm"
          icon={<IconChecklistOutlineRegular size={14} />}
          disabled={checkAllReason !== undefined}
          title={checkAllReason ?? '检查所有可检查项的远程版本'}
          onClick={onCheckAll}
        >
          检查全部更新
        </Button>
        <Button
          type="button"
          variant="primary"
          size="sm"
          icon={<IconDownloadOutlineRegular size={14} />}
          disabled={updateAllReason !== undefined}
          title={updateAllReason ?? '仅更新可安全自动完成的项目，需要确认的项目会跳过'}
          onClick={onUpdateAll}
        >
          {safeUpdates > 0 ? `更新全部（${String(safeUpdates)}）` : '更新全部'}
        </Button>
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
