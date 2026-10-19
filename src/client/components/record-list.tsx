/**
 * Source-grouped record list. Every group is collapsible; a search or filter
 * forces groups open so matches are never hidden behind a collapsed header.
 *
 * Small result sets use plain document flow. At 100+ visible rows the same
 * groups are flattened into fixed-height list items and only the rows inside
 * (or just outside) the scroll viewport are mounted; the full data set remains
 * in memory for counts, filters and bulk updates.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCordisPluginOutlineRegular,
  IconDownloadOutlineRegular,
  IconPluginPinwheelOutlineRegular,
  IconRefreshOutlineRegular,
  IconSearchOutlineRegular,
  IconSkillOutlineRegular,
  IconSparkleRegular,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  checkBlockedReason,
  deriveSignals,
  formatRelative,
  isPluginRow,
  isSkillCopy,
  middleEllipsis,
  recordCheckedAt,
  recordDescription,
  recordName,
  recordPathText,
  recordSourceLabel,
  recordVersionText,
  shortPath,
  statusViewOf,
  updateBlockedReason,
  type ExtensionRecord,
  type RecordFilters,
  type RecordGroup,
  type ViewScope,
} from '../model'
import { CopyButton, cx, EmptyState, IconAction, StatusTag } from '../ui'

/** Virtualize only when this many rows are visible. */
export const VIRTUAL_ROW_THRESHOLD = 100
const GROUP_ITEM_HEIGHT = 32
const ROW_ITEM_HEIGHT = 84
const OVERSCAN_PX = 240

/** Props of {@link RecordList}. */
export interface RecordListProps {
  scope: ViewScope
  groups: readonly RecordGroup[]
  filters: RecordFilters
  collapsed: ReadonlySet<string>
  forceOpen: boolean
  totalRecords: number
  unmanagedRoots: ReadonlySet<string>
  checkingIds: ReadonlySet<string>
  busy: boolean
  /** Physical skill copies sharing one name, keyed by name (Skills only). */
  collisions: ReadonlyMap<string, number>
  onToggleGroup: (key: string) => void
  onOpenDetails: (record: ExtensionRecord) => void
  onCheck: (record: ExtensionRecord) => void
  onUpdate: (record: ExtensionRecord) => void
  onClearFilters: () => void
  onRefresh: () => void
}

/** Icon used for one record in the list. */
function RecordIcon({ record }: { record: ExtensionRecord }): ReactNode {
  if (isSkillCopy(record)) {
    return <IconSkillOutlineRegular size={16} />
  }
  if (record.kind === 'skill') return <IconSparkleRegular size={16} />
  if (isPluginRow(record)) return <IconPluginPinwheelOutlineRegular size={16} />
  return <IconCordisPluginOutlineRegular size={16} />
}

/** Runtime availability sentence shown at the end of the metadata line. */
function runtimeNote(record: ExtensionRecord, unmanagedRoots: ReadonlySet<string>): string | undefined {
  if (isSkillCopy(record)) {
    if (record.runtime.catalogIncomplete === true) return '当前作用域未验证'
    if (unmanagedRoots.has(record.rootKey)) return '未托管根目录'
    if (record.effective === false) return record.shadowedBy === undefined ? '未生效' : '被同名副本覆盖'
    return record.runtime.loaded === true ? '运行时生效' : '当前作用域未验证'
  }
  if (record.kind === 'skill') {
    return record.runtime.catalogIncomplete === true ? '当前作用域未验证' : '运行时提供'
  }
  if (record.runtime.fiberPhase === 'active') return '运行中'
  if (record.runtime.fiberPhase === 'failed') return '加载失败'
  if (record.runtime.loaded === true) return '已加载'
  if (record.runtime.enabled === false) return '未启用'
  return undefined
}

/** Description line with a tooltip only when the text can actually truncate. */
function DescriptionLine({ text }: { text: string }): ReactNode {
  const line = <p className="em-rowDesc" title={text.length > 32 ? text : undefined}>{text}</p>
  if (text.length <= 32) return line
  return <Tooltip label={text} side="bottom" delayMs={450} maxWidth={420}>{line}</Tooltip>
}

