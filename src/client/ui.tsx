/**
 * Small shared view atoms of the Extension Manager page.
 *
 * Every atom renders only `--dsw-*` tokens (see styles.ts) and platform
 * primitives, so light/dark theming and keyboard behavior come from the shell.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconChevronDownOutlineRegular,
  IconCopyOutlineRegular,
  IconCloseCircleFillRegular,
  IconInfoOutlineRegular,
  IconRefreshOutlineRegular,
  IconWarningTriangleOutlineRegular,
  Menu,
  StateDot,
  Tag,
  TextShimmer,
  Tooltip,
  writeClipboard,
  type MenuEntry,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { StatusView } from './model'

/** Compose conditional class names without a dependency. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ')
}

/** Visually hidden text that stays readable by assistive technology. */
export function VisuallyHidden({ children }: { children: ReactNode }): ReactNode {
  return <span className="em-srOnly">{children}</span>
}

/* ------------------------------------------------------------------ *
 * Notices
 * ------------------------------------------------------------------ */

export type NoticeTone = 'info' | 'warning' | 'danger' | 'success'

/** Inline banner used for preview data, incomplete inventories and errors. */
export function InlineNotice({
  tone, title, children, actions, icon,
}: {
  tone: NoticeTone
  title?: string
  children: ReactNode
  actions?: ReactNode
  icon?: ReactNode
}): ReactNode {
  const fallback = tone === 'danger'
    ? <IconCloseCircleFillRegular size={14} />
    : tone === 'warning'
      ? <IconWarningTriangleOutlineRegular size={14} />
      : <IconInfoOutlineRegular size={14} />
  return (
    <div className="em-notice" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
      <span className="em-noticeIcon" aria-hidden="true">{icon ?? fallback}</span>
      <div className="em-noticeBody">
        {title === undefined ? null : <strong className="em-noticeTitle">{title}</strong>}
        <div className="em-noticeText">{children}</div>
      </div>
      {actions === undefined ? null : <div className="em-noticeActions">{actions}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Tags, dots, copy
 * ------------------------------------------------------------------ */

/** One colored status capsule. */
export function StatusTag({ view, title }: { view: StatusView; title?: string | undefined }): ReactNode {
  return (
    <Tag tone={view.tone} className="em-statusTag">
      <span className="em-statusTagText" title={title}>{view.label}</span>
    </Tag>
  )
}

/** Named state dot (StateDot itself is aria-hidden). */
export function NamedStateDot({ view }: { view: StatusView }): ReactNode {
  return (
    <span className="em-namedDot" role="img" aria-label={view.label} title={view.label}>
      <StateDot state={view.dot} />
    </span>
  )
}

const COPY_FEEDBACK_MS = 1400

/** Icon button that copies `text` with transient success feedback. */
export function CopyButton({ text, label, className }: {
  text: string
  label: string
  className?: string | undefined
}): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])
  const onCopy = (): void => {
    void writeClipboard(text).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => { setCopied(false) }, COPY_FEEDBACK_MS)
    })
  }
  const button = (
    <button
      type="button"
      className={cx('em-iconBtn', 'em-copyBtn', copied && 'is-copied', className)}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
      onClick={onCopy}
    >
      {copied ? <IconCheckOutlineRegular size={12} /> : <IconCopyOutlineRegular size={12} />}
    </button>
  )
  return <Tooltip label={copied ? '已复制' : label} side="top" delayMs={300}>{button}</Tooltip>
}

