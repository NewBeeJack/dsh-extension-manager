/**
 * Update confirmation dialog: shows the Host-built plan (targets, risks,
 * exclusions) and only then lets the user start the update.
 *
 * Plan semantics (implemented by the Host executor):
 *  - batch mode only auto-runs `eligible && !requiresConfirmation`;
 *  - single/retry mode may confirm `eligible || requiresConfirmation` entries —
 *    a locally modified / pre-release / git install is planned as
 *    `eligible=false, requiresConfirmation=true` and becomes executable after
 *    the user acknowledges the risk (and allows overwriting local changes).
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  IconDownloadOutlineRegular,
  IconRefreshOutlineRegular,
  Modal,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { planEntryRiskText } from '../../shared/api'
import type { UpdatePlan, UpdatePlanEntry } from '../../shared/types'
import type { ExtensionRecord } from '../model'
import { InlineNotice, RunningLine, cx } from '../ui'

/** How the dialog was opened. */
export type UpdateDialogMode = 'batch' | 'single' | 'retry'

/** Props of {@link UpdateDialog}. */
export interface UpdateDialogProps {
  open: boolean
  mode: UpdateDialogMode
  plan: UpdatePlan | null
  loading: boolean
  error: string | undefined
  busy: boolean
  preview: boolean
  /** Current records, used to show local-modification facts in the summary. */
  records: readonly ExtensionRecord[]
  onClose: () => void
  onRetry: () => void
  onConfirm: (ids: string[], overwriteLocalModifications: boolean) => void
}

const MODE_TITLES: Record<UpdateDialogMode, string> = {
  batch: '更新全部可安全更新的项目',
  single: '确认更新',
  retry: '重试失败的更新',
}

const LOCAL_MODIFICATION_LABELS: Record<ExtensionRecord['localModification']['state'], string> = {
  unknown: '未知',
  clean: '无本地修改',
  modified: '存在本地修改',
}

/** Target version line for one plan entry, omitted when nothing is known. */
function versionLine(entry: UpdatePlanEntry): string | undefined {
  if (entry.currentVersion === undefined && entry.targetVersion === undefined) return undefined
  if (entry.currentVersion === undefined) return `→ ${entry.targetVersion ?? '?'}`
  if (entry.targetVersion === undefined) return `当前 ${entry.currentVersion}`
  return `${entry.currentVersion} → ${entry.targetVersion}`
}

/** Whether an entry is truly out of scope (not merely waiting for confirmation). */
function isExcluded(entry: UpdatePlanEntry): boolean {
  return !entry.eligible && entry.requiresConfirmation !== true
}

/** One plan entry row. */
function PlanEntry({ entry, record, muted }: {
  entry: UpdatePlanEntry
  record: ExtensionRecord | undefined
  muted: boolean
}): ReactNode {
  const versions = versionLine(entry)
  const modification = record?.localModification
  const excluded = isExcluded(entry)
  const reason = excluded
    ? entry.excludedReason ?? entry.risk ?? '不在本次更新范围内'
    : planEntryRiskText(entry)
  return (
    <li className={cx('em-planItem', muted && 'is-muted')} data-eligible={entry.eligible ? 'true' : 'false'}>
      <div className="em-planTop">
        <span className="em-planName">{entry.displayName !== '' ? entry.displayName : entry.name}</span>
        {versions === undefined ? null : <span className="em-planVersion em-mono">{versions}</span>}
        {entry.needsRestart ? <Tag tone="warning">需要重启</Tag> : null}
        {entry.requiresConfirmation ? <Tag tone="warning">需要确认</Tag> : null}
        {modification !== undefined && modification.state === 'modified' ? <Tag tone="warning">本地已修改</Tag> : null}
        {excluded ? <Tag tone="neutral">已排除</Tag> : null}
      </div>
      <p className="em-planRisk">{reason}</p>
      <p className="em-planSource em-mono">
        {entry.sourceLabel}
        {modification === undefined ? '' : ` · 本地修改：${LOCAL_MODIFICATION_LABELS[modification.state]}`}
      </p>
      {modification === undefined || modification.files === undefined || modification.files.length === 0
        ? null
        : <p className="em-planSource em-mono">{modification.files.join('、')}</p>}
    </li>
  )
}

