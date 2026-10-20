/**
 * Task panel: live progress of a check/update task plus its final result and
 * a retry path for failed items. Rendered above the list while present.
 */
import { useState, type ReactNode } from 'react'
import {
  Button,
  IconCheckCircleOutlineRegular,
  IconCloseOutlineRegular,
  IconRefreshOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Tag,
  TextShimmer,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskState } from '../../shared/types'
import { ProgressBar, cx } from '../ui'

/** Props of {@link TaskPanel}. */
export interface TaskPanelProps {
  task: TaskState
  /** Controlled detail visibility; omitted keeps the component-local state. */
  showItems?: boolean
  onToggleItems?: () => void
  /** Ask the Host to update the failed items again. */
  onRetryFailed: (ids: string[]) => void
  onDismiss: () => void
}

const TASK_KIND_LABELS: Record<TaskState['kind'], string> = {
  check: '检查更新',
  update: '更新扩展',
  'batch-update': '批量更新',
  refresh: '刷新清单',
  'source-associate': '关联来源',
  'self-update': '更新扩展管理器',
}

const ITEM_STATUS_LABELS: Record<TaskState['items'][number]['status'], string> = {
  pending: '等待',
  running: '进行中',
  ok: '完成',
  failed: '失败',
  skipped: '跳过',
}

const ITEM_STATUS_TONES: Record<TaskState['items'][number]['status'], TagTone> = {
  pending: 'neutral',
  running: 'info',
  ok: 'success',
  failed: 'danger',
  skipped: 'outline',
}