/** Copy a full installation path with explicit success/failure feedback. */
export function PathCopyButton({ path, label = '复制安装路径' }: {
  path: string
  label?: string
}): ReactNode {
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
  }, [])
  const onCopy = (event: { stopPropagation: () => void }): void => {
    event.stopPropagation()
    void writeClipboard(path).then((ok) => {
      setState(ok ? 'ok' : 'error')
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => { setState('idle') }, COPY_FEEDBACK_MS)
    }, () => {
      setState('error')
      if (timer.current !== undefined) clearTimeout(timer.current)
      timer.current = setTimeout(() => { setState('idle') }, COPY_FEEDBACK_MS)
    })
  }
  const feedback = state === 'ok' ? '已复制路径' : state === 'error' ? '复制失败' : undefined
  return (
    <span className="em-pathCopy">
      <Tooltip label={label} side="top" delayMs={300}>
        <button
          type="button"
          className={cx('em-iconBtn', 'em-pathCopyBtn', state === 'ok' && 'is-copied', state === 'error' && 'is-error')}
          aria-label={feedback ?? label}
          title={feedback ?? label}
          onClick={onCopy}
        >
          {state === 'ok' ? <IconCheckOutlineRegular size={12} /> : <IconCopyOutlineRegular size={12} />}
        </button>
      </Tooltip>
      {feedback === undefined ? null : (
        <span className={cx('em-pathCopyFeedback', state === 'error' && 'is-error')} role="status">{feedback}</span>
      )}
    </span>
  )
}

/** One compact icon-only action with an accessible name and an honest disabled reason. */
export function IconAction({
  label, onClick, disabled, disabledReason, children, className, busy,
}: {
  label: string
  onClick: () => void
  disabled?: boolean | undefined
  disabledReason?: string | undefined
  children: ReactNode
  className?: string | undefined
  busy?: boolean | undefined
}): ReactNode {
  const reason = disabled === true ? disabledReason : undefined
  const button = (
    <button
      type="button"
      className={cx('em-iconBtn', className)}
      aria-label={label}
      title={reason ?? label}
      aria-disabled={disabled === true ? true : undefined}
      disabled={disabled === true}
      onClick={onClick}
    >
      {busy === true ? <IconRefreshOutlineRegular size={13} className="em-spin" /> : children}
    </button>
  )
  if (disabled === true || reason !== undefined) return button
  return <Tooltip label={label} side="top" delayMs={350}>{button}</Tooltip>
}

/* ------------------------------------------------------------------ *
 * Definition lists used by the details and diagnostics dialogs
 * ------------------------------------------------------------------ */

/** Two-column fact grid; render {@link Fact} children. */
export function FactsList({ children, className }: { children: ReactNode; className?: string | undefined }): ReactNode {
  return <dl className={cx('em-facts', className)}>{children}</dl>
}

/** One label/value fact inside {@link FactsList}. */
export function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }): ReactNode {
  return (
    <div className="em-fact">
      <dt>{label}</dt>
      <dd className={mono === true ? 'em-mono' : undefined}>{children === '' || children === undefined ? '—' : children}</dd>
    </div>
  )
}

/** One copyable path fact. */
export function PathFact({ label, path, hint }: { label: string; path: string | undefined; hint?: string | undefined }): ReactNode {
  if (path === undefined || path === '') {
    return <Fact label={label}>—</Fact>
  }
  return (
    <div className="em-fact">
      <dt>{label}</dt>
      <dd>
        <span className="em-pathRow">
          <span className="em-mono em-pathValue" title={path}>{path}</span>
          <CopyButton text={path} label={`复制${label}`} />
        </span>
        {hint === undefined ? null : <span className="em-factHint">{hint}</span>}
      </dd>
    </div>
  )
}

