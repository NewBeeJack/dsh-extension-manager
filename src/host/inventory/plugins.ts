/**
 * Plugin inventory: bundles (installation packages), their Loader rows, the
 * live runtime state, and every other readable profile under the DSH home.
 *
 * Authoritative reads:
 *   - `ctx.pluginManager.listBundles()`  — installed / installation-provided
 *     bundles, their recorded install spec, versions, rows and errors;
 *   - `ctx.pluginManager.listPlugins()`  — live Loader entries with fiber phase;
 *   - profile manifests (`$DSH_HOME/profiles/*​/package.json`) for multi-profile
 *     accounting;
 * JSON files are only read, never written, by this module.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { BundleInfo, PluginInfo } from '@deepseek-ai/dsh-plugin-manager'
import type {
  Diagnostic,
  PluginBundleRecord,
  PluginInventoryPayload,
  PluginRowRecord,
  PluginRowSummary,
  PluginStats,
  Reconciliation,
  SourceStatus,
} from '../../shared/types'
import type { PluginInventory } from '../contracts'
import type { ManagerState } from '../state'
import {
  classifyDependencySpec,
  profileFacts,
  readJsonFile,
  resolvePackageDirectory,
  runtimeVersion,
  SELF_PACKAGE_NAME,
  tidyPath,
  type ProfileFacts,
} from '../env'
import { localizedText, PLUGIN_DISPLAY } from './pluginMeta'

const CACHE_TTL_MS = 4000
const SELF_BUNDLE = SELF_PACKAGE_NAME

/** Package name of a module specifier (`@scope/pkg/sub` → `@scope/pkg`). */
export function packageNameOf(moduleName: string): string {
  if (moduleName.startsWith('@')) {
    const parts = moduleName.split('/')
    return parts.length >= 2 ? `${parts[0] ?? ''}/${parts[1] ?? ''}` : moduleName
  }
  return moduleName.split('/')[0] ?? moduleName
}

/** Translate a management error code into a Chinese diagnostic. */
export function managementErrorText(error: BundleInfo['error']): string {
  if (error === undefined) return ''
  const code = error.code
  const text = code === 'management-required' ? 'DSH 管理组件，受保护不可修改'
    : code === 'unaddressable' ? '配置中无法唯一定位该插件行'
      : code === 'not-bundle' ? '该包未声明组合包配置（dsh.bundle）'
        : code === 'invalid-spec' ? '安装规格无效'
          : code === 'already-installed' ? '该包已安装'
            : code === 'unknown-plugin' ? '未知插件'
                  : code === 'not-removable' ? '该包不可卸载'
                    : code === 'bundle-in-use' ? '该组合包仍在使用中'
                      : code === 'stop-profile' ? '需要停止 DSH 才能卸载'
                        : code === 'stale-approval' ? '构建批准已失效'
                          : code === 'incompatible-version' ? '与当前 DSH 版本不兼容'
                            : code === 'ambiguous-install' ? '安装结果无法唯一定位'
                              : '管理操作失败'
  return error.diagnostic === undefined ? text : `${text}（${error.diagnostic}）`
}

/** Read the row ids inserted by the profile's own patch file (regex; the file may carry `!!js` tags). */
function profilePatchIds(dir: string): Set<string> {
  const ids = new Set<string>()
  try {
    const file = join(dir, 'cordis.patch.yml')
    if (!existsSync(file)) return ids
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
      const match = /^\s*(?:-\s*)?id:\s*['"]?([\w.@/-]+)['"]?\s*$/u.exec(line)
      if (match?.[1] !== undefined) ids.add(match[1])
    }
  } catch {
    // An unreadable patch only weakens row attribution, never the inventory.
  }
  return ids
}

