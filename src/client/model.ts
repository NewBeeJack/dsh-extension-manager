/**
 * Pure view model of the Extension Manager page: enum labels, status tones,
 * search/filter/sort/grouping rules and the statistics cells.
 *
 * Nothing here touches React or the network so the page and its dialogs stay
 * declarative and the rules are easy to audit against the shared contract.
 */
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AnySkillRecord,
  Diagnostic,
  HistoryEntry,
  ManagementScope,
  PluginBundleRecord,
  PluginInventoryPayload,
  PluginRecord,
  PluginRowRecord,
  PluginStats,
  SkillRecord,
  SkillStats,
  SkillsInventoryPayload,
  SourceKind,
  SourceTrust,
  UpdatePlanEntry,
  UpdateStatus,
  VirtualSkillRecord,
} from '../shared/types'

/** The two top-level pages. */
export type ViewScope = 'plugins' | 'skills'

/** Everything the list can show. */
export type ExtensionRecord = PluginRecord | AnySkillRecord

/* ------------------------------------------------------------------ *
 * Type guards
 * ------------------------------------------------------------------ */

export function isBundle(record: ExtensionRecord): record is PluginBundleRecord {
  return record.kind === 'plugin-bundle'
}

export function isPluginRow(record: ExtensionRecord): record is PluginRowRecord {
  return record.kind === 'plugin-row'
}

export function isSkillCopy(record: ExtensionRecord): record is SkillRecord {
  return record.kind === 'skill' && record.layout !== 'virtual'
}

export function isVirtualSkill(record: ExtensionRecord): record is VirtualSkillRecord {
  return record.kind === 'skill' && record.layout === 'virtual'
}

export function isSkill(record: ExtensionRecord): record is AnySkillRecord {
  return record.kind === 'skill'
}

/** The flattened list for one page. */
export function recordsOf(payload: PluginInventoryPayload | SkillsInventoryPayload): ExtensionRecord[] {
  if ('bundles' in payload) return [...payload.bundles, ...payload.rows]
  return [...payload.physical, ...payload.virtual]
}

/* ------------------------------------------------------------------ *
 * Enum labels
 * ------------------------------------------------------------------ */

export const KIND_LABELS: Record<ExtensionRecord['kind'], string> = {
  'plugin-bundle': '插件包',
  'plugin-row': '插件行',
  skill: '技能',
}

export const SCOPE_LABELS: Record<ManagementScope, string> = {
  'current-profile': '当前 Profile',
  'other-profile': '其他 Profile',
  installation: 'DSH 安装目录',
  filesystem: '文件系统',
}

export const AVAILABILITY_LABELS: Record<PluginBundleRecord['availability'], string> = {
  installation: '随 DSH 安装提供',
  profile: 'Profile 中安装',
  missing: '找不到安装目录',
}

export const SOURCE_KIND_LABELS: Record<SourceKind, string> = {
  npm: 'npm 安装',
  github: 'GitHub',
  git: 'Git 仓库',
  'local-link': '本地链接',
  'local-path': '本地路径',
  tarball: '离线包',
  official: '官方内置',
  bundled: '随 DSH 打包',
  'skill-git': 'Git 技能来源',
  'skill-lock': '技能锁文件',
  filesystem: '文件系统',
  'profile-patch': 'Profile 本地补丁',
  unknown: '来源未知',
}

export const TRUST_LABELS: Record<SourceTrust, string> = {
  verified: '已验证',
  'needs-confirmation': '需要确认',
  unknown: '未知',
  'local-custom': '本地自定义',
  official: '官方',
  'no-remote-update': '无远程更新',
  'read-only-other-profile': '其他 Profile（只读）',
}

export const FIBER_LABELS: Record<NonNullable<PluginRowRecord['runtime']['fiberPhase']>, string> = {
  pending: '等待加载',
  loading: '加载中',
  active: '运行中',
  failed: '加载失败',
  unloading: '卸载中',
}

export const LAYOUT_LABELS: Record<AnySkillRecord['layout'], string> = {
  directory: '目录',
  'flat-file': '单文件',
  virtual: '运行时（无物理目录）',
}

