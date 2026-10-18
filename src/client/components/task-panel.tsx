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
  Tag,
  TextShimmer,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TaskState } from '../../shared/types'
import { ProgressBar, RunningLine, cx } from '../ui'

/** Props of {@link TaskPanel}. */
export interface TaskPanelProps {
  task: TaskState
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
export function TaskPanel({ task, onRetryFailed, onDismiss }: TaskPanelProps): ReactNode {
  const [showItems, setShowItems] = useState(false)
  const running = task.status === 'queued' || task.status === 'running'
  const failedItems = task.items.filter(item => item.status === 'failed')
  const tone = task.status === 'failed' ? 'danger' : task.status === 'done' ? 'success' : task.status === 'cancelled' ? 'neutral' : 'info'
  const headline = running
    ? `${TASK_KIND_LABELS[task.kind]}进行中`
    : task.status === 'done'
      ? `${TASK_KIND_LABELS[task.kind]}完成`
      : task.status === 'failed'
        ? `${TASK_KIND_LABELS[task.kind]}失败`
        : `${TASK_KIND_LABELS[task.kind]}已取消`
  const runningItem = task.items.find(item => item.status === 'running')

  return (
    <section className="em-task" data-tone={tone} aria-busy={running}>
      <div className="em-taskHead">
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
          {running ? `${String(task.completed)}/${String(task.total)}` : task.status === 'done' ? '成功' : task.status === 'failed' ? '失败' : '已取消'}
        </Tag>
        <span className="em-taskSpacer" />
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
      {task.status === 'done' ? (
        <p className="em-taskMessage">
          <IconCheckCircleOutlineRegular size={13} className="em-inlineIcon" />
          {task.message ?? '任务已完成'}
          {task.items.length === 0 ? '' : `（共 ${String(task.items.length)} 项）`}
        </p>
      ) : null}
      {task.status === 'failed' ? (
        <div className="em-taskFailure" role="alert">
          <p className="em-taskMessage">{task.error ?? task.message ?? '任务失败'}</p>
          {failedItems.length === 0 ? null : (
            <ul className="em-taskItems">
              {failedItems.map(item => (
                <li key={item.id} className="em-taskItem" data-status={item.status}>
                  <span className="em-taskItemName">{item.name}</span>
                  <Tag tone={ITEM_STATUS_TONES[item.status]}>{ITEM_STATUS_LABELS[item.status]}</Tag>
                  <span className="em-taskItemMessage">{item.message ?? '未提供失败原因'}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="em-taskActions">
            {failedItems.length === 0 ? null : (
              <Button
                variant="outline"
                size="sm"
                icon={<IconRefreshOutlineRegular size={13} />}
                onClick={() => { onRetryFailed(failedItems.map(item => item.id)) }}
              >
                重试失败项（{String(failedItems.length)}）
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={onDismiss}>关闭</Button>
          </div>
        </div>
      ) : null}
      {task.items.length > 0 ? (
        <div className="em-taskItemsBlock">
          <button
            type="button"
            className="em-taskItemsToggle"
            aria-expanded={showItems}
            onClick={() => { setShowItems(value => !value) }}
          >
            {showItems ? '收起明细' : `查看明细（${String(task.items.length)} 项）`}
          </button>
          {showItems ? (
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
        </div>
      ) : null}
      {task.plan === undefined ? null : (
        <p className="em-taskMessage em-detailMuted">
          计划内 {String(task.plan.entries.length)} 项、排除 {String(task.plan.excluded.length)} 项
        </p>
      )}
    </section>
  )
}
