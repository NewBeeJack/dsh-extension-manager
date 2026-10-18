/**
 * Diagnostics dialog: environment facts, probe results, log locations and the
 * per-source completeness audit of both inventories.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  IconRefreshOutlineRegular,
  Modal,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { DiagnosticsResponse } from '../../shared/api'
import type { Reconciliation, SkillsInventoryPayload } from '../../shared/types'
import { CopyButton, cx, DetailSection, Fact, FactsList, ToneTag } from '../ui'
import { formatDateTime, formatDuration } from '../model'

/** Props of {@link DiagnosticsDialog}. */
export interface DiagnosticsDialogProps {
  open: boolean
  preview: boolean
  plugins: Reconciliation | undefined
  skills: Reconciliation | undefined
  /** Discovery roots from the current skills payload (rendered as an audit table). */
  skillRoots: SkillsInventoryPayload['roots'] | undefined
  onClose: () => void
  loadDiagnostics: () => Promise<DiagnosticsResponse>
}

type DiagnosticsState =
  | { status: 'loading' }
  | { status: 'ready'; data: DiagnosticsResponse }
  | { status: 'error'; message: string }

/** Render the completeness audit of one inventory. */
function ReconciliationBlock({ title, reconciliation }: { title: string; reconciliation: Reconciliation | undefined }): ReactNode {
  if (reconciliation === undefined) {
    return (
      <DetailSection title={`${title}清单完整性`}>
        <p className="em-detailMuted">该清单尚未加载，先关闭诊断并在页面上打开对应页签。</p>
      </DetailSection>
    )
  }
  const failed = reconciliation.sources.filter(source => !source.complete)
  return (
    <DetailSection title={`${title}清单完整性`}>
      <div className="em-reconHead">
        <ToneTag tone={reconciliation.complete ? 'success' : 'danger'}>
          {reconciliation.complete ? '清单完整' : '清单不完整'}
        </ToneTag>
        <span className="em-detailMuted">
          扫描于 {formatDateTime(reconciliation.scannedAt) ?? '未知'}
          {formatDuration(reconciliation.durationMs) === undefined ? '' : ` · 用时 ${formatDuration(reconciliation.durationMs) ?? ''}`}
          {` · ${String(reconciliation.sources.length)} 个来源`}
        </span>
      </div>
      {failed.length > 0 ? (
        <ul className="em-sourceFailures">
          {failed.map(source => (
            <li key={source.id}>
              <strong>{source.label}</strong>
              <span className="em-mono em-sourceId">{source.id}</span>
              <p>{source.error ?? '该来源未能完整读取，但 Host 未提供具体原因'}</p>
              {source.location === undefined ? null : <p className="em-mono em-sourceLocation">{source.location}</p>}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="em-tableWrap">
        <table className="em-table">
          <colgroup>
            <col style={{ width: '30%' }} />
            <col style={{ width: '20%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '8%' }} />
            <col style={{ width: '32%' }} />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">来源</th>
              <th scope="col">贡献</th>
              <th scope="col">数量</th>
              <th scope="col">完整</th>
              <th scope="col">位置 / 错误</th>
            </tr>
          </thead>
          <tbody>
            {reconciliation.sources.map(source => (
              <tr key={source.id} data-complete={source.complete ? 'true' : 'false'}>
                <td>{source.label}</td>
                <td className="em-mono">{source.contributes}</td>
                <td>{source.count === undefined ? '—' : String(source.count)}</td>
                <td>{source.complete ? '是' : '否'}</td>
                <td className="em-tableCellWrap em-mono">{source.error ?? source.location ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {reconciliation.unexplained.length === 0 ? null : (
        <div className="em-reconExtra">
          <h4 className="em-detailSectionTitle">未能对账的记录</h4>
          <ul className="em-fileList">
            {reconciliation.unexplained.map(item => (
              <li key={item.id}>
                <span>{item.name}</span>
                <span className="em-mono em-sourceId">{item.id}</span>
                <span className="em-detailMuted"> · {item.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {reconciliation.notes.length === 0 ? null : (
        <div className="em-reconExtra">
          <h4 className="em-detailSectionTitle">说明</h4>
          <ul className="em-fileList">
            {reconciliation.notes.map(note => <li key={note}>{note}</li>)}
          </ul>
        </div>
      )}
      {Object.keys(reconciliation.counts).length === 0 ? null : (
        <p className="em-detailMuted em-mono">
          {Object.entries(reconciliation.counts).map(([key, value]) => `${key}=${String(value)}`).join(' · ')}
        </p>
      )}
    </DetailSection>
  )
}

/** Render the diagnostics dialog. */
export function DiagnosticsDialog({
  open, preview, plugins, skills, skillRoots, onClose, loadDiagnostics,
}: DiagnosticsDialogProps): ReactNode {
  const [state, setState] = useState<DiagnosticsState>({ status: 'loading' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setState({ status: 'loading' })
    void loadDiagnostics().then(
      (data) => { if (!cancelled) setState({ status: 'ready', data }) },
      (caught: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: caught instanceof Error && caught.message !== '' ? caught.message : '读取诊断信息失败' })
        }
      },
    )
    return () => { cancelled = true }
  }, [open, nonce, loadDiagnostics])

  const footer = (
    <>
      <span className="em-detailFooterSpacer" />
      <Button variant="outline" size="sm" icon={<IconRefreshOutlineRegular size={13} />} onClick={() => { setNonce(value => value + 1) }}>
        重新检查
      </Button>
      <Button variant="primary" size="sm" onClick={onClose}>关闭</Button>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="诊断信息"
      closeLabel="关闭诊断"
      description="环境事实、探测结果与清单完整性审计；路径可复制。"
      className="em-modalWide em-dialogShell"
      contentClassName="em-modalScroll"
      footer={footer}
    >
      {state.status === 'loading' ? <p className="em-detailMuted">正在读取诊断信息…</p> : null}
      {state.status === 'error' ? (
        <div className="em-detailInlineError" role="alert">
          <span>{state.message}</span>
          <Button variant="outline" size="sm" onClick={() => { setNonce(value => value + 1) }}>重试</Button>
        </div>
      ) : null}
      {state.status === 'ready' ? (
        <>
          <DetailSection title="环境">
            <FactsList>
              <Fact label="DSH 版本">{state.data.environment.runtimeVersion ?? '未知'}</Fact>
              <Fact label="Host PID"><span className="em-mono">{String(state.data.environment.hostPid)}</span></Fact>
              <Fact label="平台">{state.data.environment.platform}</Fact>
              <Fact label="Node">{state.data.environment.nodeVersion}</Fact>
              {state.data.environment.pnpmVersion === undefined ? null : <Fact label="pnpm">{state.data.environment.pnpmVersion}</Fact>}
              {state.data.environment.gitVersion === undefined ? null : <Fact label="Git">{state.data.environment.gitVersion}</Fact>}
              <Fact label="HMR">{state.data.environment.hmrEnabled ? '已启用' : '未启用'}</Fact>
              <Fact label="Profile">{state.data.environment.profile.name}</Fact>
              <Fact label="Profile 目录"><span className="em-mono em-breakAnywhere">{state.data.environment.profile.dir}</span></Fact>
              <Fact label="DSH Home"><span className="em-mono em-breakAnywhere">{state.data.environment.profile.dshHome}</span></Fact>
              <Fact label="安装锚点"><span className="em-mono em-breakAnywhere">{state.data.environment.profile.installAnchor}</span></Fact>
              <Fact label="管理器版本">{state.data.environment.manager.version}</Fact>
              <Fact label="自身包名"><span className="em-mono">{state.data.environment.manager.ownPackageName}</span></Fact>
              <Fact label="自身更新">
                {state.data.environment.manager.selfUpdateSupported
                  ? '支持'
                  : `不支持${state.data.environment.manager.selfUpdateReason === undefined ? '' : `：${state.data.environment.manager.selfUpdateReason}`}`}
              </Fact>
              <Fact label="Registry"><span className="em-mono em-breakAnywhere">{state.data.environment.registries.registry ?? '默认'}</span></Fact>
              {state.data.environment.registries.fallbackRegistries.length === 0
                ? null
                : (
                  <Fact label="备用 Registry">
                    <span className="em-mono em-breakAnywhere">{state.data.environment.registries.fallbackRegistries.join('、')}</span>
                  </Fact>
                )}
              {state.data.environment.networkProxy === undefined ? null : <Fact label="网络代理">{state.data.environment.networkProxy}</Fact>}
              <Fact label="状态目录">
                <span className="em-pathRow">
                  <span className="em-mono em-breakAnywhere">{state.data.environment.manager.stateDir}</span>
                  <CopyButton text={state.data.environment.manager.stateDir} label="复制状态目录" />
                </span>
              </Fact>
              <Fact label="日志目录">
                <span className="em-pathRow">
                  <span className="em-mono em-breakAnywhere">{state.data.environment.manager.logDir}</span>
                  <CopyButton text={state.data.environment.manager.logDir} label="复制日志目录" />
                </span>
              </Fact>
              {state.data.logs.latestLog === undefined ? null : (
                <Fact label="最新日志">
                  <span className="em-pathRow">
                    <span className="em-mono em-breakAnywhere">{state.data.logs.latestLog}</span>
                    <CopyButton text={state.data.logs.latestLog} label="复制日志路径" />
                  </span>
                </Fact>
              )}
              <Fact label="备份目录">
                <span className="em-pathRow">
                  <span className="em-mono em-breakAnywhere">{state.data.environment.manager.backupDir}</span>
                  <CopyButton text={state.data.environment.manager.backupDir} label="复制备份目录" />
                </span>
              </Fact>
            </FactsList>
          </DetailSection>

          <DetailSection title="探测结果">
            {state.data.probes.length === 0
              ? <p className="em-detailMuted">Host 未提供探测结果。</p>
              : (
                <ul className="em-probeList">
                  {state.data.probes.map(probe => (
                    <li key={probe.name} className="em-probe">
                      <ToneTag tone={probe.ok ? 'success' : 'danger'}>{probe.ok ? '正常' : '异常'}</ToneTag>
                      <span className="em-probeName">{probe.name}</span>
                      {probe.detail === undefined ? null : <span className="em-detailMuted">{probe.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
          </DetailSection>

          <DetailSection title="限制">
            {state.data.environment.limitations.length === 0
              ? <p className="em-detailMuted">当前没有已知限制。</p>
              : (
                <ul className="em-fileList">
                  {state.data.environment.limitations.map(limitation => <li key={limitation}>{limitation}</li>)}
                </ul>
              )}
          </DetailSection>

          <DetailSection title="技能 Provider">
            <div className="em-tableWrap">
              <table className="em-table">
                <colgroup>
                  <col style={{ width: '20%' }} />
                  <col style={{ width: '14%' }} />
                  <col style={{ width: '66%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col">Provider</th>
                    <th scope="col">是否受管</th>
                    <th scope="col">根目录</th>
                  </tr>
                </thead>
                <tbody>
                  {state.data.environment.skillProviders.map(provider => (
                    <tr key={provider.key}>
                      <td className="em-mono">{provider.key}</td>
                      <td>{provider.managed ? '是' : '否'}</td>
                      <td className="em-tableCellWrap em-mono">{provider.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DetailSection>

          <DetailSection title="技能根目录（Skills 清单）">
            {skillRoots === undefined || skillRoots.length === 0 ? (
              <p className="em-detailMuted">Skills 清单尚未加载，先关闭诊断并在页面上打开 Skills 页签。</p>
            ) : (
              <div className="em-tableWrap">
                <table className="em-table">
                  <colgroup>
                    <col style={{ width: '27%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '9%' }} />
                    <col style={{ width: '8%' }} />
                    <col style={{ width: '38%' }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th scope="col">根目录</th>
                      <th scope="col">rank</th>
                      <th scope="col">受管</th>
                      <th scope="col">完整</th>
                      <th scope="col">数量</th>
                      <th scope="col">路径</th>
                    </tr>
                  </thead>
                  <tbody>
                    {skillRoots.map(root => (
                      <tr key={root.key} data-complete={root.complete ? 'true' : 'false'}>
                        <td>{root.label}<span className="em-sourceId em-mono">{root.key}</span></td>
                        <td>{root.rank === undefined ? '—' : String(root.rank)}</td>
                        <td>{root.managed ? '是' : '否'}</td>
                        <td>{root.complete ? '是' : '否'}</td>
                        <td>{String(root.count)}</td>
                        <td className="em-tableCellWrap em-mono">
                          {root.path}
                          {root.error === undefined ? null : <span className="em-errorText"> · {root.error}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </DetailSection>

          <ReconciliationBlock title="Plugins " reconciliation={plugins} />
          <ReconciliationBlock title="Skills " reconciliation={skills} />

          {preview ? (
            <p className="em-detailMuted">当前为预览数据（?emFixture=1），环境块来自本地示例，不代表真实 Host。</p>
          ) : null}
        </>
      ) : null}
    </Modal>
  )
}

/** Re-exported so the page can render a compact completeness summary. */
export function failedSources(reconciliation: Reconciliation | undefined): number {
  return reconciliation === undefined ? 0 : reconciliation.sources.filter(source => !source.complete).length
}

/** Tone for a completeness summary line. */
export function reconciliationTone(reconciliation: Reconciliation | undefined): 'success' | 'danger' | 'neutral' {
  if (reconciliation === undefined) return 'neutral'
  return reconciliation.complete ? 'success' : 'danger'
}

/** Shared class helper for the diagnostics summary badges. */
export const diagnosticsBadgeClass = (active: boolean): string => cx('em-badge', active && 'is-active')