export const HISTORY_OUTCOME_VIEWS: Record<HistoryEntry['outcome'], { label: string; tone: TagTone }> = {
  success: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  'rolled-back': { label: '已回滚', tone: 'warning' },
  'recovery-required': { label: '需要恢复', tone: 'danger' },
  blocked: { label: '被阻止', tone: 'neutral' },
}

export const HISTORY_ACTION_LABELS: Record<HistoryEntry['action'], string> = {
  update: '更新',
  'batch-update': '批量更新',
  'skill-update': '技能更新',
  'source-associate': '关联来源',
  'self-update': '自更新',
}

/* ------------------------------------------------------------------ *
 * Status tags
 * ------------------------------------------------------------------ */

/** One localized tag: text, palette and the dot semantic behind it. */
export interface StatusView {
  label: string
  tone: TagTone
  dot: StateDotState
}

const UPDATE_STATUS_VIEWS: Record<UpdateStatus, StatusView> = {
  unchecked: { label: '未检查', tone: 'outline', dot: 'idle' },
  checking: { label: '检查中', tone: 'info', dot: 'ongoing' },
  'up-to-date': { label: '已是最新', tone: 'success', dot: 'done' },
  'update-available': { label: '可更新', tone: 'info', dot: 'warning' },
  'incompatible-update': { label: '更新不兼容', tone: 'warning', dot: 'warning' },
  'prerelease-only': { label: '仅有预发布版', tone: 'neutral', dot: 'idle' },
  'needs-source': { label: '需要来源', tone: 'warning', dot: 'warning' },
  'local-modified': { label: '本地已修改', tone: 'warning', dot: 'warning' },
  'no-source': { label: '无远程来源', tone: 'neutral', dot: 'idle' },
  'network-error': { label: '网络错误', tone: 'danger', dot: 'error' },
  'check-failed': { label: '检查失败', tone: 'danger', dot: 'error' },
  downloading: { label: '下载中', tone: 'info', dot: 'ongoing' },
  installing: { label: '安装中', tone: 'info', dot: 'ongoing' },
  validating: { label: '校验中', tone: 'info', dot: 'ongoing' },
  'pending-restart': { label: '等待重启', tone: 'warning', dot: 'warning' },
  updated: { label: '已更新', tone: 'success', dot: 'done' },
  'update-failed': { label: '更新失败', tone: 'danger', dot: 'error' },
  'recovery-required': { label: '需要恢复', tone: 'danger', dot: 'error' },
}

/** Status tag for one record; a load failure outranks the update status. */
export function statusViewOf(record: ExtensionRecord, checking = false): StatusView {
  if (checking) return UPDATE_STATUS_VIEWS.checking
  if (record.runtime.error !== undefined && record.runtime.error !== '') {
    return { label: '加载失败', tone: 'danger', dot: 'error' }
  }
  if (!record.runtime.installed && !isVirtualSkill(record)) {
    return { label: '未安装', tone: 'danger', dot: 'error' }
  }
  const base = UPDATE_STATUS_VIEWS[record.version.status]
  if (record.version.status === 'update-available' && record.version.available !== undefined) {
    return { label: `可更新 ${record.version.available}`, tone: base.tone, dot: base.dot }
  }
  return base
}

/* ------------------------------------------------------------------ *
 * Derived signals
 * ------------------------------------------------------------------ */

const ABNORMAL_STATUSES: ReadonlySet<UpdateStatus> = new Set<UpdateStatus>([
  'network-error',
  'check-failed',
  'update-failed',
  'recovery-required',
])

/** Filter-relevant facts derived once per record. */
export interface RecordSignals {
  /** The physical package/skill exists. */
  installed: boolean
  enabled: boolean
  loaded: boolean
  failed: boolean
  /** A compatible update is available. */
  updatable: boolean
  /** Something needs attention (failure, missing install, error diagnostic). */
  abnormal: boolean
  /** Physical skill copy that wins its name (always true for virtual skills). */
  effective: boolean
  /** Physical copy shadowed by a higher-rank copy of the same name. */
  shadowed: boolean
  /** Skill root not consumed by the running DSH (e.g. Codex compatibility). */
  unmanaged: boolean
}

/** Whether any record is in a state that needs the user's attention. */
export function hasErrorDiagnostic(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some(diagnostic => diagnostic.level === 'error')
}

