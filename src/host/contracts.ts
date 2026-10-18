/**
 * Module contracts shared by the Host wiring and the parallel implementation
 * modules. Keeping them in one file makes the dependency direction explicit:
 * routes → inventory/checker/executor → env/state/logs.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {
  PluginInventoryPayload,
  PluginBundleRecord,
  SkillsInventoryPayload,
  SkillRecord,
  UpdatePlan,
  UpdatePlanEntry,
} from '../shared/types'
import type { ManagerLog } from './logs'
import type { ManagerState, CheckCacheEntry } from './state'
import type { TaskRegistry } from './tasks'
import type { ProfileFacts } from './env'

/** Everything a management operation may depend on. */
export interface HostServices {
  ctx: Context
  facts: ProfileFacts
  state: ManagerState
  log: ManagerLog
  tasks: TaskRegistry
  plugins: PluginInventory
  skills: SkillsInventory
  scratchDir: string
}

/** Plugin inventory surface. */
export interface PluginInventory {
  /** Read the current inventory (cached for a short window). */
  scan(options?: { refresh?: boolean }): Promise<PluginInventoryPayload>
  /** Drop the scan cache so the next read observes disk again. */
  invalidate(): void
}

/** Skills inventory surface. */
export interface SkillsInventory {
  scan(options?: { refresh?: boolean; workspace?: string }): Promise<SkillsInventoryPayload>
  invalidate(): void
  /** Verify and persist a user-confirmed repository source for one skill copy. */
  associateSource?(input: {
    id: string
    url: string
    ref?: string
    subdir?: string
    baseline?: { version?: string; commit?: string; tree?: string }
  }): Promise<{ record?: SkillRecord; task?: import('../shared/types').TaskState; error?: string }>
}

/** One per-record check outcome, produced by the update checkers. */
export interface CheckOutcome {
  /** Record id the outcome belongs to. */
  recordId: string
  /** Plugin bundle record or skill record, refreshed from the checker's view. */
  cache: CheckCacheEntry
}

/** Result of checking a batch of records. */
export interface CheckBatchResult {
  outcomes: CheckOutcome[]
  /** Records that were skipped, with the reason. */
  skipped: Array<{ recordId: string; name: string; reason: string }>
  /** Per-upstream transport errors (network unavailability is never "up to date"). */
  transportErrors: Array<{ source: string; message: string }>
  /** Human summary. */
  message: string
}

/** Plugin update checking (npm / git / GitHub). */
export interface PluginUpdateChecker {
  check(
    records: readonly PluginBundleRecord[],
    options: { refresh?: boolean; signal?: AbortSignal; onItem?: (recordId: string, status: 'running' | 'ok' | 'failed', message?: string) => void },
  ): Promise<CheckBatchResult>
}

/** Skill update checking (git tree compare / lock provenance / file hashes). */
export interface SkillUpdateChecker {
  check(
    records: readonly SkillRecord[],
    options: { refresh?: boolean; signal?: AbortSignal; onItem?: (recordId: string, status: 'running' | 'ok' | 'failed', message?: string) => void },
  ): Promise<CheckBatchResult>
}

/** Update planning + execution surface. */
export interface UpdateManager {
  /** Build the plan without touching anything. */
  plan(scope: 'plugins' | 'skills' | 'all', ids?: readonly string[], workspace?: string): Promise<UpdatePlan>
  /** Execute a confirmed plan sequentially, reporting per-item progress. */
  execute(input: {
    plan: UpdatePlan
    confirmed: boolean
    overwriteLocalModifications: boolean
    taskId: string
    signal: AbortSignal
    workspace?: string
  }): Promise<void>
  /** Reconcile transactions left unfinished by a previous Host process. */
  recover?(): Promise<void>
}

/** Helpers shared by planner and executor. */
export interface PlanDecision {
  entry: UpdatePlanEntry
  eligible: boolean
  reason?: string
}

/** Re-exported for consumers that build plans. */
export type { UpdatePlan, UpdatePlanEntry, CheckCacheEntry }
