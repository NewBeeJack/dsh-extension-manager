/**
 * Durable manager state: update-check cache, verified skill source
 * associations, update transactions and history.
 *
 * The file lives outside every other plugin's data:
 *   $DSH_HOME/extension-manager/state.json
 * and carries an explicit schema version so future releases migrate instead of
 * discarding. Writes are serialized and atomic (write-temp + rename), with the
 * previous document kept as `state.json.bak`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { HistoryEntry, TransactionRecord } from '../shared/types'
import { profileFacts, readJsonFile, ownPackageDir } from './env'

export const STATE_VERSION = 1

/** One cached update-check answer. */
export interface CheckCacheEntry {
  /** `plugin:<id>` / `skill:<id>` keyed by record id. */
  recordId: string
  status: import('../shared/types').UpdateStatus
  currentVersion?: string
  availableVersion?: string
  availableCommit?: string
  availableTree?: string
  channel?: 'stable' | 'prerelease' | 'tag' | 'commit' | 'unknown'
  compatibility?: 'compatible' | 'incompatible' | 'unknown'
  compatibilityRequirements?: Record<string, string>
  checkedAt: string
  detail?: string
}

/** A user-confirmed skill → repository association. */
export interface SkillSourceAssociation {
  recordId: string
  url: string
  ref?: string
  subdir?: string
  confirmedAt: string
  /** Verified local baseline at confirmation time. */
  baseline?: { version?: string; commit?: string; tree?: string }
  verified: boolean
  detail?: string
}

/** Persisted document. */
export interface StateDocument {
  version: number
  profile: string
  checks: Record<string, CheckCacheEntry>
  skillSources: Record<string, SkillSourceAssociation>
  transactions: Record<string, TransactionRecord>
  history: HistoryEntry[]
  settings: {
    /** Allow prerelease candidates in normal checks. */
    includePrerelease?: boolean
    /** Last full check run per scope. */
    lastCheckAt?: { plugins?: string; skills?: string }
    /** User dismissed warning keys. */
    dismissed?: string[]
  }
}

function emptyDocument(profile: string): StateDocument {
  return {
    version: STATE_VERSION,
    profile,
    checks: {},
    skillSources: {},
    transactions: {},
    history: [],
    settings: {},
  }
}

/** Migrate any older document shape to the current schema. */
function migrate(raw: unknown, profile: string): StateDocument {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyDocument(profile)
  const doc = raw as Partial<StateDocument>
  const base = emptyDocument(profile)
  return {
    version: STATE_VERSION,
    profile,
    checks: typeof doc.checks === 'object' && doc.checks !== null ? doc.checks : base.checks,
    skillSources: typeof doc.skillSources === 'object' && doc.skillSources !== null ? doc.skillSources : base.skillSources,
    transactions: typeof doc.transactions === 'object' && doc.transactions !== null ? doc.transactions : base.transactions,
    history: Array.isArray(doc.history) ? doc.history : base.history,
    settings: typeof doc.settings === 'object' && doc.settings !== null ? { ...base.settings, ...doc.settings } : base.settings,
  }
}

/** Where the manager keeps its own data. */
export interface ManagerPaths {
  home: string
  stateDir: string
  logDir: string
  backupDir: string
  stagingDir: string
  stateFile: string
  logFile: string
}

/** Resolve manager paths from the running profile. */
export function managerPaths(ctx: Context): ManagerPaths | undefined {
  const facts = profileFacts(ctx)
  if (facts === undefined) return undefined
  const stateDir = join(facts.home, 'extension-manager')
  return {
    home: facts.home,
    stateDir,
    logDir: join(stateDir, 'logs'),
    backupDir: join(stateDir, 'backups'),
    stagingDir: join(stateDir, 'staging'),
    stateFile: join(stateDir, 'state.json'),
    logFile: join(stateDir, 'logs', 'manager.log'),
  }
}

/**
 * Owns the in-memory document and serializes every write behind one queue.
 * Reads are synchronous against the in-memory copy; mutations return a
 * promise that settles after the atomic disk write.
 */
export class ManagerState {
  readonly paths: ManagerPaths
  private document: StateDocument
  private queue: Promise<void> = Promise.resolve()
  private readonly profile: string