export function deriveSignals(record: ExtensionRecord, unmanagedRoots: ReadonlySet<string> = new Set()): RecordSignals {
  const failed = record.runtime.fiberPhase === 'failed'
    || (record.runtime.error !== undefined && record.runtime.error !== '')
    || (isPluginRow(record) && record.row.fiberPhase === 'failed')
  const installed = record.runtime.installed
  const enabled = record.runtime.enabled === true
  const loaded = record.runtime.loaded === true
  const updatable = record.version.status === 'update-available'
    && record.version.compatibility !== 'incompatible'
    && record.actions.canUpdate
  const abnormal = failed
    || !installed
    || ABNORMAL_STATUSES.has(record.version.status)
    || hasErrorDiagnostic(record.diagnostics)
  const effective = isSkill(record) ? record.effective : true
  const shadowed = isSkillCopy(record) && record.effective === false
  const unmanaged = isSkill(record) && unmanagedRoots.has(record.rootKey)
  return { installed, enabled, loaded, failed, updatable, abnormal, effective, shadowed, unmanaged }
}

/** Whether a record may join a "safe only" batch update without a dialog risk. */
export function isSafeUpdate(record: ExtensionRecord): boolean {
  return deriveSignals(record).updatable && record.actions.requiresConfirmation !== true
}

/* ------------------------------------------------------------------ *
 * Rows: identity, paths, descriptions
 * ------------------------------------------------------------------ */

export function recordName(record: ExtensionRecord): string {
  return record.displayName !== '' ? record.displayName : record.name
}

/** Technical identity: package name, module name or skill name. */
export function recordTechnicalName(record: ExtensionRecord): string {
  if (isBundle(record)) return record.name
  if (isPluginRow(record)) return record.row.moduleName
  return record.name
}

export function recordVersionText(record: ExtensionRecord): string | undefined {
  const current = record.version.current
  if (current !== undefined && current !== '') return current.startsWith('v') ? current : `v${current}`
  const tree = record.version.currentTree
  if (tree !== undefined && tree !== '') return tree.slice(0, 8)
  return undefined
}

export function recordDescription(record: ExtensionRecord): string {
  const description = record.description.trim()
  if (description !== '') return description
  if (isBundle(record) && record.packageDescription !== undefined) return record.packageDescription
  if (isPluginRow(record)) return record.row.description ?? ''
  return ''
}

/** The most useful single path for the list row. */
export function recordPathText(record: ExtensionRecord): string {
  const paths = record.paths
  return paths.installDir ?? paths.resolvedPath ?? paths.manifestPath ?? paths.rootDir ?? ''
}

export function recordSourceLabel(record: ExtensionRecord): string {
  return record.source.label !== '' ? record.source.label : SOURCE_KIND_LABELS[record.source.kind]
}

export function recordCheckedAt(record: ExtensionRecord): string | undefined {
  return record.version.lastCheckedAt
}

export function recordHasPendingRestart(record: ExtensionRecord): boolean {
  return record.version.status === 'pending-restart' || record.runtime.restartRequired === true
}

/** Records that finished updating and need a Host restart to take effect. */
export function pendingRestartCount(records: readonly ExtensionRecord[]): number {
  return records.filter(recordHasPendingRestart).length
}

/* ------------------------------------------------------------------ *
 * Action availability and why-not copy
 * ------------------------------------------------------------------ */

/** Why the "check update" button is unavailable, or undefined when it works. */
export function checkBlockedReason(record: ExtensionRecord): string | undefined {
  if (record.actions.canCheck) return undefined
  if (record.version.reason !== undefined && record.version.reason !== '') return record.version.reason
  if (record.source.trust === 'no-remote-update') return '这项扩展没有可信的远程来源，无法检查更新'
  return '没有可核对的远程来源，无法检查更新'
}