/** Read a profile manifest's dependency map and selected bundle list. */
function readProfileManifestData(dir: string): {
  dependencies: Record<string, string>
  bundles: string[]
} {
  const manifest = readJsonFile(join(dir, 'package.json'))
  const dependencies: Record<string, string> = {}
  const rawDeps = manifest?.dependencies
  if (typeof rawDeps === 'object' && rawDeps !== null && !Array.isArray(rawDeps)) {
    for (const [name, spec] of Object.entries(rawDeps as Record<string, unknown>)) {
      if (typeof spec === 'string') dependencies[name] = spec
    }
  }
  const dsh = manifest?.dsh as { profile?: { bundles?: unknown } } | undefined
  const selected = dsh?.profile?.bundles
  return {
    dependencies,
    bundles: Array.isArray(selected) ? selected.filter((item): item is string => typeof item === 'string') : [],
  }
}

/** Classify a `BundleInfo.source` spec into provenance. */
function sourceOfBundle(record: BundleInfo, facts: ProfileFacts): PluginBundleRecord['source'] {
  const name = record.name
  const raw = record.source
  if (raw !== undefined) {
    const prefix = `${name}@`
    const recorded = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
    return classifyDependencySpec(name, recorded, facts.dir, facts.name)
  }
  if (record.availability === 'installation') {
    return {
      kind: 'official',
      trust: 'official',
      label: record.official ? 'DSH 官方可选组件' : '随 DSH 安装',
      packageName: name,
      detail: '该组件随 DSH 安装提供，其版本随 DSH 发行版更新',
    }
  }
  if (record.availability === 'profile') {
    return {
      kind: 'unknown',
      trust: 'unknown',
      label: '安装来源不明确',
      packageName: name,
      detail: 'Profile 声明了这个依赖，但包管理器没有记录可用来源',
    }
  }
  return { kind: 'unknown', trust: 'unknown', label: '来源不明确', packageName: name }
}

/** Build one row summary from bundle row data and live runtime state. */
function rowSummary(
  row: BundleInfo['rows'][number],
  liveByEntry: Map<string, PluginInfo>,
  overrides: boolean,
  bundleEnabled: boolean,
): PluginRowSummary {
  const live = bundleEnabled && row.entryId !== undefined ? liveByEntry.get(row.entryId) : undefined
  const metaTitle = localizedText(live?.meta?.title)
  const metaDescription = localizedText(live?.meta?.description)
  const display = PLUGIN_DISPLAY[packageNameOf(row.moduleName)]
  return {
    entryId: row.entryId ?? `row:${row.rowId}`,
    rowId: row.rowId,
    moduleName: row.moduleName,
    ...(display?.title === undefined && metaTitle === '' ? {} : { displayName: display?.title ?? metaTitle }),
    ...(display?.description === undefined && metaDescription === '' ? {} : { description: display?.description ?? metaDescription }),
    enabled: live?.enabled ?? false,
    loaded: live?.fiberPhase === 'active',
    fiberPhase: live?.fiberPhase ?? null,
    ...(overrides ? { overrides: true } : {}),
    ...(live?.readOnlyReason === undefined ? {} : { readOnlyReason: live.readOnlyReason }),
    ...(live?.fiberPhase === 'failed' ? { error: '插件加载失败' } : {}),
  }
}