  constructor(ctx: Context, paths: ManagerPaths) {
    this.paths = paths
    const facts = profileFacts(ctx)
    this.profile = facts?.name ?? 'unknown'
    const raw = existsSync(paths.stateFile) ? readJsonFile(paths.stateFile) : undefined
    this.document = migrate(raw, this.profile)
  }

  /** Create the manager directories before the first write. */
  async initialize(): Promise<void> {
    await mkdir(this.paths.stateDir, { recursive: true })
    await mkdir(this.paths.logDir, { recursive: true })
    await mkdir(this.paths.backupDir, { recursive: true })
    await mkdir(this.paths.stagingDir, { recursive: true })
    if (!existsSync(this.paths.stateFile)) await this.flush()
  }

  /** Read the current in-memory document (never mutate it directly). */
  get(): Readonly<StateDocument> {
    return this.document
  }

  /** Read one cached check. */
  check(recordId: string): CheckCacheEntry | undefined {
    return this.document.checks[recordId]
  }

  /** Replace one cached check answer and persist. */
  async setCheck(entry: CheckCacheEntry): Promise<void> {
    this.document = { ...this.document, checks: { ...this.document.checks, [entry.recordId]: entry } }
    await this.flush()
  }

  /** Replace many cached check answers in one write. */
  async setChecks(entries: readonly CheckCacheEntry[]): Promise<void> {
    if (entries.length === 0) return
    const checks = { ...this.document.checks }
    for (const entry of entries) checks[entry.recordId] = entry
    this.document = { ...this.document, checks }
    await this.flush()
  }

  /** Forget one cached check (e.g. after an update). */
  async clearCheck(recordId: string): Promise<void> {
    if (!(recordId in this.document.checks)) return
    const checks = { ...this.document.checks }
    delete checks[recordId]
    this.document = { ...this.document, checks }
    await this.flush()
  }

  /** Read one skill source association. */
  skillSource(recordId: string): SkillSourceAssociation | undefined {
    return this.document.skillSources[recordId]
  }

  /** Save one verified skill source association. */
  async setSkillSource(association: SkillSourceAssociation): Promise<void> {
    this.document = {
      ...this.document,
      skillSources: { ...this.document.skillSources, [association.recordId]: association },
    }
    await this.flush()
  }

  /** Read one persisted transaction. */
  transaction(id: string): TransactionRecord | undefined {
    return this.document.transactions[id]
  }

  /** All non-terminal transactions (used by startup recovery). */
  openTransactions(): TransactionRecord[] {
    const terminal = new Set(['VERIFIED', 'RECOVERED', 'RECOVERY_REQUIRED'])
    return Object.values(this.document.transactions).filter(record => !terminal.has(record.phase))
  }

  /** Insert or replace one transaction. */
  async putTransaction(record: TransactionRecord): Promise<void> {
    this.document = {
      ...this.document,
      transactions: { ...this.document.transactions, [record.id]: record },
    }
    await this.flush()
  }

  /** Append one history entry (bounded to the newest 500). */
  async addHistory(entry: HistoryEntry): Promise<void> {
    const history = [entry, ...this.document.history].slice(0, 500)
    this.document = { ...this.document, history }
    await this.flush()
  }

  /** Read newest-first history. */
  history(limit = 200): HistoryEntry[] {
    return this.document.history.slice(0, limit)
  }

  /** Read the settings block. */
  settings(): Readonly<StateDocument['settings']> {
    return this.document.settings
  }

  /** Patch settings and persist. */
  async patchSettings(patch: Partial<StateDocument['settings']>): Promise<void> {
    this.document = { ...this.document, settings: { ...this.document.settings, ...patch } }
    await this.flush()
  }

  /** Write the current document atomically, serialized behind the queue. */
  flush(): Promise<void> {
    const write = async (): Promise<void> => {
      const text = JSON.stringify(this.document, undefined, 2)
      const temp = `${this.paths.stateFile}.tmp-${String(process.pid)}`
      await mkdir(this.paths.stateDir, { recursive: true })
      await writeFile(temp, text, 'utf8')
      if (existsSync(this.paths.stateFile)) {
        await rename(this.paths.stateFile, `${this.paths.stateFile}.bak`).catch(() => undefined)
      }
      await rename(temp, this.paths.stateFile)
    }
    this.queue = this.queue.then(write, write)
    return this.queue
  }
}
