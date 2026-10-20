/**
 * Statistics strip: three primary accounting cells (installed / updatable /
 * abnormal). The two filterable state cells are buttons; low-frequency counts
 * stay available through hints and the "统计详情" disclosure.
 */
import type { ReactNode } from 'react'
import { Tooltip, type TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StatusFilter, StatCell } from '../model'
import { cx } from '../ui'

/** Palette used for a stat cell value (update/abnormal cells draw attention). */
const VALUE_TONE: Partial<Record<string, TagTone>> = {
  updates: 'info',
  abnormal: 'danger',
}

/** Decorative stat icons, deliberately distinct from extension identity icons. */
function StatGlyph({ kind }: { kind: string }): ReactNode {
  if (kind === 'updates') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M12 4.2 19 11h-4.2v8.2H9.2V11H5z" />
      </svg>
    )
  }
  if (kind === 'abnormal') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M12 3 22 21H2zm0 5.2a1.2 1.2 0 0 0-1.2 1.2v5.2a1.2 1.2 0 0 0 2.4 0V9.4A1.2 1.2 0 0 0 12 8.2m0 9.1a1.3 1.3 0 1 0 0 2.6 1.3 1.3 0 0 0 0-2.6" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M3.3 6.7 12 2l8.7 4.7v10.6L12 22l-8.7-4.7zm8.7-2.4L5.8 7.2 12 10.6l6.2-3.4zm-6.8 4.5v6.9L11 19v-6.9zm15 6.9v-6.9L13 12.1V19z" />
    </svg>
  )
}

/** Render the three primary accounting cells. */
export function StatsBar({
  cells, activeStatus, onToggleFilter, loading,
}: {
  cells: readonly StatCell[]
  activeStatus: StatusFilter
  onToggleFilter: (filter: StatusFilter) => void
  loading: boolean
}): ReactNode {
  return (
    <div className="em-stats" role="list" aria-busy={loading}>
      {cells.map((cell) => {
        const filter = cell.filter
        const active = filter !== undefined && activeStatus === filter
        const body = (
          <>
            <span className="em-statIcon" aria-hidden="true"><StatGlyph kind={cell.key} /></span>
            <span className="em-statBody">
              <span className="em-statValue" data-tone={VALUE_TONE[cell.key] ?? 'neutral'}>
                {loading
                  ? <span className="em-statSkeleton" aria-hidden="true" />
                  : cell.valueText ?? String(cell.value)}
              </span>
              <span className="em-statLabel">{cell.label}</span>
            </span>
          </>
        )
        if (filter === undefined) {
          return (
            <div key={cell.key} className="em-stat" data-kind={cell.key} role="listitem" title={cell.hint}>
              {body}
            </div>
          )
        }
        return (
          <Tooltip key={cell.key} label={`${cell.hint}（点击筛选）`} side="bottom" delayMs={400} maxWidth={280}>
            <button
              type="button"
              className={cx('em-stat', 'em-statButton', active && 'is-active')}
              data-kind={cell.key}
              role="listitem"
              aria-pressed={active}
              aria-label={`${cell.label} ${String(cell.value)}，${cell.hint}`}
              onClick={() => { onToggleFilter(filter) }}
            >
              {body}
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