/** Why the "update" button is unavailable, or undefined when it works. */
export function updateBlockedReason(record: ExtensionRecord): string | undefined {
  if (record.actions.canUpdate && record.version.status === 'update-available') {
    return record.actions.requiresConfirmation === true ? '更新前需要确认风险' : undefined
  }
  if (record.actions.updateBlockedReason !== undefined && record.actions.updateBlockedReason !== '') {
    return record.actions.updateBlockedReason
  }
  if (record.version.status === 'incompatible-update') {
    return record.version.reason ?? '新版本与当前 DSH 运行时不兼容'
  }
  if (record.version.status === 'update-available') return '这项更新不能由扩展管理器执行'
  return '当前没有可安装的更新'
}

// `UpdatePlanEntry` is referenced by the update dialog through this helper type.
export type { UpdatePlanEntry }

/* ------------------------------------------------------------------ *
 * Search / filter / sort / grouping
 * ------------------------------------------------------------------ */

export type StatusFilter =
  | 'all'
  | 'enabled'
  | 'disabled'
  | 'loaded'
  | 'failed'
  | 'updatable'
  | 'abnormal'
  | 'effective'
  | 'shadowed'
  | 'unmanaged'

export type SortKey = 'name' | 'updates' | 'checked'

/** All strings are menu option ids; `all` means "no restriction". */
export interface RecordFilters {
  query: string
  /** Source group key, or `all`. */
  source: string
  status: StatusFilter
  /** Scope/root option id, or `all`. */
  range: string
  sort: SortKey
}

export function defaultFilters(): RecordFilters {
  return { query: '', source: 'all', status: 'all', range: 'all', sort: 'name' }
}

/** Searchable text of one record (lowercased lazily by callers). */
export function searchText(record: ExtensionRecord): string {
  const parts: string[] = [
    record.name,
    record.displayName,
    recordDescription(record),
    record.source.label,
    record.source.packageName ?? '',
    record.source.repo ?? '',
    record.paths.installDir ?? '',
    record.paths.manifestPath ?? '',
    record.paths.resolvedPath ?? '',
    record.paths.rootDir ?? '',
  ]
  if (isSkill(record)) parts.push(record.rootKey, record.provider ?? '')
  return parts.filter(part => part !== '').join('\n').toLocaleLowerCase()
}

/** Per-scope status menu entries. */
export const STATUS_OPTIONS: Record<ViewScope, ReadonlyArray<{ value: StatusFilter; label: string }>> = {
  plugins: [
    { value: 'all', label: '全部状态' },
    { value: 'enabled', label: '已启用' },
    { value: 'disabled', label: '未启用' },
    { value: 'loaded', label: '运行中' },
    { value: 'failed', label: '加载失败' },
    { value: 'updatable', label: '可更新' },
    { value: 'abnormal', label: '异常' },
  ],
  skills: [
    { value: 'all', label: '全部状态' },
    { value: 'effective', label: '运行时生效' },
    { value: 'shadowed', label: '已覆盖' },
    { value: 'unmanaged', label: '未托管' },
    { value: 'updatable', label: '可更新' },
    { value: 'abnormal', label: '异常' },
  ],
}

export const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'name', label: '名称' },
  { value: 'updates', label: '更新优先' },
  { value: 'checked', label: '最近检查' },
]

/** One range-menu option (profile scope or skill root). */
export interface RangeOption {
  value: string
  label: string
  hint?: string
}

/** Scope filters offered for the Plugins page. */
export const PLUGIN_RANGE_OPTIONS: ReadonlyArray<RangeOption> = [
  { value: 'all', label: '全部范围' },
  { value: 'current-profile', label: '当前 Profile' },
  { value: 'other-profile', label: '其他 Profile' },
  { value: 'installation', label: 'DSH 安装' },
  { value: 'runtime-rows', label: '运行时插件行' },
]

/** Range filters for the Skills page: one per discovery root plus not-managed. */
export function skillRangeOptions(payload: SkillsInventoryPayload | undefined): RangeOption[] {
  const options: RangeOption[] = [{ value: 'all', label: '全部根目录' }]
  if (payload !== undefined) {
    for (const root of payload.roots) {
      options.push({
        value: `root:${root.key}`,
        label: root.label,
        ...(root.managed ? {} : { hint: '未托管' }),
      })
    }
    options.push({ value: 'unmanaged', label: '仅未托管根' })
  }
  return options
}

