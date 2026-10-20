/**
 * Shared, transport-safe data model of the DSH Extension Manager.
 *
 * Both halves compile against this file: the Host produces these records from
 * real filesystem / registry / Loader state, the Web client only renders them.
 * Nothing here imports Node or browser APIs.
 */

/** The three object layers the manager distinguishes. */
export type ExtensionKind = 'plugin-bundle' | 'plugin-row' | 'skill'

/** Where a record lives, as far as management is concerned. */
export type ManagementScope =
  /** The running profile of this Host. */
  | 'current-profile'
  /** Another readable profile under the DSH home. */
  | 'other-profile'
  /** Shipped with the DSH installation. */
  | 'installation'
  /** A physical skill directory on this machine. */
  | 'filesystem'

/**
 * Update states. Every record always carries exactly one of these; a failed
 * or impossible check is never rendered as "up to date".
 */
export type UpdateStatus =
  | 'unchecked'
  | 'checking'
  | 'up-to-date'
  | 'update-available'
  | 'incompatible-update'
  | 'prerelease-only'
  | 'needs-source'
  | 'local-modified'
  | 'no-source'
  | 'network-error'
  | 'check-failed'
  | 'downloading'
  | 'installing'
  | 'validating'
  | 'pending-restart'
  | 'updated'
  | 'update-failed'
  | 'recovery-required'

/** Trust classification of the provenance that updates rely on. */
export type SourceTrust =
  | 'verified'
  | 'needs-confirmation'
  | 'unknown'
  | 'local-custom'
  | 'official'
  | 'no-remote-update'
  | 'read-only-other-profile'

/** How the extension arrived on this machine. */
export type SourceKind =
  | 'npm'
  | 'github'
  | 'git'
  | 'local-link'
  | 'local-path'
  | 'tarball'
  | 'official'
  | 'bundled'
  | 'skill-git'
  | 'skill-lock'
  | 'filesystem'
  | 'profile-patch'
  | 'unknown'

/** Provenance of one extension. Absent optional fields stay absent — never invented. */
export interface SourceInfo {
  kind: SourceKind
  trust: SourceTrust
  /** Short human-readable label, e.g. "npm registry", "GitHub · owner/repo". */
  label: string
  /** Repository or package home page when known and verified. */
  url?: string
  /** npm package name when the extension came from a registry. */
  packageName?: string
  /** The exact installation spec recorded by the package manager, when any. */
  spec?: string
  /** The npm registry used for lookups. */
  registry?: string
  /** Git branch / tag name. */
  ref?: string
  /** Installed commit for git-backed extensions. */
  commit?: string
  /** Repository-relative directory holding the skill or bundle (monorepo case). */
  subdir?: string
  /** `owner/repo` for GitHub-backed extensions. */
  repo?: string
  /** Repository URL declared by the installed package.json, when readable. */
  repository?: string
  /** Repository-relative directory declared by package.json `repository.directory`. */
  repositoryDirectory?: string
  /** Free-form qualification shown in details (e.g. why trust is only "needs-confirmation"). */
  detail?: string
}

/** Version facts. Unknown values stay `undefined`. */
export interface VersionInfo {
  current?: string
  /** Git tree/blob identity for skills (tree hash of the skill directory). */
  currentTree?: string
  currentCommit?: string
  branch?: string
  available?: string
  availableCommit?: string
  availableTree?: string
  /** Release channel the candidate belongs to. */
  channel?: 'stable' | 'prerelease' | 'tag' | 'commit' | 'unknown'
  /** Whether the candidate satisfies the running DSH runtime requirements, when declared. */
  compatibility?: 'compatible' | 'incompatible' | 'unknown'
  /** Requirements that made the candidate incompatible, as `key: range` entries. */
  compatibilityRequirements?: Record<string, string>
  lastCheckedAt?: string
  status: UpdateStatus
  /** Machine-independent explanation for the status (Chinese, ready to show). */
  reason?: string
}

