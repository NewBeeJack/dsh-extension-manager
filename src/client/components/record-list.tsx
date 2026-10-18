/**
 * Source-grouped record list. Every group is collapsible; a search or filter
 * forces groups open so matches are never hidden behind a collapsed header.
 */
import type { ReactNode } from 'react'
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
    if (unmanagedRoots.has(record.rootKey)) return '未托管根目录'
    if (record.effective === false) return record.shadowedBy === undefined ? '未生效' : '被同名副本覆盖'
    return '运行时生效'
  }
  if (record.kind === 'skill') return '运行时提供'
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
  record, checking, busy, unmanagedRoots, onOpenDetails, onCheck, onUpdate,
}: {
  record: ExtensionRecord
  checking: boolean
  busy: boolean
  unmanagedRoots: ReadonlySet<string>
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

/** Render all groups (or one of the empty states). */
export function RecordList({
  scope, groups, filters, collapsed, forceOpen, totalRecords, unmanagedRoots,
  checkingIds, busy, onToggleGroup, onOpenDetails, onCheck, onUpdate, onClearFilters, onRefresh,
}: RecordListProps): ReactNode {
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
      {groups.map((group) => {
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
                  {group.records.map(record => (
                    <RecordRow
                      key={record.id}
                      record={record}
                      checking={checkingIds.has(record.id)}
                      busy={busy}
                      unmanagedRoots={unmanagedRoots}
                      onOpenDetails={onOpenDetails}
                      onCheck={onCheck}
                      onUpdate={onUpdate}
                    />
                  ))}
                </ul>
              )
              : null}
          </section>
        )
      })}
      <p className="em-listFooter">
        {`共 ${String(totalRecords)} 条记录`}
        {filters.query.trim() === '' && filters.status === 'all' && filters.source === 'all' && filters.range === 'all'
          ? ''
          : `，筛选后 ${String(groups.reduce((sum, group) => sum + group.records.length, 0))} 条`}
      </p>
    </div>
  )
}

/** Re-exported so the details dialog can reuse the same shortening rule. */
export const shortenPath = (path: string): string => middleEllipsis(path, 64)
