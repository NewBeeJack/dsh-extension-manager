/**
 * Extension identity icon: verified self-provided icon first, otherwise a
 * local default glyph. No name-based brand guessing and no network loading.
 */
import { useState, type ReactNode } from 'react'

import { DEFAULT_PLUGIN_ICON } from '../default-plugin-icon'
import { isSafeIconDataUrl } from '../icon-safety'

/** Local default plugin glyph: white solid puzzle on the shared light-blue plate. */
function PluginGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5A2.5 2.5 0 0 0 10.5 1 2.5 2.5 0 0 0 8 3.5V5H4a2 2 0 0 0-2 2v3.8h1.5a2.5 2.5 0 0 1 0 5H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.5 2.5 0 0 1 5 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 1 0-5Z"
      />
    </svg>
  )
}

/** Local default Skill glyph: white document with a folded corner. */
function SkillGlyph(): ReactNode {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
      <path fill="rgba(205,227,243,0.95)" d="M14 2v5a1 1 0 0 0 1 1h5Z" />
    </svg>
  )
}

/** Render one extension icon inside a fixed, accessible container. */
export function ExtensionIcon({ kind, icon }: { kind: 'plugin' | 'skill'; icon?: string }): ReactNode {
  const [failed, setFailed] = useState(false)
  const [defaultFailed, setDefaultFailed] = useState(false)
  const candidate = icon?.trim()
  const usable = isSafeIconDataUrl(candidate) && !failed
  if (usable) {
    return (
      <span className="em-extIcon" data-kind="plugin" aria-hidden="true">
        <img
          className="em-extIconImage"
          src={candidate}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => { setFailed(true) }}
        />
      </span>
    )
  }
  if (kind === 'skill') {
    return (
      <span className="em-extIcon" data-kind="skill" aria-hidden="true">
        <SkillGlyph />
      </span>
    )
  }
  if (!defaultFailed) {
    return (
      <span className="em-extIcon em-extIconDefault" data-kind="plugin" data-default-plugin="true" aria-hidden="true">
        <img
          className="em-defaultPluginImage"
          src={DEFAULT_PLUGIN_ICON}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => { setDefaultFailed(true) }}
        />
      </span>
    )
  }
  return (
    <span className="em-extIcon" data-kind="plugin" aria-hidden="true">
      <PluginGlyph />
    </span>
  )
}