/** Root keys whose skills the running DSH does not serve. */
export function unmanagedRootKeys(payload: SkillsInventoryPayload | undefined): ReadonlySet<string> {
  const keys = new Set<string>()
  if (payload === undefined) return keys
  for (const root of payload.roots) {
    if (!root.managed) keys.add(root.key)
  }
  return keys
}

/** Whether one record passes the current search/filter combination. */
export function matchesFilters(
  record: ExtensionRecord,
  filters: RecordFilters,
  scope: ViewScope,
  unmanagedRoots: ReadonlySet<string>,
): boolean {
  const query = filters.query.trim().toLocaleLowerCase()
  if (query !== '' && !searchText(record).includes(query)) return false

  if (filters.source !== 'all' && classifySource(record).key !== filters.source) return false

  if (filters.range !== 'all') {
    if (scope === 'plugins') {
      if (filters.range === 'runtime-rows' && !isPluginRow(record)) return false
      if (filters.range !== 'runtime-rows' && (isPluginRow(record) || record.scope !== filters.range)) return false
    } else {
      if (!isSkill(record)) return false
      if (filters.range === 'unmanaged') {
        if (!unmanagedRoots.has(record.rootKey)) return false
      } else if (filters.range.startsWith('root:')) {
        if (record.rootKey !== filters.range.slice('root:'.length)) return false
      }
    }
  }

  if (filters.status === 'all') return true
  const signals = deriveSignals(record, unmanagedRoots)
  switch (filters.status) {
    case 'enabled': return signals.enabled
    case 'disabled': return !signals.enabled
    case 'loaded': return signals.loaded
    case 'failed': return signals.failed
    case 'updatable': return signals.updatable
    case 'abnormal': return signals.abnormal
    case 'effective': return signals.effective
    case 'shadowed': return signals.shadowed
    case 'unmanaged': return signals.unmanaged
    /* c8 ignore next -- exhaustive over StatusFilter. */
    default: return true
  }
}

export function filterRecords(
  records: readonly ExtensionRecord[],
  filters: RecordFilters,
  scope: ViewScope,
  unmanagedRoots: ReadonlySet<string>,
): ExtensionRecord[] {
  return records.filter(record => matchesFilters(record, filters, scope, unmanagedRoots))
}

const SOURCE_GROUPS: Partial<Record<SourceKind, { key: string; label: string; order: number }>> = {
  npm: { key: 'npm', label: 'npm 安装', order: 10 },
  github: { key: 'git', label: 'Git / GitHub 安装', order: 20 },
  git: { key: 'git', label: 'Git / GitHub 安装', order: 20 },
  'skill-git': { key: 'git', label: 'Git / GitHub 安装', order: 20 },
  'local-link': { key: 'local-link', label: '本地链接（link）', order: 30 },
  'local-path': { key: 'local-path', label: '本地路径', order: 40 },
  'profile-patch': { key: 'profile-patch', label: 'Profile 本地补丁', order: 45 },
  tarball: { key: 'tarball', label: '离线安装包', order: 50 },
  'skill-lock': { key: 'skill-lock', label: '技能锁文件', order: 60 },
  filesystem: { key: 'filesystem', label: '文件系统扫描', order: 70 },
  official: { key: 'builtin', label: 'DSH 内置', order: 80 },
  bundled: { key: 'builtin', label: 'DSH 内置', order: 80 },
}

/** Which collapsible source group one record belongs to. */
export function classifySource(record: ExtensionRecord): { key: string; label: string; order: number } {
  return SOURCE_GROUPS[record.source.kind] ?? { key: 'unknown', label: '来源未知', order: 900 }
}

/** Source groups present in a record set, ignoring active filters. */
export function sourceGroupOptions(records: readonly ExtensionRecord[]): Array<{ value: string; label: string }> {
  const seen = new Map<string, { label: string; order: number }>()
  for (const record of records) {
    const group = classifySource(record)
    if (!seen.has(group.key)) seen.set(group.key, { label: group.label, order: group.order })
  }
  return [...seen.entries()]
    .sort((a, b) => a[1].order - b[1].order)
    .map(([value, info]) => ({ value, label: info.label }))
}

function updateRank(record: ExtensionRecord): number {
  const status = record.version.status
  if (status === 'update-available') return 0
  if (status === 'pending-restart') return 1
  if (ABNORMAL_STATUSES.has(status)) return 2
  return 3
}