/** Read-only view of one profile directory's manifest. */
function readOtherProfiles(facts: ProfileFacts): PluginInventoryPayload['profiles'] {
  const root = join(facts.home, 'profiles')
  const profiles: PluginInventoryPayload['profiles'] = []
  let names: string[] = []
  try {
    names = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  } catch {
    return profiles
  }
  for (const name of names.sort()) {
    const dir = join(root, name)
    const current = tidyPath(dir) === tidyPath(facts.dir) || name === facts.name
    try {
      const data = readProfileManifestData(dir)
      profiles.push({ name, dir, readable: true, current, bundles: data.bundles.length })
    } catch (error) {
      profiles.push({
        name,
        dir,
        readable: false,
        current,
        bundles: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (!profiles.some(profile => profile.name === facts.name)) {
    profiles.push({ name: facts.name, dir: facts.dir, readable: true, current: true, bundles: 0 })
  }
  return profiles
}

/** Collect every dependency name declared by another readable profile. */
function otherProfileDependencies(facts: ProfileFacts): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const profile of readOtherProfiles(facts)) {
    if (profile.current || !profile.readable) continue
    const data = readProfileManifestData(profile.dir)
    for (const name of Object.keys(data.dependencies)) {
      const list = map.get(name) ?? []
      list.push(profile.name)
      map.set(name, list)
    }
  }
  return map
}

/** Add one Chinese diagnostic for a bundle-level error. */
function bundleDiagnostics(record: BundleInfo): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  if (record.error !== undefined) {
    diagnostics.push({
      level: record.error.code === 'incompatible-version' ? 'error' : 'warning',
      code: `bundle/${record.error.code}`,
      message: managementErrorText(record.error),
      ...(record.error.incompatible === undefined ? {} : {
        detail: { incompatible: record.error.incompatible },
      }),
    })
  }
  if (record.availability === 'missing') {
    diagnostics.push({ level: 'error', code: 'bundle/missing-files', message: '安装记录存在，但安装目录中的文件缺失' })
  }
  return diagnostics
}

/** The live implementation behind `ctx.pluginManager`. */
export class PluginInventoryImpl implements PluginInventory {
  private readonly ctx: Context
  private readonly state: ManagerState
  private cached: { at: number; payload: PluginInventoryPayload } | undefined

  constructor(ctx: Context, state: ManagerState) {
    this.ctx = ctx
    this.state = state
  }

  /** Forget the short-lived scan cache. */
  invalidate(): void {
    this.cached = undefined
  }

  /** Read the inventory, reusing a scan younger than the cache window. */
  async scan(options: { refresh?: boolean } = {}): Promise<PluginInventoryPayload> {
    const now = Date.now()
    if (options.refresh !== true && this.cached !== undefined && now - this.cached.at < CACHE_TTL_MS) {
      return this.cached.payload
    }
    const started = Date.now()
    const facts = profileFacts(this.ctx)
    if (facts === undefined) return this.emptyPayload(now)
    const sources: SourceStatus[] = []
    const counts: Record<string, number> = {}
    const notes: string[] = []
    const pluginManager = this.ctx.get('pluginManager')
    if (pluginManager === undefined) {
      notes.push('当前 Host 没有提供 pluginManager 服务，无法读取 Profile 插件清单。')
      return this.emptyPayload(now, facts, sources, counts, notes)
    }
    let bundles: BundleInfo[] = []
    let plugins: PluginInfo[] = []
    let bundlesError: string | undefined
    let pluginsError: string | undefined
    try {
      bundles = await pluginManager.listBundles()
      counts.listBundles = bundles.length
      sources.push({ id: 'plugin-manager/bundles', label: 'DSH 插件管理器 · Bundle 清单', contributes: 'bundles', count: bundles.length, complete: true })
    } catch (error) {
      bundlesError = error instanceof Error ? error.message : String(error)
      sources.push({ id: 'plugin-manager/bundles', label: 'DSH 插件管理器 · Bundle 清单', contributes: 'bundles', complete: false, error: bundlesError })
    }
    try {
      plugins = await pluginManager.listPlugins()
      counts.listPlugins = plugins.length
      sources.push({ id: 'plugin-manager/plugins', label: 'DSH 插件管理器 · 运行时插件行', contributes: 'rows', count: plugins.length, complete: true })
    } catch (error) {
      pluginsError = error instanceof Error ? error.message : String(error)
      sources.push({ id: 'plugin-manager/plugins', label: 'DSH 插件管理器 · 运行时插件行', contributes: 'rows', complete: false, error: pluginsError })
    }
    const liveByEntry = new Map(plugins.map(plugin => [plugin.entryId, plugin]))
    const profileData = readProfileManifestData(facts.dir)
    counts.profileDependencies = Object.keys(profileData.dependencies).length
    counts.profileBundles = profileData.bundles.length
    sources.push({
      id: 'profile/manifest',
      label: `Profile「${facts.name}」清单`,
      contributes: 'bundles',
      count: counts.profileDependencies,
      complete: true,
      location: join(facts.dir, 'package.json'),
    })
    const profiles = readOtherProfiles(facts)
    const otherDeps = otherProfileDependencies(facts)
    for (const profile of profiles) {
      if (profile.current) continue
      sources.push({
        id: `profile/${profile.name}`,
        label: `其他 Profile「${profile.name}」`,
        contributes: 'bundles',
        count: profile.bundles,
        complete: profile.readable,
        location: profile.dir,
        ...(profile.error === undefined ? {} : { error: profile.error }),
      })
    }
    const patchIds = profilePatchIds(facts.dir)
    const attributed = new Set<string>()
    const bundleRecords: PluginBundleRecord[] = []
    const cachedChecks = this.state.get().checks
    /**
     * DSH-shipped components (`availability === 'installation'`) are managed by
     * DSH's own Built-in plugins page. Keep discovering them — their Loader rows
     * stay claimed below so they cannot reappear as unattributed rows — but
     * exclude them from the Extension Manager's records, stats and update scope.
     */
    const excludedBuiltinBundles: string[] = []
    const excludedBuiltinEntryIds = new Set<string>()
    for (const bundle of bundles) {
      // Catalog-only entries are not installed: they are not part of the list.
      if (!bundle.installed && bundle.availability !== 'installation') continue
      if (bundle.availability === 'installation') {
        excludedBuiltinBundles.push(bundle.name)
        for (const row of bundle.rows) {
          if (row.entryId === undefined) continue
          excludedBuiltinEntryIds.add(row.entryId)
          attributed.add(row.entryId)
        }
        continue
      }
      const meta = PLUGIN_DISPLAY[bundle.name]
      const localizedTitle = localizedText(bundle.meta?.title)
      const localizedDescription = localizedText(bundle.meta?.description)
      const description = meta?.description ?? (localizedDescription !== '' ? localizedDescription : (bundle.description ?? ''))
      const displayName = meta?.title ?? (localizedTitle !== '' ? localizedTitle : bundle.name)
      const rows = bundle.rows.map(row => rowSummary(row, liveByEntry, false, bundle.enabled))
      for (const row of bundle.rows) if (row.entryId !== undefined) attributed.add(row.entryId)
      const loadedRows = bundle.enabled ? rows.filter(row => row.loaded) : []
      const failedRows = rows.filter(row => row.fiberPhase === 'failed')
      const diagnostics = bundleDiagnostics(bundle)
      // A malformed installation spec must never take the whole inventory down.
      let source: PluginBundleRecord['source']
      try {
        source = sourceOfBundle(bundle, facts)
      } catch (error) {
        source = {
          kind: 'unknown',
          trust: 'unknown',
          label: '安装来源解析失败',
          packageName: bundle.name,
          detail: error instanceof Error ? error.message : String(error),
        }
        diagnostics.push({ level: 'warning', code: 'provenance/parse-failed', message: '安装来源无法解析，已按未知来源展示' })
      }
      const installDir = resolvePackageDirectory(facts, bundle.name)
      const id = `plugin-bundle:${facts.name}:${bundle.name}`
      const cache = cachedChecks[`plugin:${id}`]
      const self = bundle.name === SELF_BUNDLE
      for (const row of failedRows) {
        diagnostics.push({ level: 'error', code: 'row/load-failed', message: `插件行 ${row.moduleName} 加载失败` })
      }
      const official = source.kind === 'official'
      const canCheck = !official && bundle.installed && (source.kind === 'npm' || source.kind === 'git') && !self
      const removable = bundle.removable && bundle.readOnlyReason === undefined
      const canUpdate = canCheck && removable && source.trust === 'verified' && bundle.availability === 'profile'
      const status = cache?.status ?? 'unchecked'
      const alsoInProfiles = otherDeps.get(bundle.name)
      const blockedReason: string | undefined = canUpdate
        ? undefined
        : self
          ? '管理器自身不支持在此页面更新'
          : bundle.readOnlyReason !== undefined
            ? '该 Bundle 受 DSH 保护，不能在此更新'
            : !removable && bundle.installed
              ? '该 Bundle 不可卸载，因此不支持原地更新'
              : source.kind === 'local-link' || source.kind === 'local-path'
                ? '本地安装（link/路径），更新由开发者负责'
                : source.kind === 'official'
                  ? '随 DSH 安装提供，随 DSH 版本更新'
                  : source.trust === 'unknown'
                    ? '安装来源不明确，不能自动覆盖'
                    : canCheck
                      ? '当前来源不支持自动更新'
                      : '没有可核对的远端更新来源'
      bundleRecords.push({
        id,
        kind: 'plugin-bundle',
        name: bundle.name,
        displayName,
        description,
        version: {
          ...(bundle.version === undefined ? {} : { current: bundle.version }),
          status,
          ...(cache?.availableVersion === undefined ? {} : { available: cache.availableVersion }),
          ...(cache?.availableCommit === undefined ? {} : { availableCommit: cache.availableCommit }),
          ...(cache?.channel === undefined ? {} : { channel: cache.channel }),
          ...(cache?.compatibility === undefined ? {} : { compatibility: cache.compatibility }),
          ...(cache?.compatibilityRequirements === undefined ? {} : { compatibilityRequirements: cache.compatibilityRequirements }),
          ...(cache?.checkedAt === undefined ? {} : { lastCheckedAt: cache.checkedAt }),
          ...(cache?.detail === undefined ? {} : { reason: cache.detail }),
        },
        source,
        runtime: {
          installed: installDir !== undefined || bundle.installed,
          enabled: bundle.enabled,
          loaded: loadedRows.length > 0,
          ...(bundle.enabled && rows.length > 0 && loadedRows.length === 0 && failedRows.length === 0
            ? { restartRequired: true }
            : {}),
          ...(failedRows.length > 0 ? { error: `${String(failedRows.length)} 个插件行加载失败` } : {}),
        },
        scope: 'current-profile',
        profile: facts.name,
        official: bundle.official || official,
        availability: bundle.availability,
        removable,
        ...(bundle.readOnlyReason === undefined ? {} : { readOnlyReason: bundle.readOnlyReason }),
        paths: {
          ...(installDir === undefined ? {} : { installDir, manifestPath: join(installDir, 'package.json') }),
          ...(source.kind === 'local-link' && source.spec !== undefined && source.spec.includes(':')
            ? { resolvedPath: source.spec.slice(source.spec.indexOf(':') + 1) }
            : {}),
        },
        rows,
        overrides: bundle.overrides,
        localModification: {
          state: 'unknown',
          detail: '尚未执行本地修改比较；更新前会重新核对',
        },
        ...(bundle.description === undefined ? {} : { packageDescription: bundle.description }),
        diagnostics,
        actions: {
          canCheck,
          canUpdate,
          ...(blockedReason === undefined ? {} : { updateBlockedReason: blockedReason }),
          canToggle: removable,
        },
        ...(self ? { self: true } : {}),
        ...(alsoInProfiles === undefined ? {} : { alsoInProfiles }),
      })
    }
    // Runtime rows no bundle declares: profile patch inserts and other direct entries.
    const rowRecords: PluginRowRecord[] = []
    for (const plugin of plugins) {
      if (attributed.has(plugin.entryId)) continue
      // The profile root Include is infrastructure, not a manageable plugin row.
      if (plugin.moduleName === 'cordis:include' || plugin.entryId === 'include') continue
      const display = PLUGIN_DISPLAY[packageNameOf(plugin.moduleName)]
      const title = display?.title ?? localizedText(plugin.meta?.title)
      const description = display?.description ?? localizedText(plugin.meta?.description)
      const inPatch = [...patchIds].some(id => plugin.entryId.includes(id))
      const id = `plugin-row:${facts.name}:${plugin.entryId}`
      rowRecords.push({
        id,
        kind: 'plugin-row',
        name: plugin.moduleName,
        displayName: title !== '' ? title : plugin.moduleName,
        description,
        version: { status: 'no-source', reason: '独立插件行没有独立的安装包版本' },
        source: {
          kind: inPatch ? 'profile-patch' : 'unknown',
          trust: inPatch ? 'local-custom' : 'unknown',
          label: inPatch ? 'Profile 补丁插入' : '运行时观察到的插件行',
          detail: inPatch ? '该行由 Profile 自己的 cordis.patch.yml 插入' : '无法追溯到任何已安装 Bundle',
        },
        runtime: {
          installed: true,
          enabled: plugin.enabled,
          loaded: plugin.fiberPhase === 'active',
          fiberPhase: plugin.fiberPhase,
          ...(plugin.readOnlyReason === undefined ? {} : { error: plugin.readOnlyReason }),
        },
        scope: 'current-profile',
        profile: facts.name,
        paths: {},
        row: { entryId: plugin.entryId, moduleName: plugin.moduleName, enabled: plugin.enabled, loaded: plugin.fiberPhase === 'active', fiberPhase: plugin.fiberPhase },
        localModification: { state: 'unknown' },
        diagnostics: plugin.fiberPhase === 'failed'
          ? [{ level: 'error', code: 'row/load-failed', message: '该插件行加载失败', detail: { entryId: plugin.entryId } }]
          : [],
        actions: { canCheck: false, canUpdate: false, updateBlockedReason: '独立插件行没有可核对的安装来源' },
      })
    }
    const otherProfileRecords = readOtherProfileBundles(profiles, facts)
    const seenNames = new Set(bundleRecords.map(record => record.name))
    for (const record of otherProfileRecords) {
      if (seenNames.has(record.name)) continue
      seenNames.add(record.name)
      // A bundle installed elsewhere may still be the same physical package the
      // current profile loads; expose that relation instead of a duplicate copy.
      bundleRecords.push(record)
    }
    // DSH-shipped rows are excluded from the managed row totals as well.
    const managedPlugins = plugins.filter(plugin => !excludedBuiltinEntryIds.has(plugin.entryId))
    const stats: PluginStats = {
      bundlesInstalled: bundleRecords.filter(record => record.availability === 'profile' && record.runtime.installed && record.scope === 'current-profile').length,
      bundlesEnabled: bundleRecords.filter(record => record.availability === 'profile' && record.runtime.enabled === true).length,
      bundlesOtherProfiles: bundleRecords.filter(record => record.scope === 'other-profile').length,
      // DSH-shipped components are outside the managed scope; kept at 0 for API compatibility.
      bundlesOfficial: 0,
      rowsTotal: managedPlugins.length,
      rowsLoaded: managedPlugins.filter(plugin => plugin.fiberPhase === 'active').length,
      rowsFailed: managedPlugins.filter(plugin => plugin.fiberPhase === 'failed').length,
      updatesAvailable: bundleRecords.filter(record => record.version.status === 'update-available').length,
      abnormal: bundleRecords.filter(record => record.diagnostics.some(item => item.level === 'error') || record.runtime.error !== undefined).length,
    }
    // Runtime-created Loader rows cannot be attributed to an installed package;
    // they are reported as a note plus a per-row diagnostic instead of a gap.
    const runtimeOnlyRows = rowRecords.filter(record => record.source.kind === 'unknown')
    for (const record of runtimeOnlyRows) {
      record.diagnostics.push({
        level: 'info',
        code: 'row/runtime-only',
        message: '该插件行在运行时创建，没有对应的安装包记录；管理器不尝试更新或修改它。',
      })
    }
    if (runtimeOnlyRows.length > 0) {
      notes.push(`${String(runtimeOnlyRows.length)} 个插件行只在运行时出现（无安装包归属），已在列表中标注。`)
    }
    if (excludedBuiltinBundles.length > 0) {
      notes.push(`${String(excludedBuiltinBundles.length)} 个 DSH 内置组件由 DSH 自带的 Built-in plugins 页面管理，未纳入本页清单、统计与更新范围。`)
    }
    const unexplained: Reconciliation['unexplained'] = []
    counts.attributedRows = attributed.size
    counts.unattributedRows = rowRecords.length
    counts.excludedBuiltinBundles = excludedBuiltinBundles.length
    counts.otherProfileDependencies = [...otherDeps.keys()].length
    const reconciliation: Reconciliation = {
      complete: bundlesError === undefined && pluginsError === undefined
        && profiles.every(profile => profile.readable) && sourceOfBundleComplete(bundleRecords),
      scannedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      sources,
      counts,
      unexplained,
      notes,
    }
    const version = runtimeVersion(facts)
    const lastRunAt = this.state.get().settings.lastCheckAt?.plugins
    const payload: PluginInventoryPayload = {
      profile: {
        name: facts.name,
        dir: facts.dir,
        dshHome: facts.home,
        ...(version === undefined ? {} : { runtimeVersion: version }),
      },
      profiles,
      bundles: bundleRecords.sort(compareBundles),
      rows: rowRecords,
      stats,
      reconciliation,
      check: { running: false, ...(lastRunAt === undefined ? {} : { lastRunAt }) },
    }
    this.cached = { at: now, payload }
    return payload
  }

  /** Empty payload used when the Host has no management service (or no profile). */
  private emptyPayload(
    now: number,
    facts?: ProfileFacts,
    sources: SourceStatus[] = [],
    counts: Record<string, number> = {},
    notes: string[] = [],
  ): PluginInventoryPayload {
    const reconciliation: Reconciliation = {
      complete: false,
      scannedAt: new Date(now).toISOString(),
      durationMs: 0,
      sources,
      counts,
      unexplained: [],
      notes,
    }
    return {
      profile: facts === undefined
        ? { name: 'unknown', dir: '', dshHome: '' }
        : { name: facts.name, dir: facts.dir, dshHome: facts.home },
      profiles: [],
      bundles: [],
      rows: [],
      stats: {
        bundlesInstalled: 0,
        bundlesEnabled: 0,
        bundlesOtherProfiles: 0,
        bundlesOfficial: 0,
        rowsTotal: 0,
        rowsLoaded: 0,
        rowsFailed: 0,
        updatesAvailable: 0,
        abnormal: 0,
      },
      reconciliation,
      check: { running: false },
    }
  }
}

/** A profile bundle without a readable install directory makes the audit incomplete. */
function sourceOfBundleComplete(records: readonly PluginBundleRecord[]): boolean {
  return records.every(record => record.availability !== 'missing')
}

/** Default ordering: third-party profile bundles first, then other bundles, official last. */
function compareBundles(a: PluginBundleRecord, b: PluginBundleRecord): number {
  const rank = (record: PluginBundleRecord): number => {
    if (record.availability === 'profile' && !record.official) return 0
    if (record.availability === 'profile') return 1
    if (record.availability === 'installation' && record.runtime.enabled === true) return 2
    return 3
  }
  const diff = rank(a) - rank(b)
  return diff !== 0 ? diff : a.name.localeCompare(b.name)
}


/** Read the rows a bundle patch declares, without a full YAML parse (patches may carry `!!js`). */
function readBundlePatchRows(packageDir: string, patchValue: unknown): Array<{ rowId: string; moduleName: string }> {
  const files: string[] = typeof patchValue === 'string'
    ? [patchValue]
    : Array.isArray(patchValue)
      ? patchValue.filter((value): value is string => typeof value === 'string')
      : []
  const rows: Array<{ rowId: string; moduleName: string }> = []
  for (const file of files) {
    let text: string
    try {
      text = readFileSync(join(packageDir, file), 'utf8')
    } catch {
      continue
    }
    let current: { rowId?: string; moduleName?: string } | undefined
    const flush = (): void => {
      if (current?.rowId !== undefined && current.moduleName !== undefined) {
        rows.push({ rowId: current.rowId, moduleName: current.moduleName })
      }
      current = undefined
    }
    for (const rawLine of text.split(String.fromCharCode(10))) {
      const line = rawLine.endsWith(String.fromCharCode(13)) ? rawLine.slice(0, -1) : rawLine
      if (current !== undefined && current.moduleName === undefined) {
        const nameMatch = /^\s+name:\s*['"]?([^'"\s]+)['"]?/u.exec(line)
        if (nameMatch?.[1] !== undefined) current.moduleName = nameMatch[1]
        continue
      }
      const idMatch = /^\s*-\s*id:\s*['"]?([^'"\s]+)['"]?/u.exec(line)
      if (idMatch?.[1] !== undefined) {
        flush()
        current = { rowId: idMatch[1] }
      }
    }
    flush()
  }
  return rows
}

/** Collect bundle packages declared by other readable profiles (read-only, informational). */
function readOtherProfileBundles(profiles: PluginInventoryPayload['profiles'], facts: ProfileFacts): PluginBundleRecord[] {
  const records: PluginBundleRecord[] = []
  for (const profile of profiles) {
    if (profile.current || !profile.readable) continue
    const data = readProfileManifestData(profile.dir)
    const profileFactsLike: ProfileFacts = { ...facts, name: profile.name, dir: profile.dir }
    for (const [name, spec] of Object.entries(data.dependencies)) {
      const dir = resolvePackageDirectory(profileFactsLike, name)
      if (dir === undefined) continue
      const manifest = readJsonFile(join(dir, 'package.json'))
      if (manifest === undefined) continue
      const dsh = manifest.dsh as { bundle?: { patch?: unknown } } | undefined
      if (dsh?.bundle === undefined) continue
      const source = classifyDependencySpec(name, spec, profile.dir, profile.name)
      const rows = readBundlePatchRows(dir, dsh.bundle.patch).map(row => ({
        entryId: `other:${profile.name}:${row.rowId}`,
        rowId: row.rowId,
        moduleName: row.moduleName,
        enabled: false,
        loaded: false,
        fiberPhase: null,
      }))
      const version = typeof manifest.version === 'string' ? manifest.version : undefined
      const display = PLUGIN_DISPLAY[name]
      const id = `plugin-bundle:${profile.name}:${name}`
      records.push({
        id,
        kind: 'plugin-bundle',
        name,
        displayName: display?.title ?? name,
        description: display?.description ?? (typeof manifest.description === 'string' ? manifest.description : ''),
        version: {
          ...(version === undefined ? {} : { current: version }),
          status: 'no-source',
          reason: `仅在 Profile「${profile.name}」中安装；当前 Profile 没有运行它`,
        },
        source: {
          ...source,
          trust: 'read-only-other-profile',
          detail: `来自另一个 DSH Profile「${profile.name}」，只读展示`,
        },
        runtime: { installed: true, enabled: data.bundles.includes(name), loaded: false },
        scope: 'other-profile',
        profile: profile.name,
        official: false,
        availability: 'profile',
        removable: false,
        paths: { installDir: dir, manifestPath: join(dir, 'package.json') },
        rows,
        overrides: [],
        localModification: { state: 'unknown', detail: '其他 Profile 的安装不参与本地修改核对' },
        ...(typeof manifest.description === 'string' ? { packageDescription: manifest.description } : {}),
        diagnostics: [],
        actions: {
          canCheck: false,
          canUpdate: false,
          updateBlockedReason: `Profile「${profile.name}」不是当前运行的 Profile，只读展示`,
        },
      })
    }
  }
  return records
}

/** Whether a file is a directory (used by the diagnostics view). */
export function directoryExists(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
