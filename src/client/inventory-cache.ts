/**
 * Module-level inventory cache for the settings section.
 *
 * The manager section unmounts when the user switches settings pages, so React
 * state alone cannot keep a previously verified snapshot. This cache is keyed by
 * scope + workspace (never by a display name), keeps a small LRU, and is only
 * written after a successful Host read. Requests are epoch-checked and the
 * previous request for the same key is aborted, so a slow old response can never
 * overwrite a newer one.
 */
import type { PluginInventoryPayload, SkillsInventoryPayload } from '../shared/types'

export type InventoryCacheKey = 'plugins' | `skills:${string}`

interface CacheEntry {
  data: PluginInventoryPayload | SkillsInventoryPayload
  loadedAt: number
}

/** How long a verified snapshot is considered fresh enough to skip a rescan. */
export const INVENTORY_FRESH_MS = 30_000

const MAX_ENTRIES = 6
const entries = new Map<InventoryCacheKey, CacheEntry>()

const epochs = new Map<InventoryCacheKey, number>()
const controllers = new Map<InventoryCacheKey, AbortController>()

/** Cache key for one scope/workspace; workspace is part of the identity. */
export function inventoryCacheKey(scope: 'plugins' | 'skills', workspace?: string): InventoryCacheKey {
  return scope === 'plugins' ? 'plugins' : `skills:${workspace ?? ''}`
}

/** Read a previously verified snapshot (or undefined when cold). */
export function readInventoryCache<Payload extends PluginInventoryPayload | SkillsInventoryPayload>(
  key: InventoryCacheKey,
): { data: Payload; loadedAt: number } | undefined {
  const entry = entries.get(key)
  if (entry === undefined) return undefined
  // Refresh LRU position.
  entries.delete(key)
  entries.set(key, entry)
  return entry as { data: Payload; loadedAt: number }
}

/** Store one verified snapshot, trimming the oldest entries beyond the LRU bound. */
export function writeInventoryCache(key: InventoryCacheKey, data: PluginInventoryPayload | SkillsInventoryPayload): void {
  entries.delete(key)
  entries.set(key, { data, loadedAt: Date.now() })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

/** Start a request for one key, aborting the previous request on the same key. */
export function beginInventoryRequest(key: InventoryCacheKey): {
  epoch: number
  signal: AbortSignal
  isCurrent: () => boolean
} {
  controllers.get(key)?.abort()
  const controller = new AbortController()
  controllers.set(key, controller)
  const epoch = (epochs.get(key) ?? 0) + 1
  epochs.set(key, epoch)
  return {
    epoch,
    signal: controller.signal,
    isCurrent: () => epochs.get(key) === epoch && controllers.get(key) === controller,
  }
}

/** Drop every cached snapshot (used when a refresh must re-read everything). */
export function clearInventoryCache(): void {
  for (const controller of controllers.values()) controller.abort()
  controllers.clear()
  epochs.clear()
  entries.clear()
}
