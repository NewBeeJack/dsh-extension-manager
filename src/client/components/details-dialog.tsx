/**
 * Details dialog for one plugin or skill: every contract field the record
 * carries, copyable paths, a safe GitHub link, diagnostics and update history.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  Button,
  IconCordisPluginOutlineRegular,
  IconDownloadOutlineRegular,
  IconInspectOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconSkillOutlineRegular,
  IconSparkleRegular,
  Modal,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HistoryEntry } from '../../shared/types'
import {
  checkBlockedReason,
  deriveSignals,
  FIBER_LABELS,
  formatDateTime,
  formatRelative,
  HISTORY_ACTION_LABELS,
  HISTORY_OUTCOME_VIEWS,
  invocationText,
  isBundle,
  isPluginRow,
  isSkill,
  isSkillCopy,
  KIND_LABELS,
  LAYOUT_LABELS,
  recordDescription,
  recordName,
  recordCheckedAt,
  recordTechnicalName,
  recordVersionText,
  SCOPE_LABELS,
  SOURCE_KIND_LABELS,
  statusViewOf,
  TRUST_LABELS,
  updateBlockedReason,
  type ExtensionRecord,
} from '../model'
import {
  CopyButton,
  DetailSection,
  Fact,
  FactsList,
  PathFact,
  StatusTag,
  ToneTag,
  cx,
} from '../ui'

/** Props of {@link DetailsDialog}. */
export interface DetailsDialogProps {
  record: ExtensionRecord | null
  busy: boolean
  checking: boolean
  preview: boolean
  onClose: () => void
  onCheck: (record: ExtensionRecord) => void
  onUpdate: (record: ExtensionRecord) => void
  onOpenDiagnostics: () => void
  loadHistory: () => Promise<HistoryEntry[]>
}

const CHANNEL_LABELS: Record<NonNullable<ExtensionRecord['version']['channel']>, string> = {
  stable: '稳定版',
  prerelease: '预发布版',
  tag: '标签',
  commit: '提交（commit）',
  unknown: '未知',
}

const COMPATIBILITY_LABELS: Record<NonNullable<ExtensionRecord['version']['compatibility']>, string> = {
  compatible: '兼容当前 DSH',
  incompatible: '与当前 DSH 不兼容',
  unknown: '未知',
}

const LOCAL_MODIFICATION_LABELS: Record<ExtensionRecord['localModification']['state'], string> = {
  unknown: '未知',
  clean: '无本地修改',
  modified: '存在本地修改',
}

const DIAGNOSTIC_TONES = { info: 'info', warning: 'warning', error: 'danger' } as const

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: HistoryEntry[] }
  | { status: 'error'; message: string }

/** Whether a URL is safe to open in a new tab. */
function httpsUrl(url: string | undefined): string | undefined {
  if (url === undefined || !url.startsWith('https://')) return undefined
  return url
}

/** Render one dialog field only when the value exists (never invent facts). */
function optionalFact(label: string, value: ReactNode): ReactNode {
  return value === undefined || value === null || value === '' ? null : <Fact label={label}>{value}</Fact>
}

/** Optional string fact, rendered only when the contract actually carries it. */
function textFact(label: string, value: string | undefined, mono = false): ReactNode {
  if (value === undefined || value === '') return null
  return <Fact label={label}>{mono ? <span className="em-mono">{value}</span> : value}</Fact>
}

