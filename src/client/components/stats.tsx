/**
 * Statistics strip: five accounting cells whose numbers come straight from the
 * Host payload. The two cells that describe a filterable state are buttons.
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

/** Render the five accounting cells. */
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
            <span className="em-statValue" data-tone={VALUE_TONE[cell.key] ?? 'neutral'}>
              {loading
                ? <span className="em-statSkeleton" aria-hidden="true" />
                : cell.valueText ?? String(cell.value)}
            </span>
            <span className="em-statLabel">{cell.label}</span>
          </>
        )
        if (filter === undefined) {
          return (
            <div key={cell.key} className="em-stat" role="listitem" title={cell.hint}>
              {body}
            </div>
          )
        }
        return (
          <Tooltip key={cell.key} label={`${cell.hint}（点击筛选）`} side="bottom" delayMs={400} maxWidth={280}>
            <button
              type="button"
              className={cx('em-stat', 'em-statButton', active && 'is-active')}
              role="listitem"
              aria-pressed={active}
              aria-label={`${cell.label} ${String(cell.value)}，${cell.hint}`}
              onClick={() => { onToggleFilter(filter) }}
            >
              {body}
              <span className="em-statFilterGlyph" aria-hidden="true">筛选</span>
            </button>
          </Tooltip>
        )
      })}
    </div>
  )
}
