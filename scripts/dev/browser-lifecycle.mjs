/**
 * Browser lifecycle helpers used by the verification scripts (shot.mjs).
 *
 * These helpers exist because a screenshot helper that spawns a real browser
 * must be able to answer three questions reliably, even when it is
 * interrupted or crashes:
 *
 *   1. Which process did I start, and is it still alive?  (PID tracking)
 *   2. Did it really exit before I delete its profile directory?  (exit wait)
 *   3. If deletion failed, why - and is the failure visible?  (retry + report)
 *
 * Nothing here ever terminates processes by image name. Every termination is
 * addressed to one explicitly tracked PID, plus its child tree on Windows.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** Directory names owned by this tool. Nothing else is ever touched. */
export const PROFILE_PREFIX = 'dsh-em-chrome-'
const PROFILE_NAME = /^dsh-em-chrome-\d{13}-\d{1,4}$/

/**
 * Creates a unique, traceable profile directory inside the OS temp root.
 * The name embeds the creation epoch (ms) plus a random suffix, so a leaked
 * directory can always be dated and attributed to a single run.
 */
export function createProfileDir(root = tmpdir()) {
  const dir = join(root, `${PROFILE_PREFIX}${String(Date.now())}-${String(Math.floor(Math.random() * 10000))}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Refuses to hand out a path that is not a real directory directly inside the
 * expected temp root and not named after this tool's convention. This is the
 * gate before any recursive delete: it blocks path traversal, symlink swaps
 * and accidental deletion of unrelated data.
 */
export function assertSafeProfileDir(dir, root = tmpdir()) {
  const absDir = resolve(dir)
  const absRoot = resolve(root)
  if (!existsSync(absDir)) {
    const error = new Error(`profile directory does not exist: ${absDir}`)
    error.code = 'ENOPROFILE'
    throw error
  }
  if (lstatSync(absDir).isSymbolicLink()) {
    const error = new Error(`refusing to use a symlinked profile directory: ${absDir}`)
    error.code = 'ESYMLINK'
    throw error
  }
  const realDir = realpathSync(absDir)
  const realRoot = realpathSync(absRoot)
  if (dirname(realDir) !== realRoot) {
    const error = new Error(`profile directory escaped the temp root: ${realDir} (root ${realRoot})`)
    error.code = 'EOUTSIDE'
    throw error
  }
  if (!PROFILE_NAME.test(basename(realDir))) {
    const error = new Error(`profile directory name is not recognised: ${realDir}`)
    error.code = 'ENAMING'
    throw error
  }
  return realDir
}

export function sleepSync(ms) {
  if (ms <= 0) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** True while the PID exists; EPERM still means "alive, not ours to inspect". */
export function isProcessAlive(pid) {
  if (pid === null || pid === undefined) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/** Polls until the PID disappears or the budget runs out. */
export function waitForExit(pid, timeoutMs, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    sleepSync(intervalMs)
  }
  return !isProcessAlive(pid)
}

/**
 * Last-resort termination of a *specific* PID and its children on Windows.
 * `taskkill /T` walks the child tree, so a browser process that relaunched
 * itself and is no longer a direct child of this script is still covered.
 * Killing by image name (`/IM`) is deliberately never used.
 */
export function terminateProcessTree(pid) {
  if (!isProcessAlive(pid)) return { ok: true, method: 'already-exited', detail: '' }
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
  })
  const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return {
    ok: !isProcessAlive(pid),
    method: 'taskkill /PID /T /F',
    status: result.status,
    detail,
  }
}

/**
 * Diagnostic only: which live processes still reference this profile path.
 * Used when a delete fails, to turn an opaque EBUSY into an actionable report.
 */
export function findProcessesUsingDir(dir) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Get-CimInstance Win32_Process',
    "| Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($env:SHOT_PROFILE_DIR) }",
    '| Select-Object -ExpandProperty ProcessId',
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, SHOT_PROFILE_DIR: dir },
    timeout: 15000,
  })
  if (result.error) return { ok: false, pids: [], detail: String(result.error.message) }
  const pids = (result.stdout ?? '')
    .split(/\r?\n/)
    .map(line => Number(line.trim()))
    .filter(value => Number.isInteger(value) && value > 0)
  return { ok: true, pids, detail: (result.stderr ?? '').trim() }
}

/**
 * Deletes the profile directory with bounded exponential backoff.
 * Never swallows the failure: the caller receives every attempt's error code
 * so it can print a diagnosable message instead of an empty catch block.
 */
export function removeDirWithRetry(dir, options = {}) {
  const maxAttempts = options.attempts ?? 8
  const baseDelayMs = options.baseDelayMs ?? 200
  const maxDelayMs = options.maxDelayMs ?? 2000
  const remove = options.rm ?? (target => rmSync(target, { recursive: true, force: true }))
  const attempts = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      remove(dir)
      if (!existsSync(dir)) return { removed: true, attemptCount: attempt, attempts }
      attempts.push({ attempt, code: 'ESTILLEXISTS', message: 'remove() returned but the directory is still present' })
    } catch (error) {
      attempts.push({ attempt, code: error.code ?? 'EUNKNOWN', message: String(error.message).slice(0, 240) })
    }
    if (attempt < maxAttempts) sleepSync(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs))
  }
  return { removed: false, attemptCount: maxAttempts, attempts, lastError: attempts.at(-1) }
}

/**
 * Removes stale profile directories left behind by earlier interrupted runs.
 * Only directories that match this tool's naming convention, are older than
 * the cutoff, and are not referenced by a live browser process are eligible.
 */
export function sweepStaleProfiles({ root = tmpdir(), olderThanHours = 0, now = Date.now() } = {}) {
  const cutoff = now - olderThanHours * 3600 * 1000
  const swept = []
  const skipped = []
  let names = []
  try {
    names = readdirSync(root)
  } catch (error) {
    return { swept, skipped, error: String(error.message) }
  }
  for (const name of names) {
    if (!PROFILE_NAME.test(name)) continue
    const dir = join(root, name)
    let stat
    try {
      stat = statSync(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    if (stat.mtimeMs > cutoff) {
      skipped.push({ dir, reason: 'newer than cutoff' })
      continue
    }
    const owners = findProcessesUsingDir(dir)
    if (!owners.ok || owners.pids.length > 0) {
      skipped.push({ dir, reason: owners.ok ? `in use by pid ${owners.pids.join(',')}` : 'ownership check failed' })
      continue
    }
    try {
      assertSafeProfileDir(dir, root)
    } catch (error) {
      skipped.push({ dir, reason: error.message })
      continue
    }
    const removal = removeDirWithRetry(dir)
    swept.push({ dir, removed: removal.removed, attemptCount: removal.attemptCount, lastError: removal.lastError })
  }
  return { swept, skipped }
}