/** Sort one group's records (the user's chosen order). */
export function sortRecords(records: readonly ExtensionRecord[], sort: SortKey): ExtensionRecord[] {
  const name = (record: ExtensionRecord): string => recordName(record).toLocaleLowerCase()
  const compareName = (a: ExtensionRecord, b: ExtensionRecord): number => name(a).localeCompare(name(b), 'zh-Hans-CN')
  const sorted = [...records]
  switch (sort) {
    case 'updates':
      sorted.sort((a, b) => updateRank(a) - updateRank(b) || compareName(a, b))
      break
    case 'checked':
      sorted.sort((a, b) => {
        const left = recordCheckedAt(a) ?? ''
        const right = recordCheckedAt(b) ?? ''
        if (left === right) return compareName(a, b)
        return right.localeCompare(left)
      })
      break
    case 'name':
    default:
      sorted.sort(compareName)
      break
  }
  return sorted
}

/** One collapsible list group. */
export interface RecordGroup {
  key: string
  label: string
  order: number
  records: ExtensionRecord[]
  updatable: number
}

/** Filter, sort and group the records of one page. */
export function buildGroups(
  records: readonly ExtensionRecord[],
  filters: RecordFilters,
  scope: ViewScope,
  unmanagedRoots: ReadonlySet<string>,
): RecordGroup[] {
  const visible = filterRecords(records, filters, scope, unmanagedRoots)
  const groups = new Map<string, RecordGroup>()
  for (const record of visible) {
    const info = classifySource(record)
    const existing = groups.get(info.key)
    if (existing === undefined) {
      groups.set(info.key, { key: info.key, label: info.label, order: info.order, records: [record], updatable: 0 })
    } else {
      existing.records.push(record)
    }
  }
  const result = [...groups.values()]
  for (const group of result) {
    group.records = sortRecords(group.records, filters.sort)
    group.updatable = group.records.filter(record => deriveSignals(record, unmanagedRoots).updatable).length
  }
  result.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label, 'zh-Hans-CN'))
  return result
}

/* ------------------------------------------------------------------ *
 * Statistics cells
 * ------------------------------------------------------------------ */

/** One statistics cell; `filter` makes clicking it apply a status filter. */
export interface StatCell {
  key: string
  label: string
  value: number
  /** Optional composite display (`194/224`); `value` stays the sortable number. */
  valueText?: string
  hint: string
  filter?: StatusFilter
}

/** Five accounting cells for the Plugins page. */
export function pluginStatCells(stats: PluginStats): StatCell[] {
  return [
    {
      key: 'installed',
      label: '已安装',
      value: stats.bundlesInstalled,
      hint: `当前 Profile 中声明的插件包（含未启用）。其他 Profile ${String(stats.bundlesOtherProfiles)} 个；DSH 内置组件由 DSH 自带的 Built-in plugins 页面管理。`,
    },
    {
      key: 'enabled',
      label: '已启用',
      value: stats.bundlesEnabled,
      hint: '配置中已选中、随 DSH 加载的插件包',
      filter: 'enabled',
    },
    {
      key: 'loaded',
      label: '运行中',
      value: stats.rowsLoaded,
      valueText: `${String(stats.rowsLoaded)}/${String(stats.rowsTotal)}`,
      hint: `运行时共 ${String(stats.rowsTotal)} 个插件行，${String(stats.rowsLoaded)} 个已加载；${String(stats.rowsFailed)} 个加载失败。`,
      filter: 'loaded',
    },
    {
      key: 'updates',
      label: '可更新',
      value: stats.updatesAvailable,
      hint: '存在可用且与当前 DSH 兼容的更新（需先检查）',
      filter: 'updatable',
    },
    {
      key: 'abnormal',
      label: '异常',
      value: stats.abnormal,
      hint: '加载失败、缺失安装、检查失败或带有错误诊断的记录',
      filter: 'abnormal',
    },
  ]
}