/** A titled block inside a dialog. */
export function DetailSection({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }): ReactNode {
  return (
    <section className="em-detailSection">
      <div className="em-detailSectionHead">
        <h3 className="em-detailSectionTitle">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/* ------------------------------------------------------------------ *
 * Menu-backed select
 * ------------------------------------------------------------------ */

/** One option of a {@link MenuSelect}. */
export interface MenuSelectOption {
  id: string
  label: string
  disabled?: boolean
}

/** A compact toolbar select built on the anchored Menu primitive. */
export function MenuSelect({
  label, value, options, onChange, disabled, disabledReason, className, align = 'start',
}: {
  label: string
  value: string
  options: readonly MenuSelectOption[]
  onChange: (id: string) => void
  disabled?: boolean | undefined
  disabledReason?: string | undefined
  className?: string | undefined
  align?: 'start' | 'end' | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  const current = options.find(option => option.id === value)
  const items: MenuEntry[] = options.map(option => ({
    id: option.id,
    label: option.label,
    ...(option.disabled === true ? { disabled: true } : {}),
  }))
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={items}
      selectedId={value}
      onSelect={(id) => {
        setOpen(false)
        if (id !== value) onChange(id)
      }}
      align={align === 'end' ? 'end' : 'start'}
      portal
      className={cx('em-menuAnchor', className)}
      anchor={(
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="em-filterBtn"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled === true}
          title={disabled === true ? disabledReason : `${label}：${current?.label ?? '未选择'}`}
          onClick={() => { setOpen(value => !value) }}
        >
          <span className="em-filterText">
            <span className="em-filterLabel">{label}</span>
            <span className="em-filterValue">{current?.label ?? '未选择'}</span>
          </span>
          <IconChevronDownOutlineRegular size={12} className="em-chevron" aria-hidden="true" />
        </Button>
      )}
    />
  )
}

/* ------------------------------------------------------------------ *
 * Loading / empty / error
 * ------------------------------------------------------------------ */

/** Placeholder rows shown while the first inventory load is in flight. */
export function SkeletonRows({ rows = 4 }: { rows?: number }): ReactNode {
  return (
    <div className="em-skeletonList" role="status" aria-label="正在加载清单">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="em-skeletonRow" aria-hidden="true">
          <span className="em-skeletonIcon" />
          <span className="em-skeletonBody">
            <span className="em-skeletonBar" />
            <span className="em-skeletonBar em-skeletonBarWide" />
            <span className="em-skeletonBar em-skeletonBarShort" />
          </span>
        </div>
      ))}
    </div>
  )
}

/** Centered empty state with an optional action. */
export function EmptyState({
  icon, title, description, action,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
}): ReactNode {
  return (
    <div className="em-empty">
      <span className="em-emptyIcon" aria-hidden="true">{icon}</span>
      <p className="em-emptyTitle">{title}</p>
      <p className="em-emptyText">{description}</p>
      {action === undefined ? null : <div className="em-emptyAction">{action}</div>}
    </div>
  )
}

/** Full-page load failure with a retry. */
export function ErrorState({
  title, message, detail, onRetry, retrying,
}: {
  title: string
  message: string
  detail?: string | undefined
  onRetry: () => void
  retrying?: boolean | undefined
}): ReactNode {
  return (
    <div className="em-errorState" role="alert">
      <span className="em-errorIcon" aria-hidden="true"><IconCloseCircleFillRegular size={18} /></span>
      <p className="em-errorTitle">{title}</p>
      <p className="em-errorText">{message}</p>
      {detail === undefined ? null : <p className="em-errorDetail em-mono">{detail}</p>}
      <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} disabled={retrying === true} onClick={onRetry}>
        {retrying === true ? '正在重试…' : '重试'}
      </Button>
    </div>
  )
}

/** Animated "work in progress" line. */
export function RunningLine({ text }: { text: string }): ReactNode {
  return (
    <span className="em-runningLine" role="status">
      <StateDot state="ongoing" />
      <TextShimmer active>{text}</TextShimmer>
    </span>
  )
}

/** Thin progress bar for a task. */
export function ProgressBar({ completed, total }: { completed: number; total: number }): ReactNode {
  const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, completed / total))
  return (
    <div
      className="em-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-label="任务进度"
    >
      <span className="em-progressFill" style={{ width: `${String(Math.round(ratio * 100))}%` }} />
    </div>
  )
}

/** Small inline tag with a tone, used by task/diagnostic rows. */
export function ToneTag({ tone, children }: { tone: TagTone; children: ReactNode }): ReactNode {
  return <Tag tone={tone} className="em-inlineTag">{children}</Tag>
}