/** Separate install / enable / load truths. */
export interface RuntimeInfo {
  /** Whether a package or skill directory exists for this record. */
  installed: boolean
  /** Whether the saved configuration selects it. */
  enabled?: boolean
  /** Whether it is actually loaded right now (Loader fiber active / skill in catalog). */
  loaded?: boolean
  /** Loader fiber phase for plugin rows/bundles. */
  fiberPhase?: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  /** Whether the change needs a Host restart. */
  restartRequired?: boolean
  /** Last load error observed. */
  error?: string
  /** Whether the last update was validated end-to-end. */
  verifiedAfterUpdate?: boolean
  /** Catalog observation was incomplete for this provider. */
  catalogIncomplete?: boolean
}

/** Paths shown and copied by the UI. */
export interface PathInfo {
  /** Directory of the installed package (plugin) or skill. */
  installDir?: string
  /** `package.json` or `SKILL.md`. */
  manifestPath?: string
  /** Symlink target for `link:`/file installs. */
  resolvedPath?: string
  /** Root directory a skill was discovered under. */
  rootDir?: string
}

/** Local modification evidence. */
export interface LocalModificationInfo {
  state: 'unknown' | 'clean' | 'modified'
  /** Changed / extra files, bounded. */
  files?: string[]
  detail?: string
}

/** A structured, user-facing diagnostic line. */
export interface Diagnostic {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  /** Additional machine data, JSON-safe. */
  detail?: Record<string, unknown>
}

/** Actions the client may offer for one record. */
export interface RecordActions {
  /** A trustworthy remote source exists and the record can be checked. */
  canCheck: boolean
  /** The record can be updated by this manager. */
  canUpdate: boolean
  /** Why update is not offered, when it is not. */
  updateBlockedReason?: string
  /** Whether the update needs explicit confirmation because it may overwrite local changes. */
  requiresConfirmation?: boolean
  /** Whether the record can be enabled/disabled through a native mechanism. */
  canToggle?: boolean
  /** Why toggling is not offered (absence means the kind has no such mechanism). */
  toggleBlockedReason?: string
}

/** What kind of object one plugin row is. */
export type PluginRowKind = 'bundle-entry' | 'built-in' | 'preset' | 'unknown'

/** One Loader row contributed by a bundle. */
export interface PluginRowSummary {
  entryId: string
  rowId?: string
  moduleName: string
  /** Display name derived from package metadata when available. */
  displayName?: string
  description?: string
  enabled: boolean
  loaded: boolean
  fiberPhase?: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  /** True for rows this bundle only overrides (built-in rows), not inserts. */
  overrides?: boolean
  readOnlyReason?: string
  error?: string
}

/** One plugin bundle (installation package) record. */
export interface PluginBundleRecord {
  id: string
  kind: 'plugin-bundle'
  /** npm package name. */
  name: string
  displayName: string
  description: string
  /** Verified base64 data URL from the installed bundle's own manifest, when present. */
  icon?: string
  version: VersionInfo
  source: SourceInfo
  runtime: RuntimeInfo
  scope: ManagementScope
  /** Profile that declares this bundle. */
  profile: string
  /** Whether this bundle is the one providing the running plugin manager. */
  official: boolean
  availability: 'installation' | 'profile' | 'missing'
  removable: boolean
  readOnlyReason?: string
  paths: PathInfo
  rows: PluginRowSummary[]
  /** Rows from earlier layers the bundle configures or disables. */
  overrides: string[]
  localModification: LocalModificationInfo
  /** `package.json` description when the record has no localized metadata. */
  packageDescription?: string
  diagnostics: Diagnostic[]
  actions: RecordActions
  /** Whether this is the extension manager's own package. */
  self?: boolean
  /** Other profiles declaring the same physical bundle (informational). */
  alsoInProfiles?: string[]
}