/** One list row. */
function RecordRow({
  record, checking, busy, unmanagedRoots, collisionCount, onOpenDetails, onCheck, onUpdate,
}: {
  record: ExtensionRecord
  checking: boolean
  busy: boolean
  unmanagedRoots: ReadonlySet<string>
  collisionCount: number
  onOpenDetails: (record: ExtensionRecord) => void
  onCheck: (record: ExtensionRecord) => void
  onUpdate: (record: ExtensionRecord) => void
}): ReactNode {
  const signals = deriveSignals(record, unmanagedRoots)
  const status = statusViewOf(record, checking)
  const name = recordName(record)
  const version = recordVersionText(record)
  const description = recordDescription(record)
  const path = recordPathText(record)
  const source = recordSourceLabel(record)
  const checked = formatRelative(recordCheckedAt(record))
  const note = runtimeNote(record, unmanagedRoots)
  const showUpdate = record.version.status === 'update-available' || record.version.status === 'incompatible-update'
  const canCheck = record.actions.canCheck && !busy
  const checkReason = checkBlockedReason(record)
  const updateReason = updateBlockedReason(record)
  const checkLabel = checking ? '正在检查更新' : '检查更新'

  return (
    <li className="em-row" data-kind={record.kind} data-status={record.version.status}>
      <span className="em-rowIcon" aria-hidden="true"><RecordIcon record={record} /></span>
      <div className="em-rowBody">
        <div className="em-rowTop">
          <button type="button" className="em-rowName" title={`查看详情：${name}`} onClick={() => { onOpenDetails(record) }}>
            {name}
          </button>
          {collisionCount > 1 ? (
            <span className="em-quietTag" title={`同名受管物理副本共 ${String(collisionCount)} 份；详情中可查看生效与被覆盖关系`}>
              <Tag tone="neutral">同名副本 {collisionCount}</Tag>
            </span>
          ) : null}
          {version === undefined ? null : <span className="em-rowVersion em-mono">{version}</span>}
          <StatusTag view={status} title={record.version.reason} />
          {record.kind !== 'skill' && record.runtime.enabled === false
            ? <Tag tone="neutral" className="em-quietTag">未启用</Tag>
            : null}
          <span className="em-rowActions">
            {showUpdate
              ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="em-updateBtn"
                  data-available={signals.updatable ? 'true' : undefined}
                  icon={<IconDownloadOutlineRegular size={13} />}
                  disabled={!signals.updatable || busy}
                  title={updateReason ?? '安装可用更新'}
                  onClick={() => { onUpdate(record) }}
                >
                  更新
                </Button>
              )
              : null}
            <IconAction
              label={checkLabel}
              disabled={!canCheck}
              disabledReason={checkReason}
              busy={checking}
              onClick={() => { onCheck(record) }}
            >
              <IconRefreshOutlineRegular size={13} />
            </IconAction>
            <IconAction label="查看详情" onClick={() => { onOpenDetails(record) }}>
              <IconChevronRightOutlineRegular size={13} />
            </IconAction>
          </span>
        </div>
        {description === '' ? null : <DescriptionLine text={description} />}
        <div className="em-rowMeta">
          <span className="em-metaSource" title={record.source.packageName ?? record.name}>{source}</span>
          <span className="em-metaSep" aria-hidden="true">·</span>
          <span className="em-metaPath">
            {path === ''
              ? <span className="em-metaMuted">路径未知</span>
              : (
                <Tooltip label={path} side="bottom" delayMs={400} maxWidth={520}>
                  <span className="em-mono em-metaPathText" title={path}>{shortPath(path)}</span>
                </Tooltip>
              )}
            {path === '' ? null : <CopyButton text={path} label="复制路径" />}
          </span>
          <span className="em-metaTail">
            {note === undefined ? null : <span className="em-metaNote">{note}</span>}
            {checked === undefined ? null : (
              <span className="em-metaChecked" title={recordCheckedAt(record)}>
                {note === undefined ? '' : '· '}
                检查于 {checked}
              </span>
            )}
          </span>
        </div>
      </div>
    </li>
  )
}

interface VirtualItem {
  key: string
  type: 'group' | 'row'
  top: number
  group?: RecordGroup
  record?: ExtensionRecord
  open?: boolean
}

/** Flatten collapsible groups into fixed-height items for windowed rendering. */
function buildVirtualItems(
  groups: readonly RecordGroup[],
  collapsed: ReadonlySet<string>,
  forceOpen: boolean,
): VirtualItem[] {
  const items: VirtualItem[] = []
  let top = 0
  for (const group of groups) {
    const open = forceOpen || !collapsed.has(group.key)
    items.push({ key: `group:${group.key}`, type: 'group', top, group, open })
    top += GROUP_ITEM_HEIGHT
    if (!open) continue
    for (const record of group.records) {
      items.push({ key: `row:${record.id}`, type: 'row', top, record })
      top += ROW_ITEM_HEIGHT
    }
  }
  return items
}

