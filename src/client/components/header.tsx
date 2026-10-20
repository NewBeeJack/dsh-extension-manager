/**
 * Page header: title, one-line intro, the Plugins/Skills segmented control and
 * the quiet "last scanned" metadata.
 */
import type { ReactNode } from 'react'
import { SegmentedControl, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ViewScope } from '../model'

const SCOPE_OPTIONS = [
  { value: 'plugins', label: 'Plugins' },
  { value: 'skills', label: 'Skills' },
] as const

/** Header of the settings section. */
export function HeaderBar({
  scope, onScopeChange, preview, scanMeta, scanTitle, onOpenDiagnostics,
}: {
  scope: ViewScope
  onScopeChange: (scope: ViewScope) => void
  preview: boolean
  scanMeta: string | undefined
  scanTitle: string | undefined
  onOpenDiagnostics: () => void
}): ReactNode {
  return (
    <header className="em-head">
      <div className="em-headTop">
        <div className="em-headText">
          <div className="em-titleRow">
            <h2 className="em-title">扩展管理器</h2>
            {preview ? <Tag tone="warning" className="em-previewTag">预览数据</Tag> : null}
          </div>
          <p className="em-intro">查看本机安装的 Plugins 与 Skills，检查可用更新并安全地完成升级。</p>
        </div>
      </div>
      <div className="em-tabsRow">
        <SegmentedControl<ViewScope>
          id="em-scope"
          label="扩展类型"
          className="em-scopeTabs"
          value={scope}
          options={SCOPE_OPTIONS}
          onChange={onScopeChange}
        />
        <div className="em-headAside">
          {scanMeta === undefined ? null : <span className="em-scanMeta" title={scanTitle}>{scanMeta}</span>}
          <button type="button" className="em-headDiag" onClick={onOpenDiagnostics}>诊断</button>
        </div>
      </div>
    </header>
  )
}