/** One standalone plugin row that is not attributed to a bundle (runtime observation). */
export interface PluginRowRecord {
  id: string
  kind: 'plugin-row'
  name: string
  displayName: string
  description: string
  /** Verified base64 data URL from the live plugin metadata, when present. */
  icon?: string
  version: VersionInfo
  source: SourceInfo
  runtime: RuntimeInfo
  scope: ManagementScope
  profile: string
  paths: PathInfo
  row: PluginRowSummary
  localModification: LocalModificationInfo
  diagnostics: Diagnostic[]
  actions: RecordActions
}

/** One physically installed skill (list A) with its runtime counterpart (list B). */
export interface SkillRecord {
  id: string
  kind: 'skill'
  /** Kebab-case skill name from the frontmatter. */
  name: string
  displayName: string
  description: string
  version: VersionInfo
  source: SourceInfo
  runtime: RuntimeInfo
  scope: ManagementScope
  /** Discovery root key (`user-dsh`, `user-agents`, `custom:...`, `project-dsh`, ...). */
  rootKey: string
  /** Rank the DSH filesystem provider uses for this root. */
  rootRank?: number
  /** Root-level note (e.g. a registered workspace that is not active in this run). */
  rootNote?: string
  /** Physical form. */
  layout: 'directory' | 'flat-file'
  paths: PathInfo
  /** Provider that would serve the skill when it is loaded (`filesystem` or another). */
  provider?: string
  /** Runtime summary when this physical copy is the winning candidate. */
  effective: boolean
  /** Winning copy's path when another copy shadows this one. */
  shadowedBy?: string
  /** Effective copies that win over this one (names/paths of other duplicates). */
  overriddenCopies?: Array<{ rootKey: string; path: string }>
  /** Invocation policy of the effective skill. */
  invocation?: { model: boolean; user: boolean }
  localModification: LocalModificationInfo
  diagnostics: Diagnostic[]
  actions: RecordActions
}

/** A runtime-visible skill that has no physical directory in the scanned roots (virtual/bundled). */
export interface VirtualSkillRecord {
  id: string
  kind: 'skill'
  name: string
  displayName: string
  description: string
  version: VersionInfo
  source: SourceInfo
  runtime: RuntimeInfo
  scope: ManagementScope
  rootKey: string
  layout: 'virtual'
  paths: PathInfo
  provider?: string
  effective: true
  invocation?: { model: boolean; user: boolean }
  localModification: LocalModificationInfo
  diagnostics: Diagnostic[]
  actions: RecordActions
}

export type PluginRecord = PluginBundleRecord | PluginRowRecord
export type AnySkillRecord = SkillRecord | VirtualSkillRecord
export type ExtensionRecord = PluginRecord | AnySkillRecord

/** Provenance of one discovery source and whether it was read completely. */
export interface SourceStatus {
  /** Stable source identifier. */
  id: string
  /** Human-readable label (Chinese). */
  label: string
  /** What this source contributes. */
  contributes: 'bundles' | 'rows' | 'profiles' | 'skills-physical' | 'skills-runtime' | 'provenance' | 'registry'
  /** Number of records the source contributed (or expected). */
  count?: number
  /** Whether the source was read to completion. */
  complete: boolean
  /** Why it is incomplete / unavailable. */
  error?: string
  /** Where the source lives (path or URL). */
  location?: string
}

/**
 * Completeness accounting. The UI shows "清单不完整" whenever `complete` is
 * false, and always lists the sources that failed.
 */
export interface Reconciliation {
  complete: boolean
  scannedAt: string
  durationMs: number
  /** Per-source audit rows. */
  sources: SourceStatus[]
  /** Counts derived from each source, before merging. */
  counts: Record<string, number>
  /** Records that could not be reconciled with any authoritative source. */
  unexplained: Array<{ id: string; name: string; why: string }>
  /** Sources that were expected but absent (optional integrations). */
  notes: string[]
}