/** Windowed group/row renderer used only for large result sets. */
function VirtualRecordList({
  scope, groups, collapsed, forceOpen, checkingIds, busy, unmanagedRoots, collisions,
  onToggleGroup, onOpenDetails, onCheck, onUpdate,
}: {
  scope: ViewScope
  groups: readonly RecordGroup[]
  collapsed: ReadonlySet<string>
  forceOpen: boolean
  checkingIds: ReadonlySet<string>
  busy: boolean
  unmanagedRoots: ReadonlySet<string>
  collisions: ReadonlyMap<string, number>
  onToggleGroup: (key: string) => void
  onOpenDetails: (record: ExtensionRecord) => void
  onCheck: (record: ExtensionRecord) => void
  onUpdate: (record: ExtensionRecord) => void
}): ReactNode {
  const items = useMemo(() => buildVirtualItems(groups, collapsed, forceOpen), [groups, collapsed, forceOpen])
  const totalHeight = items.reduce((max, item) => Math.max(max, item.top + (item.type === 'group' ? GROUP_ITEM_HEIGHT : ROW_ITEM_HEIGHT)), 0)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(560)
  const signature = useMemo(() => groups.map(group => `${group.key}:${String(group.records.length)}:${String(collapsed.has(group.key))}`).join('|') + String(forceOpen), [groups, collapsed, forceOpen])

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    const measure = (): void => { setViewportHeight(node.clientHeight) }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)
    return () => { observer?.disconnect() }
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (node !== null) node.scrollTop = 0
    setScrollTop(0)
  }, [signature])

  const visible = useMemo(() => {
    const startAt = Math.max(0, scrollTop - OVERSCAN_PX)
    const endAt = scrollTop + viewportHeight + OVERSCAN_PX
    return items.filter(item => item.top + (item.type === 'group' ? GROUP_ITEM_HEIGHT : ROW_ITEM_HEIGHT) >= startAt && item.top <= endAt)
  }, [items, scrollTop, viewportHeight])

  const onFocusCapture = (event: FocusEvent<HTMLDivElement>): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-vrow]')
    if (row === null) return
    const index = Number(row.dataset.vrow)
    const item = items[index]
    const node = scrollRef.current
    if (item === undefined || node === null) return
    if (item.top < node.scrollTop) node.scrollTop = item.top
    else if (item.top + ROW_ITEM_HEIGHT > node.scrollTop + node.clientHeight) node.scrollTop = item.top + ROW_ITEM_HEIGHT - node.clientHeight
  }

  return (
    <div
      className="em-virtualList"
      ref={scrollRef}
      onScroll={(event) => { setScrollTop(event.currentTarget.scrollTop) }}
      onFocusCapture={onFocusCapture}
      role="region"
      aria-label="扩展列表（已启用按需渲染）"
    >
      <div className="em-virtualInner" style={{ height: totalHeight }}>
        {visible.map((item) => {
          if (item.type === 'group' && item.group !== undefined) {
            const group = item.group
            const open = item.open === true
            const panelId = `em-group-${scope}-${encodeURIComponent(group.key)}`
            return (
              <div className="em-vitem em-vitemGroup" key={item.key} style={{ top: item.top }}>
                <div className="em-groupHead">
                  <button
                    type="button"
                    className="em-groupToggle"
                    aria-expanded={open}
                    aria-controls={panelId}
                    onClick={() => { onToggleGroup(group.key) }}
                  >
                    <IconChevronDownOutlineRegular size={12} className={cx('em-chevron', open && 'is-open')} aria-hidden="true" />
                    <span className="em-groupTitle">{group.label}</span>
                    <span className="em-groupCount">{String(group.records.length)}</span>
                  </button>
                  {group.updatable === 0 ? null : (
                    <span className="em-groupMeta">{String(group.updatable)} 项可更新</span>
                  )}
                </div>
              </div>
            )
          }
          if (item.record === undefined) return null
          const record = item.record
          const rowIndex = items.indexOf(item)
          const name = recordName(record)
          return (
            <div
              className="em-vitem em-vitemRow"
              key={item.key}
              style={{ top: item.top }}
              data-vrow={String(rowIndex)}
              aria-setsize={items.filter(entry => entry.type === 'row').length}
              aria-posinset={items.filter((entry, index) => entry.type === 'row' && index <= rowIndex).length}
            >
              <RecordRow
                record={record}
                checking={checkingIds.has(record.id)}
                busy={busy}
                unmanagedRoots={unmanagedRoots}
                collisionCount={isSkillCopy(record) ? (collisions.get(name) ?? 0) : 0}
                onOpenDetails={onOpenDetails}
                onCheck={onCheck}
                onUpdate={onUpdate}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Render all groups (or one of the empty states). */
export function RecordList({
  scope, groups, filters, collapsed, forceOpen, totalRecords, unmanagedRoots,
  checkingIds, busy, collisions, onToggleGroup, onOpenDetails, onCheck, onUpdate, onClearFilters, onRefresh,
}: RecordListProps): ReactNode {
  const visibleRows = groups.reduce((sum, group) => sum + (forceOpen || !collapsed.has(group.key) ? group.records.length : 0), 0)
  if (totalRecords === 0) {
    return (
      <EmptyState
        icon={scope === 'plugins' ? <IconCordisPluginOutlineRegular size={22} /> : <IconSkillOutlineRegular size={22} />}
        title={scope === 'plugins' ? '还没有发现任何 Plugins' : '还没有发现任何 Skills'}
        description={scope === 'plugins'
          ? '当前 Profile 里没有安装插件包。安装后点击刷新即可在这里管理。'
          : '扫描完成的技能目录中还没有技能。创建 SKILL.md 或调整工作区后点击刷新。'}
        action={<Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={onRefresh}>刷新清单</Button>}
      />
    )
  }
  if (groups.length === 0) {
    return (
      <EmptyState
        icon={<IconSearchOutlineRegular size={22} />}
        title="没有匹配的项"
        description="当前的搜索词或筛选条件没有匹配到任何扩展。"
        action={<Button variant="outline" size="sm" onClick={onClearFilters}>清除搜索与筛选</Button>}
      />
    )
  }
  return (
    <div className="em-groups">
      {visibleRows >= VIRTUAL_ROW_THRESHOLD
        ? (
          <VirtualRecordList
            scope={scope}
            groups={groups}
            collapsed={collapsed}
            forceOpen={forceOpen}
            checkingIds={checkingIds}
            busy={busy}
            unmanagedRoots={unmanagedRoots}
            collisions={collisions}
            onToggleGroup={onToggleGroup}
            onOpenDetails={onOpenDetails}
            onCheck={onCheck}
            onUpdate={onUpdate}
          />
        )
        : groups.map((group) => {
          const open = forceOpen || !collapsed.has(group.key)
          const panelId = `em-group-${scope}-${encodeURIComponent(group.key)}`
          return (
            <section className="em-group" key={group.key}>
              <div className="em-groupHead">
                <button
                  type="button"
                  className="em-groupToggle"
                  aria-expanded={open}
                  aria-controls={panelId}
                  onClick={() => { onToggleGroup(group.key) }}
                >
                  <IconChevronDownOutlineRegular size={12} className={cx('em-chevron', open && 'is-open')} aria-hidden="true" />
                  <span className="em-groupTitle">{group.label}</span>
                  <span className="em-groupCount">{String(group.records.length)}</span>
                </button>
                {group.updatable === 0 ? null : (
                  <span className="em-groupMeta">{String(group.updatable)} 项可更新</span>
                )}
              </div>
              {open
                ? (
                  <ul className="em-rows" id={panelId}>
                    {group.records.map(record => {
                      const name = recordName(record)
                      return (
                        <RecordRow
                          key={record.id}
                          record={record}
                          checking={checkingIds.has(record.id)}
                          busy={busy}
                          unmanagedRoots={unmanagedRoots}
                          collisionCount={isSkillCopy(record) ? (collisions.get(name) ?? 0) : 0}
                          onOpenDetails={onOpenDetails}
                          onCheck={onCheck}
                          onUpdate={onUpdate}
                        />
                      )
                    })}
                  </ul>
                )
                : null}
            </section>
          )
        })}
      <p className="em-listFooter">
        {filters.query.trim() === '' && filters.status === 'all' && filters.source === 'all' && filters.range === 'all'
          ? `共 ${String(totalRecords)} 条记录`
          : `当前匹配 ${String(groups.reduce((sum, group) => sum + group.records.length, 0))} 项 · 共 ${String(totalRecords)} 条记录`}
        {visibleRows >= VIRTUAL_ROW_THRESHOLD ? ' · 已启用按需渲染' : ''}
      </p>
    </div>
  )
}

/** Re-exported so the details dialog can reuse the same shortening rule. */
export const shortenPath = (path: string): string => middleEllipsis(path, 64)