/** Render the update-history block. */
function HistoryBlock({ record, state, onRetry }: {
  record: ExtensionRecord
  state: HistoryState
  onRetry: () => void
}): ReactNode {
  if (state.status === 'loading') {
    return <p className="em-detailMuted">正在读取更新历史…</p>
  }
  if (state.status === 'error') {
    return (
      <div className="em-detailInlineError" role="alert">
        <span>{state.message}</span>
        <Button variant="outline" size="sm" onClick={onRetry}>重试</Button>
      </div>
    )
  }
  const entries = state.entries.filter(entry => entry.name === record.name || entry.name === record.displayName)
  if (entries.length === 0) {
    return <p className="em-detailMuted">暂无与「{recordName(record)}」相关的更新记录。</p>
  }
  return (
    <ul className="em-historyList">
      {entries.map(entry => {
        const outcome = HISTORY_OUTCOME_VIEWS[entry.outcome]
        return (
          <li key={entry.id} className="em-historyItem">
            <div className="em-historyTop">
              <span className="em-historyTime" title={formatDateTime(entry.at)}>{formatRelative(entry.at)}</span>
              <Tag tone={outcome.tone}>{outcome.label}</Tag>
              <span className="em-historyAction">{[HISTORY_ACTION_LABELS[entry.action], entry.fromVersion !== undefined || entry.toVersion !== undefined ? `${entry.fromVersion ?? '?'} → ${entry.toVersion ?? '?'}` : undefined].filter((part): part is string => part !== undefined).join(' · ')}</span>
            </div>
            <p className="em-historyMessage">{entry.message}</p>
            {entry.transactionId === undefined ? null : (
              <p className="em-historyMeta em-mono">事务 {entry.transactionId}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** Render the record-specific sections. */
function RecordSections({ record }: { record: ExtensionRecord }): ReactNode {
  const signals = deriveSignals(record)
  const version = record.version
  const source = record.source
  const url = httpsUrl(source.url)
  const invocation = isSkill(record) ? invocationText(record.invocation) : undefined

  return (
    <>
      <DetailSection title="概览">
        <FactsList>
          <Fact label="类型">{KIND_LABELS[record.kind]}</Fact>
          <Fact label="技术名称"><span className="em-mono">{recordTechnicalName(record)}</span></Fact>
          <Fact label="管理范围">{SCOPE_LABELS[record.scope]}</Fact>
          {optionalFact('Profile', 'profile' in record && record.profile !== '' ? <span className="em-mono">{record.profile}</span> : undefined)}
          <Fact label="版本">
            <span className="em-mono">{recordVersionText(record) ?? '未知'}</span>
            {version.available === undefined || version.available === version.current ? null : (
              <span className="em-detailVersionAvailable">（可用 {version.available}）</span>
            )}
          </Fact>
          <Fact label="状态"><StatusTag view={statusViewOf(record)} /></Fact>
          {optionalFact('说明', version.reason)}
        </FactsList>
      </DetailSection>

      <DetailSection title="更新">
        <FactsList>
          <Fact label="更新状态">{statusViewOf(record).label}</Fact>
          {optionalFact(
            '可用版本',
            version.available === undefined || (version.status === 'up-to-date' && version.available === version.current)
              ? undefined
              : version.available,
          )}
          {optionalFact('发布通道', version.channel === undefined ? undefined : CHANNEL_LABELS[version.channel])}
          {optionalFact('兼容性', version.compatibility === undefined ? undefined : COMPATIBILITY_LABELS[version.compatibility])}
          {version.compatibilityRequirements === undefined
            ? null
            : optionalFact('兼容要求', (
              <ul className="em-requirementList">
                {Object.entries(version.compatibilityRequirements).map(([key, range]) => (
                  <li key={key}><span className="em-mono">{key}: {range}</span></li>
                ))}
              </ul>
            ))}
          <Fact label="最后检查">
            {version.lastCheckedAt === undefined
              ? '尚未检查'
              : `${formatDateTime(version.lastCheckedAt) ?? ''}（${formatRelative(version.lastCheckedAt) ?? ''}）`}
          </Fact>
          {version.currentCommit === undefined ? null : optionalFact('当前提交', <span className="em-mono">{version.currentCommit}</span>)}
          {version.currentTree === undefined ? null : optionalFact('当前技能树', <span className="em-mono">{version.currentTree}</span>)}
          {version.availableCommit === undefined ? null : optionalFact('可用提交', <span className="em-mono">{version.availableCommit}</span>)}
          {version.availableTree === undefined ? null : optionalFact('可用技能树', <span className="em-mono">{version.availableTree}</span>)}
          {optionalFact('检查能力', record.actions.canCheck ? '可检查' : checkBlockedReason(record))}
          {optionalFact('更新能力', record.actions.canUpdate ? '可由扩展管理器更新' : updateBlockedReason(record))}
          {record.actions.requiresConfirmation === true ? <Fact label="确认要求">更新前需要确认风险或覆盖本地修改</Fact> : null}
        </FactsList>
      </DetailSection>

      <DetailSection title="来源">
        <FactsList>
          <Fact label="来源类型">{SOURCE_KIND_LABELS[source.kind]}</Fact>
          <Fact label="可信度">{TRUST_LABELS[source.trust]}</Fact>
          <Fact label="来源标签">{source.label}</Fact>
          {textFact('包名', source.packageName, true)}
          {textFact('安装 spec', source.spec, true)}
          {textFact('仓库', source.repo, true)}
          {textFact('registry', source.registry, true)}
          {textFact('分支 / 标签', source.ref, true)}
          {textFact('提交', source.commit, true)}
          {textFact('子目录', source.subdir, true)}
          {textFact('来源说明', source.detail)}
          {url === undefined ? null : (
            <div className="em-fact">
              <dt>URL</dt>
              <dd>
                <span className="em-pathRow">
                  <a className="em-link" href={url} target="_blank" rel="noreferrer noopener">{url}</a>
                  <CopyButton text={url} label="复制来源 URL" />
                </span>
              </dd>
            </div>
          )}
        </FactsList>
      </DetailSection>

      <DetailSection title="运行时">
        <FactsList>
          <Fact label="已安装">{record.runtime.installed ? '是' : '否'}</Fact>
          {record.runtime.enabled === undefined ? null : <Fact label="已启用">{record.runtime.enabled ? '是' : '否'}</Fact>}
          {record.runtime.loaded === undefined ? null : <Fact label="当前已加载">{record.runtime.loaded ? '是' : '否'}</Fact>}
          {record.runtime.fiberPhase === undefined || record.runtime.fiberPhase === null
            ? null
            : <Fact label="Loader 阶段">{FIBER_LABELS[record.runtime.fiberPhase]}</Fact>}
          {record.runtime.restartRequired === true ? <Fact label="重启">需要重启 DSH 后生效</Fact> : null}
          {record.runtime.verifiedAfterUpdate === undefined
            ? null
            : <Fact label="更新后校验">{record.runtime.verifiedAfterUpdate ? '已通过端到端校验' : '尚未通过校验'}</Fact>}
          {record.runtime.catalogIncomplete === true ? <Fact label="目录观察">该 Provider 的目录观察不完整</Fact> : null}
          {optionalFact('运行时错误', record.runtime.error === undefined ? undefined : <span className="em-errorText">{record.runtime.error}</span>)}
        </FactsList>
      </DetailSection>

      <DetailSection title="路径">
        <FactsList>
          <PathFact label="安装目录" path={record.paths.installDir} />
          <PathFact label="清单文件" path={record.paths.manifestPath} hint={isSkill(record) ? 'SKILL.md 路径' : 'package.json 路径'} />
          <PathFact label="真实解析路径" path={record.paths.resolvedPath} hint={record.paths.resolvedPath === undefined ? undefined : 'link/工作区安装指向的实际目录'} />
          <PathFact label="根目录" path={record.paths.rootDir} />
        </FactsList>
      </DetailSection>

      <DetailSection title="本地修改">
        <FactsList>
          <Fact label="本地状态">
            <ToneTag tone={record.localModification.state === 'modified' ? 'warning' : record.localModification.state === 'clean' ? 'success' : 'neutral'}>
              {LOCAL_MODIFICATION_LABELS[record.localModification.state]}
            </ToneTag>
          </Fact>
          {record.localModification.files === undefined || record.localModification.files.length === 0
            ? null
            : optionalFact('修改文件', (
              <ul className="em-fileList">
                {record.localModification.files.map(file => <li key={file} className="em-mono">{file}</li>)}
              </ul>
            ))}
          {optionalFact('说明', record.localModification.detail)}
        </FactsList>
      </DetailSection>

      {isBundle(record) ? (
        <>
          <DetailSection title="插件包">
            <FactsList>
              <Fact label="可用位置">{isBundle(record) ? (record.availability === 'installation' ? '随 DSH 安装提供' : record.availability === 'profile' ? 'Profile 中安装' : '找不到安装目录') : ''}</Fact>
              <Fact label="官方插件">{record.official ? '是' : '否'}</Fact>
              <Fact label="可移除">{record.removable ? '是' : '否'}</Fact>
              {optionalFact('只读原因', record.readOnlyReason)}
              {record.alsoInProfiles === undefined || record.alsoInProfiles.length === 0
                ? null
                : optionalFact('同时声明的 Profile', <span className="em-mono">{record.alsoInProfiles.join('、')}</span>)}
              {record.self === true ? <Fact label="自身">这是扩展管理器自己的包</Fact> : null}
            </FactsList>
          </DetailSection>
          <DetailSection title={`贡献的插件行（${String(record.rows.length)}）`}>
            {record.rows.length === 0
              ? <p className="em-detailMuted">这个插件包没有向 Loader 贡献可观察的插件行。</p>
              : (
                <ul className="em-rowSummaryList">
                  {record.rows.map(row => (
                    <li key={row.entryId} className="em-rowSummary">
                      <div className="em-rowSummaryTop">
                        <span className="em-rowSummaryName">{row.displayName ?? row.moduleName}</span>
                        <Tag tone={row.enabled ? 'success' : 'neutral'}>{row.enabled ? '已启用' : '未启用'}</Tag>
                        {row.overrides === true ? <Tag tone="info">覆盖内置</Tag> : null}
                        {row.fiberPhase !== undefined && row.fiberPhase !== null && row.fiberPhase !== 'active'
                          ? <Tag tone={row.fiberPhase === 'failed' ? 'danger' : 'neutral'}>{FIBER_LABELS[row.fiberPhase]}</Tag>
                          : null}
                      </div>
                      <p className="em-rowSummaryMeta em-mono">{row.entryId} · {row.moduleName}</p>
                      {row.readOnlyReason === undefined ? null : <p className="em-rowSummaryNote">只读：{row.readOnlyReason}</p>}
                      {row.error === undefined ? null : <p className="em-rowSummaryError">{row.error}</p>}
                    </li>
                  ))}
                </ul>
              )}
          </DetailSection>
          {record.overrides.length === 0 ? null : (
            <DetailSection title={`覆盖的内置行（${String(record.overrides.length)}）`}>
              <ul className="em-fileList">
                {record.overrides.map(entry => <li key={entry} className="em-mono">{entry}</li>)}
              </ul>
            </DetailSection>
          )}
        </>
      ) : null}

      {isPluginRow(record) ? (
        <DetailSection title="插件行">
          <FactsList>
            <Fact label="entryId"><span className="em-mono">{record.row.entryId}</span></Fact>
            <Fact label="模块"><span className="em-mono">{record.row.moduleName}</span></Fact>
            {optionalFact('行说明', record.row.description)}
            <Fact label="覆盖内置行">{record.row.overrides === true ? '是' : '否'}</Fact>
            {optionalFact('只读原因', record.row.readOnlyReason)}
            {optionalFact('行错误', record.row.error === undefined ? undefined : <span className="em-errorText">{record.row.error}</span>)}
          </FactsList>
        </DetailSection>
      ) : null}

      {isSkill(record) ? (
        <>
          <DetailSection title="技能">
            <FactsList>
              <Fact label="rootKey"><span className="em-mono">{record.rootKey}</span></Fact>
              {isSkillCopy(record) && record.rootRank !== undefined
                ? <Fact label="根优先级">rank {String(record.rootRank)}</Fact>
                : null}
              <Fact label="物理形态">{LAYOUT_LABELS[record.layout]}</Fact>
              {optionalFact('Provider', record.provider)}
              <Fact label="运行时生效">{signals.effective ? '是' : '否'}</Fact>
              {isSkillCopy(record) && record.shadowedBy !== undefined ? <PathFact label="被此副本覆盖" path={record.shadowedBy} /> : null}
              {isSkillCopy(record) && record.overriddenCopies !== undefined && record.overriddenCopies.length > 0
                ? optionalFact('覆盖的副本', (
                  <ul className="em-fileList">
                    {record.overriddenCopies.map(copy => (
                      <li key={`${copy.rootKey}:${copy.path}`} className="em-mono">{copy.rootKey} · {copy.path}</li>
                    ))}
                  </ul>
                ))
                : null}
              {optionalFact('调用策略', invocation)}
              {optionalFact('技能简介', recordDescription(record))}
            </FactsList>
          </DetailSection>
          <DetailSection title="更新来源">
            <FactsList>
              <Fact label="来源类型">{SOURCE_KIND_LABELS[source.kind]}</Fact>
              <Fact label="可信度">{TRUST_LABELS[source.trust]}</Fact>
              {optionalFact('来源标签', source.label)}
              {textFact('仓库', source.repo, true)}
              {textFact('分支 / 标签', source.ref, true)}
              {textFact('已安装提交', source.commit, true)}
              {textFact('子目录', source.subdir, true)}
              {url === undefined ? null : (
                <div className="em-fact">
                  <dt>URL</dt>
                  <dd>
                    <span className="em-pathRow">
                      <a className="em-link" href={url} target="_blank" rel="noreferrer noopener">{url}</a>
                      <CopyButton text={url} label="复制来源 URL" />
                    </span>
                  </dd>
                </div>
              )}
            </FactsList>
          </DetailSection>
        </>
      ) : null}

      <DetailSection title={`诊断（${String(record.diagnostics.length)}）`}>
        {record.diagnostics.length === 0
          ? <p className="em-detailMuted">没有诊断信息。</p>
          : (
            <ul className="em-diagnosticList">
              {record.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic.code}:${String(index)}`} className="em-diagnosticItem" data-level={diagnostic.level}>
                  <div className="em-diagnosticTop">
                    <ToneTag tone={DIAGNOSTIC_TONES[diagnostic.level]}>{diagnostic.level === 'error' ? '错误' : diagnostic.level === 'warning' ? '警告' : '信息'}</ToneTag>
                    <span className="em-mono em-diagnosticCode">{diagnostic.code}</span>
                  </div>
                  <p className="em-diagnosticMessage">{diagnostic.message}</p>
                  {diagnostic.detail === undefined ? null : (
                    <pre className="em-diagnosticDetail">{JSON.stringify(diagnostic.detail, null, 2)}</pre>
                  )}
                </li>
              ))}
            </ul>
          )}
      </DetailSection>
    </>
  )
}

/** Render the details dialog (headless modal for a fixed header + scrolling body). */
export function DetailsDialog({
  record, busy, checking, preview, onClose, onCheck, onUpdate, onOpenDiagnostics, loadHistory,
}: DetailsDialogProps): ReactNode {
  const [historyState, setHistoryState] = useState<HistoryState>({ status: 'loading' })
  const [historyNonce, setHistoryNonce] = useState(0)
  const recordId = record?.id

  useEffect(() => {
    if (recordId === undefined) return
    let cancelled = false
    setHistoryState({ status: 'loading' })
    void loadHistory().then(
      (entries) => { if (!cancelled) setHistoryState({ status: 'ready', entries }) },
      (caught: unknown) => {
        if (!cancelled) {
          setHistoryState({ status: 'error', message: caught instanceof Error && caught.message !== '' ? caught.message : '读取更新历史失败' })
        }
      },
    )
    return () => { cancelled = true }
  }, [recordId, historyNonce, loadHistory])

  if (record === null) return null

  const signals = deriveSignals(record)
  const status = statusViewOf(record)
  const url = httpsUrl(record.source.url)
  const name = recordName(record)
  const technical = recordTechnicalName(record)
  const updateReason = updateBlockedReason(record)
  const checkReason = checkBlockedReason(record)
  const showUpdate = record.version.status === 'update-available' || record.version.status === 'incompatible-update'

  const openUrl = (target: string): void => {
    window.open(target, '_blank', 'noopener,noreferrer')
  }

  return (
    <Modal
      open
      headless
      title={`${name} 详情`}
      onClose={onClose}
      className="em-modalWide"
    >
      <div className="em-detailDialog">
        <header className="em-detailHead">
          <span className="em-detailIcon" aria-hidden="true">
            {record.kind === 'skill' ? <IconSkillOutlineRegular size={18} /> : <IconCordisPluginOutlineRegular size={18} />}
          </span>
          <div className="em-detailHeadText">
            <div className="em-detailTitleRow">
              <h2 className="em-detailTitle">{name}</h2>
              <StatusTag view={status} />
              {isSkillCopy(record) && record.effective === false ? <Tag tone="warning">已覆盖</Tag> : null}
              {preview ? <Tag tone="warning">预览数据</Tag> : null}
            </div>
            <p className="em-detailSubtitle em-mono">
              {technical}
              {recordVersionText(record) === undefined ? '' : ` · ${recordVersionText(record) ?? ''}`}
              {' · '}
              {SOURCE_KIND_LABELS[record.source.kind]}
            </p>
          </div>
          <button type="button" className="em-iconBtn" aria-label="关闭详情" title="关闭" onClick={onClose}>
            <span aria-hidden="true" className="em-closeGlyph">✕</span>
          </button>
        </header>
        <div className="em-detailBody">
          <RecordSections record={record} />
          <DetailSection title="更新历史">
            <HistoryBlock record={record} state={historyState} onRetry={() => { setHistoryNonce(value => value + 1) }} />
          </DetailSection>
        </div>
        <footer className="em-detailFooter">
          <span className="em-detailFooterSpacer" />
          <Button variant="ghost" size="sm" icon={<IconInspectOutlineRegular size={13} />} onClick={onOpenDiagnostics}>
            诊断
          </Button>
          {url === undefined ? null : (
            <Button variant="outline" size="sm" icon={<IconRightUpOutlineRegular size={13} />} onClick={() => { openUrl(url) }}>
              打开 GitHub
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            icon={<IconRefreshOutlineRegular size={13} />}
            disabled={!record.actions.canCheck || busy}
            title={checkReason ?? '检查这一项的远程版本'}
            onClick={() => { onCheck(record) }}
          >
            {checking ? '检查中…' : '检查更新'}
          </Button>
          {showUpdate ? (
            <Button
              variant="primary"
              size="sm"
              icon={<IconDownloadOutlineRegular size={13} />}
              disabled={!signals.updatable || busy}
              title={updateReason ?? '安装可用更新'}
              onClick={() => { onUpdate(record) }}
            >
              更新
            </Button>
          ) : null}
        </footer>
      </div>
    </Modal>
  )
}