/** Render the task panel. */
export function TaskPanel({ task, showItems, onToggleItems, onRetryFailed, onDismiss }: TaskPanelProps): ReactNode {
  const [localShowItems, setLocalShowItems] = useState(false)
  const itemsOpen = showItems ?? localShowItems
  const toggleItems = onToggleItems ?? (() => { setLocalShowItems(value => !value) })
  const running = task.status === 'queued' || task.status === 'running'
  const failedItems = task.items.filter(item => item.status === 'failed')
  const skippedItems = task.skipped ?? []
  const partialFailure = task.status === 'done'
    && (failedItems.length > 0 || task.message?.includes('网络失败') === true)
  const tone: TagTone = task.status === 'failed' ? 'danger' : partialFailure ? 'warning' : task.status === 'done' ? 'success' : task.status === 'cancelled' ? 'neutral' : 'info'
  const headline = running
    ? `${TASK_KIND_LABELS[task.kind]}进行中`
    : task.status === 'done' && partialFailure
      ? `${TASK_KIND_LABELS[task.kind]}完成（部分失败）`
      : task.status === 'done'
        ? `${TASK_KIND_LABELS[task.kind]}完成`
      : task.status === 'failed'
        ? `${TASK_KIND_LABELS[task.kind]}失败`
        : `${TASK_KIND_LABELS[task.kind]}已取消`
  const runningItem = task.items.find(item => item.status === 'running')

  const summaryText = running
    ? undefined
    : task.status === 'failed'
      ? (task.error ?? task.message ?? '任务失败')
      : task.status === 'cancelled'
        ? (task.message ?? '任务已取消')
        : (task.message ?? '任务已完成')
  const showDetails = task.items.length > 0 || (!running && task.kind === 'check')
  const statusIcon = running
    ? null
    : task.status === 'failed' || partialFailure
      ? <IconWarningTriangleOutlineRegular size={15} />
      : task.status === 'done'
        ? <IconCheckCircleOutlineRegular size={15} />
        : <IconCloseOutlineRegular size={14} />

  return (
    <section className={cx('em-task', !running && 'em-taskSummary')} data-tone={tone} aria-busy={running}>
      <div className="em-taskHead">
        {statusIcon === null ? null : <span className="em-taskStatusIcon" data-tone={tone} aria-hidden="true">{statusIcon}</span>}
        <span className="em-taskHeadline">
          {running
            ? (
              <span className="em-runningLine" role="status">
                <TextShimmer active>{headline}</TextShimmer>
              </span>
            )
            : headline}
        </span>
        <Tag tone={tone === 'neutral' ? 'neutral' : tone} className="em-taskTag">
          {running ? `${String(task.completed)}/${String(task.total)}` : partialFailure ? '部分失败' : task.status === 'done' ? '成功' : task.status === 'failed' ? '失败' : '已取消'}
        </Tag>
        {summaryText === undefined ? null : <span className="em-taskSummaryText" title={summaryText}>{summaryText}</span>}
        <span className="em-taskSpacer" />
        {showDetails ? (
          <button
            type="button"
            className="em-taskDetailsToggle"
            aria-expanded={itemsOpen}
            onClick={toggleItems}
          >
            {itemsOpen ? '收起详情' : '查看详情'}
          </button>
        ) : null}
        <button type="button" className="em-iconBtn" aria-label="隐藏任务面板" title="隐藏" onClick={onDismiss}>
          <IconCloseOutlineRegular size={12} />
        </button>
      </div>
      {running ? (
        <>
          <ProgressBar completed={task.completed} total={task.total} />
          <p className="em-taskMessage">
            {task.message ??
              (runningItem === undefined
                ? `正在${TASK_KIND_LABELS[task.kind]}…（${String(task.completed)}/${String(task.total)}）`
                : `${runningItem.name}：${ITEM_STATUS_LABELS[runningItem.status]}${runningItem.message === undefined ? '' : ` · ${runningItem.message}`}`)}
          </p>
        </>
      ) : null}
      {task.status === 'failed' && failedItems.length > 0 ? (
        <div className="em-taskFailureActions">
          <Button
            variant="outline"
            size="sm"
            icon={<IconRefreshOutlineRegular size={13} />}
            onClick={() => { onRetryFailed(failedItems.map(item => item.id)) }}
          >
            重试失败项（{String(failedItems.length)}）
          </Button>
        </div>
      ) : null}
      {itemsOpen ? (
        <ul className="em-taskItems">
          {task.items.map(item => (
            <li key={item.id} className={cx('em-taskItem', item.status === 'running' && 'is-running')} data-status={item.status}>
              <span className="em-taskItemName">{item.name}</span>
              <Tag tone={ITEM_STATUS_TONES[item.status]}>{ITEM_STATUS_LABELS[item.status]}</Tag>
              {item.fromVersion === undefined && item.toVersion === undefined
                ? null
                : (
                  <span className="em-taskItemVersion em-mono">
                    {item.fromVersion ?? '?'}{item.toVersion === undefined ? '' : ` → ${item.toVersion}`}
                  </span>
                )}
              {item.message === undefined ? null : <span className="em-taskItemMessage">{item.message}</span>}
            </li>
          ))}
        </ul>
      ) : null}
      {itemsOpen && skippedItems.length > 0 ? (
        <div className="em-taskSkippedGroup">
          <p className="em-taskSkippedHeading">跳过（{String(skippedItems.length)}）</p>
          <ul className="em-taskItems">
            {skippedItems.map(item => (
              <li key={item.id} className="em-taskItem" data-status="skipped" data-skip-id={item.id} title={item.id}>
                <span className="em-taskItemName">{item.name}</span>
                <Tag tone="neutral">跳过</Tag>
                <span className="em-taskItemMessage">原因：{item.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {itemsOpen && task.items.length === 0 && skippedItems.length === 0 && task.kind === 'check' ? (
        <p className="em-taskMessage em-detailMuted">本次检查使用缓存结果，没有逐项明细。</p>
      ) : null}
      {itemsOpen && task.skipped === undefined && task.kind === 'check' && task.message?.includes('项跳过') === true ? (
        <p className="em-taskSkippedNote">该历史任务未保存跳过项目明细。</p>
      ) : null}
      {task.plan === undefined || !itemsOpen ? null : (
        <p className="em-taskMessage em-detailMuted">
          计划内 {String(task.plan.entries.length)} 项、排除 {String(task.plan.excluded.length)} 项
        </p>
      )}
    </section>
  )
}