/** Five accounting cells for the Skills page. */
export function skillStatCells(stats: SkillStats): StatCell[] {
  return [
    {
      key: 'physical',
      label: '物理副本',
      value: stats.physical,
      hint: `扫描到的技能目录/文件总数；其中 ${String(stats.notManaged)} 份位于未被 DSH 使用的根目录。`,
    },
    {
      key: 'runtime',
      label: '运行时生效',
      value: stats.runtime,
      hint: `运行时技能目录中可见的技能数；物理副本中 ${String(stats.effective)} 份生效。`,
      filter: 'effective',
    },
    {
      key: 'shadowed',
      label: '已覆盖',
      value: stats.shadowed,
      hint: '被同名、更高优先级副本覆盖而未生效的物理副本',
      filter: 'shadowed',
    },
    {
      key: 'updates',
      label: '可更新',
      value: stats.updatesAvailable,
      hint: '存在可用且兼容的远程更新（需先检查）',
      filter: 'updatable',
    },
    {
      key: 'abnormal',
      label: '异常',
      value: stats.abnormal,
      hint: '解析失败、检查失败或带有错误诊断的技能',
      filter: 'abnormal',
    },
  ]
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

function parseTimestamp(iso: string | undefined): number | undefined {
  if (iso === undefined || iso === '') return undefined
  const value = Date.parse(iso)
  return Number.isNaN(value) ? undefined : value
}

/** `HH:mm:ss` for "last scanned" lines. */
export function formatClock(iso: string | undefined): string | undefined {
  const value = parseTimestamp(iso)
  if (value === undefined) return undefined
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

/** `YYYY/MM/DD HH:mm` for detail rows. */
export function formatDateTime(iso: string | undefined): string | undefined {
  const value = parseTimestamp(iso)
  if (value === undefined) return undefined
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

/** "刚刚 / N 分钟前 / N 小时前 / 日期" for quiet metadata. */
export function formatRelative(iso: string | undefined): string | undefined {
  const value = parseTimestamp(iso)
  if (value === undefined) return undefined
  const deltaMs = Date.now() - value
  if (deltaMs < 0) return formatDateTime(iso)
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${String(minutes)} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${String(hours)} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${String(days)} 天前`
  return new Date(value).toLocaleDateString('zh-CN')
}

/** `N 秒` / `N 分钟` for scan durations. */
export function formatDuration(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  if (ms < 1000) return `${String(Math.max(0, Math.round(ms)))} 毫秒`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  return `${String(Math.round(seconds / 60))} 分钟`
}

/** Keep both ends of a long path visible: `head…tail`. */
export function middleEllipsis(text: string, max = 54): string {
  if (text.length <= max) return text
  const tail = Math.max(12, Math.floor(max * 0.55))
  const head = Math.max(6, max - tail - 1)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/**
 * Compact path for one list row: keep the drive/root and the trailing
 * segments, eliding only the middle. The caller keeps the full path in the
 * tooltip and the copy action.
 */
export function shortPath(path: string, max = 44): string {
  if (path === '') return ''
  const normalized = path.replace(/\//g, '\\').replace(/\\+$/, '')
  if (normalized.length <= max) return normalized

  const drive = /^[A-Za-z]:/.exec(normalized)?.[0]
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(normalized)?.[0]
  const prefix = drive ?? unc ?? ''
  const rest = normalized.slice(prefix.length).replace(/^\\+/, '')
  const parts = rest.split('\\').filter(part => part !== '')
  const head = prefix === '' ? '…\\' : `${prefix}\\…\\`
  const budget = max - head.length
  let tail = ''
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part === undefined) break
    const candidate = tail === '' ? part : `${part}\\${tail}`
    if (candidate.length > budget) break
    tail = candidate
  }
  return tail === '' ? middleEllipsis(normalized, max) : `${head}${tail}`
}

/** Invocation policy text for skills. */
export function invocationText(invocation: { model: boolean; user: boolean } | undefined): string | undefined {
  if (invocation === undefined) return undefined
  const parts: string[] = []
  if (invocation.model) parts.push('模型可调用')
  if (invocation.user) parts.push('用户可调用')
  return parts.length === 0 ? '不自动调用' : parts.join(' · ')
}

/** The latest visible change time of a history entry. */
export function historyVersionText(entry: HistoryEntry): string {
  const from = entry.fromVersion ?? '?'
  const to = entry.toVersion ?? '?'
  return `${from} → ${to}`
}