/** Statistics with explicit accounting, per page. */
export interface PluginStats {
  /** Installed bundle packages in the current profile. */
  bundlesInstalled: number
  /** Bundles selected in the current profile. */
  bundlesEnabled: number
  /** Bundle packages readable from other profiles (informational). */
  bundlesOtherProfiles: number
  /** Shipped/official packages readable from the installation (excluded from the managed scope; reported as 0). */
  bundlesOfficial: number
  /** Plugin rows in the current runtime (all bundles). */
  rowsTotal: number
  /** Rows active right now. */
  rowsLoaded: number
  /** Rows whose loader fiber failed. */
  rowsFailed: number
  /** Bundles with an available compatible update. */
  updatesAvailable: number
  /** Records with an error / unresolved anomaly. */
  abnormal: number
}

export interface SkillStats {
  /** Physical skill copies discovered (list A). */
  physical: number
  /** Runtime-visible skills (list B). */
  runtime: number
  /** Physical copies that win their name. */
  effective: number
  /** Physical copies shadowed by another copy of the same name. */
  shadowed: number
  /** Physical copies whose root is not consumed by the running DSH (e.g. Codex). */
  notManaged: number
  /** Skills with a verified/known update available. */
  updatesAvailable: number
  /** Skills with diagnostics. */
  abnormal: number
}

export interface PluginInventoryPayload {
  profile: { name: string; dir: string; dshHome: string; runtimeVersion?: string }
  /** Profiles readable under the DSH home. */
  profiles: Array<{ name: string; dir: string; readable: boolean; current: boolean; bundles: number; error?: string }>
  bundles: PluginBundleRecord[]
  rows: PluginRowRecord[]
  stats: PluginStats
  reconciliation: Reconciliation
  /** Server-side update check bookkeeping. */
  check: { lastRunAt?: string; running: boolean; taskId?: string }
}

export interface SkillsInventoryPayload {
  /** Host working directory / workspace used for project roots. */
  workspace?: { id?: string; name?: string; path?: string }
  roots: Array<{
    key: string
    label: string
    path: string
    rank?: number
    /** Whether the running DSH skill provider scans this root. */
    managed: boolean
    exists: boolean
    complete: boolean
    error?: string
    count: number
  }>
  /** Physical copies (清单 A). */
  physical: SkillRecord[]
  /** Runtime-visible skills with no physical copy in a scanned root (清单 B extras). */
  virtual: VirtualSkillRecord[]
  stats: SkillStats
  reconciliation: Reconciliation
  check: { lastRunAt?: string; running: boolean; taskId?: string }
}

/** One update plan entry, shown before an update runs. */
export interface UpdatePlanEntry {
  id: string
  kind: ExtensionKind
  name: string
  displayName: string
  currentVersion?: string
  targetVersion?: string
  sourceLabel: string
  /** Whether this entry may run in an automatic/batch update. */
  eligible: boolean
  /** Why it is excluded, when it is. */
  excludedReason?: string
  requiresConfirmation: boolean
  needsRestart: boolean
  /** Risk text (Chinese) for the user. */
  risk?: string
}

export interface UpdatePlan {
  kind: 'plugins' | 'skills' | 'all'
  entries: UpdatePlanEntry[]
  excluded: UpdatePlanEntry[]
  createdAt: string
}

/** Durable transaction phases (requirement 9.6). */
export type TransactionPhase =
  | 'PREFLIGHT'
  | 'BACKUP'
  | 'DOWNLOAD'
  | 'STAGE'
  | 'INSTALL'
  | 'VALIDATE'
  | 'PENDING_RESTART'
  | 'VERIFIED'
  | 'FAILED'
  | 'RECOVERY'
  | 'RECOVERED'
  | 'RECOVERY_REQUIRED'