/** Render the confirmation dialog. */
export function UpdateDialog({
  open, mode, plan, loading, error, busy, preview, records, onClose, onRetry, onConfirm,
}: UpdateDialogProps): ReactNode {
  const [acknowledged, setAcknowledged] = useState(false)

  useEffect(() => {
    if (!open) setAcknowledged(false)
  }, [open])

  const entries = plan?.entries ?? []
  const recordOf = (id: string): ExtensionRecord | undefined => records.find(record => record.id === id)
  const singleTarget = mode !== 'batch'

  // Batch skips anything that needs a confirmation; single/retry can confirm it.
  const confirmable = singleTarget
    ? entries.filter(entry => entry.eligible || entry.requiresConfirmation === true)
    : entries.filter(entry => entry.eligible && !entry.requiresConfirmation)
  const skipped = mode === 'batch' ? entries.filter(entry => entry.requiresConfirmation) : []

  // Everything else in `entries` (and the Host's explicit exclusions) is shown.
  const seen = new Set<string>([...confirmable, ...skipped].map(entry => entry.id))
  const excluded: UpdatePlanEntry[] = []
  for (const entry of entries) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    excluded.push(entry)
  }
  for (const entry of plan?.excluded ?? []) {
    if (seen.has(entry.id)) continue
    seen.add(entry.id)
    excluded.push(entry)
  }

  const confirmIds = confirmable.map(entry => entry.id)
  const needsOverwrite = confirmable.some(entry =>
    recordOf(entry.id)?.localModification.state === 'modified'
    || (entry.risk ?? '').includes('本地修改'))
  const ackRequired = needsOverwrite || confirmable.some(entry => entry.requiresConfirmation)
  const canConfirm = !busy && confirmIds.length > 0 && (!ackRequired || acknowledged)
  const ackLabel = needsOverwrite
    ? '我已了解上述风险，并同意在需要时覆盖本地修改后继续。'
    : '我已了解上述风险，确认继续这次更新。'

  const footer = (
    <>
      <span className="em-detailFooterSpacer" />
      <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>取消</Button>
      <Button
        variant="primary"
        size="sm"
        icon={<IconDownloadOutlineRegular size={13} />}
        disabled={!canConfirm}
        title={canConfirm
          ? '开始更新'
          : confirmIds.length === 0
            ? '没有可执行的项目'
            : '请先勾选确认风险'}
        onClick={() => { onConfirm(confirmIds, needsOverwrite && acknowledged) }}
      >
        {busy ? '正在开始…' : `开始更新${confirmIds.length === 0 ? '' : `（${String(confirmIds.length)}）`}`}
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title={MODE_TITLES[mode]}
      closeLabel="关闭确认对话框"
      description={singleTarget
        ? '检查下面的版本与风险，确认后由 Host 执行备份、安装与校验。'
        : '只自动完成可安全更新的项目；需要确认或覆盖本地修改的项目会被跳过，可逐项更新。'}
      className="em-modalWide em-dialogShell"
      contentClassName="em-modalScroll"
      footer={footer}
    >
      {preview ? <InlineNotice tone="warning" title="预览数据">当前为本地示例计划，不会执行真实更新。</InlineNotice> : null}
      {loading ? <RunningLine text="正在生成更新计划…" /> : null}
      {error === undefined ? null : (
        <InlineNotice
          tone="danger"
          title="无法生成更新计划"
          actions={<Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={onRetry}>重试</Button>}
        >
          {error}
        </InlineNotice>
      )}
      {plan === null || loading || error !== undefined ? null : (
        <>
          {confirmable.length === 0 ? (
            <InlineNotice tone="warning" title="没有可自动执行的项目">
              计划中的项目都需要逐项确认或已被 Host 排除，具体原因列在下方。
            </InlineNotice>
          ) : (
            <>
              <h3 className="em-planSectionTitle">
                {singleTarget ? `将更新 ${String(confirmIds.length)} 项` : `将自动更新 ${String(confirmIds.length)} 项`}
              </h3>
              <ul className="em-planList">
                {confirmable.map(entry => <PlanEntry key={entry.id} entry={entry} record={recordOf(entry.id)} muted={false} />)}
              </ul>
            </>
          )}
          {skipped.length === 0 ? null : (
            <>
              <h3 className="em-planSectionTitle">需要确认，已跳过 {skipped.length} 项（可逐项更新）</h3>
              <ul className="em-planList">
                {skipped.map(entry => <PlanEntry key={entry.id} entry={entry} record={recordOf(entry.id)} muted />)}
              </ul>
            </>
          )}
          {excluded.length === 0 ? null : (
            <>
              <h3 className="em-planSectionTitle">已排除 {excluded.length} 项</h3>
              <ul className="em-planList">
                {excluded.map(entry => <PlanEntry key={entry.id} entry={entry} record={recordOf(entry.id)} muted />)}
              </ul>
            </>
          )}
          {ackRequired ? (
            <label className={cx('em-ack', acknowledged && 'is-checked')}>
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => { setAcknowledged(event.currentTarget.checked) }}
                disabled={busy}
              />
              <span>{ackLabel}</span>
            </label>
          ) : null}
          {needsOverwrite ? (
            <p className="em-detailMuted">
              这些项目带有本地修改；Host 会先备份被修改的文件，只有在勾选确认后才会覆盖。
            </p>
          ) : null}
          <p className="em-detailMuted">
            Host 会在更新前创建备份并在安装后校验；需要重启的项目会在完成后提示。
          </p>
        </>
      )}
    </Modal>
  )
}