/** One persisted update transaction. */
export interface TransactionRecord {
  id: string
  kind: ExtensionKind
  extensionId: string
  name: string
  targetVersion?: string
  previousVersion?: string
  phase: TransactionPhase
  /** ISO timestamps. */
  startedAt: string
  updatedAt: string
  /** Ordered audit lines (also mirrored to the log file). */
  steps: Array<{ at: string; phase: TransactionPhase; message: string; detail?: Record<string, unknown> }>
  /** Verified backup location, when one was created. */
  backupDir?: string
  /** Human-readable final result. */
  result?: string
  error?: string
  /** Whether a restart is needed for the change to take effect. */
  needsRestart?: boolean
  /** True when the older version was restored. */
  rolledBack?: boolean
}

/** One durable update-history entry (successful, failed or recovered). */
export interface HistoryEntry {
  id: string
  at: string
  kind: ExtensionKind
  name: string
  action: 'update' | 'batch-update' | 'skill-update' | 'source-associate' | 'self-update'
  fromVersion?: string
  toVersion?: string
  outcome: 'success' | 'failed' | 'rolled-back' | 'recovery-required' | 'blocked'
  message: string
  transactionId?: string
}

/** High-level task phase; status stays for old clients, phase adds lifecycle detail. */
export type TaskPhase =
  | 'queued'
  | 'preflight'
  | 'backup'
  | 'download'
  | 'stage'
  | 'install'
  | 'validate'
  | 'pending_restart'
  | 'recovering'
  | 'recovery_required'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** One candidate that the check task intentionally did not query. */
export interface TaskSkippedItem {
  /** Stable inventory record id; never a display name or array index. */
  id: string
  /** Current display name from the inventory record. */
  name: string
  /** Reason recorded by the existing check eligibility/cache decision. */
  reason: string
}

/** Async task state returned by the Host. */
export interface TaskState {
  id: string
  kind: 'check' | 'update' | 'batch-update' | 'refresh' | 'source-associate' | 'self-update'
  scope: 'plugins' | 'skills' | 'all'
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  /** Optional lifecycle phase (new clients); `status` remains authoritative for old ones. */
  phase?: TaskPhase
  startedAt: string
  finishedAt?: string
  total: number
  completed: number
  /** Per-item status lines; ids match inventory records. */
  items: Array<{
    id: string
    name: string
    status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped'
    message?: string
    fromVersion?: string
    toVersion?: string
  }>
  /** Overall result summary (Chinese). */
  message?: string
  error?: string
  /** Check-task candidates intentionally skipped by the existing eligibility/cache rules. */
  skipped?: TaskSkippedItem[]
  /** Plan for update tasks. */
  plan?: UpdatePlan
  /** Transactions started by this task. */
  transactionIds?: string[]
}

/** Health / environment block shown in the diagnostics view. */
export interface EnvironmentInfo {
  runtimeVersion?: string
  hostPid: number
  profile: { name: string; dir: string; dshHome: string; installAnchor: string }
  platform: string
  nodeVersion: string
  pnpmVersion?: string
  gitVersion?: string
  hmrEnabled: boolean
  registries: { registry: string | null; fallbackRegistries: string[]; resolved: string | null }
  networkProxy?: string
  manager: {
    version: string
    ownPackageName: string
    installSource?: SourceInfo
    updatesSupported: boolean
    selfUpdateSupported: boolean
    selfUpdateReason?: string
    stateDir: string
    logDir: string
    backupDir: string
  }
  /** Providers / roots the manager reads. */
  skillProviders: Array<{ key: string; managed: boolean; path: string }>
  /** Limitations currently in effect. */
  limitations: string[]
}

/** Request/response bodies stay in api.ts; records here are read-only views. */

/** A bounded directory listing entry for the diagnostics "open location" affordance. */
export interface PathCheck {
  path: string
  exists: boolean
  isDirectory: boolean
  writable?: boolean
  resolved?: string
  error?: string
}
