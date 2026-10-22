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
 * Process attribution has one more property: a browser can leave the process
 * tree it was started in (Edge re-launches itself in some elevation paths), so
 * a PID-only model is not enough. Every process is therefore attributed to a
 * profile directory by parsing the `--user-data-dir` value out of its command
 * line and comparing it *exactly* against the directory this tool created -
 * never by image name, never by substring, never by directory naming alone.
 *
 * Nothing here ever terminates processes by image name. Every termination is
 * addressed to one explicitly identified PID, and (when the caller has one)
 * guarded by the creation timestamp of the process that was inspected.
 *
 * Every function that decides which directories belong to "this tool" takes an
 * optional `prefix` (see `profileNamePattern`). The default stays
 * `dsh-em-chrome-`, so shot.mjs and its suite are unaffected; a second tool
 * passes its own namespace and can then neither sweep nor reclaim the first
 * tool's directories.
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

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Builds the directory-name pattern for one tool's profile namespace.
 *
 * A prefix must carry its own namespace segment (`dsh-em-<name>-`). The bare
 * `dsh-em-` prefix is rejected on purpose: accepting it would make one tool's
 * sweep responsible for another tool's directories, which is exactly the
 * cross-cleanup the audited scripts must not do.
 */
export function profileNamePattern(prefix = PROFILE_PREFIX) {
  const value = String(prefix)
  if (!/^dsh-em-[a-z][a-z0-9]*-$/.test(value)) {
    const error = new Error(`invalid profile prefix: ${JSON.stringify(value)}`)
    error.code = 'EPREFIX'
    throw error
  }
  return new RegExp(`^${escapeRegExp(value)}\\d{13}-\\d{1,4}$`)
}

/** Image names that count as "the browser" when attributing profile owners. */
export const BROWSER_IMAGES = ['msedge.exe', 'chrome.exe']

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command']

/** Creation timestamp format used by every PowerShell projection below. */
const PS_CREATED = "@{n='created';e={ if ($_.CreationDate) { $_.CreationDate.ToString('yyyyMMddHHmmssfff') } else { '' } }}"

/**
 * Creates a unique, traceable profile directory inside the OS temp root.
 * The name embeds the creation epoch (ms) plus a random suffix, so a leaked
 * directory can always be dated and attributed to a single run.
 */
export function createProfileDir(root = tmpdir(), options = {}) {
  const prefix = options.prefix ?? PROFILE_PREFIX
  profileNamePattern(prefix)
  const dir = join(root, `${prefix}${String(Date.now())}-${String(Math.floor(Math.random() * 10000))}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Refuses to hand out a path that is not a real directory directly inside the
 * expected temp root and not named after this tool's convention. This is the
 * gate before any recursive delete: it blocks path traversal, symlink swaps
 * and accidental deletion of unrelated data.
 */
export function assertSafeProfileDir(dir, root = tmpdir(), options = {}) {
  const pattern = profileNamePattern(options.prefix ?? PROFILE_PREFIX)
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
  if (!pattern.test(basename(realDir))) {
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
 * Best-effort read of the `--user-data-dir` value out of a browser command
 * line, for diagnostics. Truncates at whitespace, so a *display* value may be
 * shorter than the real path; attribution never relies on this function.
 */
export function extractUserDataDir(commandLine) {
  if (typeof commandLine !== 'string' || commandLine === '') return null
  const match = /--user-data-dir=(?:"([^"]*)"|'([^']*)'|([^\s"]+))/.exec(commandLine)
  if (match === null) return null
  const value = match[1] ?? match[2] ?? match[3]
  if (value === undefined || value === '') return null
  return value
}

function normalizeForSearch(path) {
  return String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * True when the command line carries `--user-data-dir=<dir>` as a whole
 * argument value.
 *
 * Matching the known directory textually - instead of parsing an unknown path
 * out of the command line - is what makes this correct for quoted arguments and
 * for paths containing spaces (`node` quotes the whole `--user-data-dir=...`
 * argument, so a parser cannot tell where the value ends). The boundary check
 * rejects prefix collisions such as `...-1` versus `...-11`.
 */
export function commandLineReferencesProfile(commandLine, dir) {
  if (typeof commandLine !== 'string' || commandLine === '') return false
  // Two quoting conventions reach us and both must work:
  //   node quotes the whole argument  -> "--user-data-dir=C:\Temp\x"
  //   Chromium quotes the *value*     -> --user-data-dir="C:\Temp Dir\x"
  // The second form only appears when the path contains a space, which is
  // exactly the case where a missed match would delete a profile still in use.
  const haystack = commandLine
    .replace(/--user-data-dir=(?:"([^"]*)"|'([^']*)')/giu, (match, double, single) => `--user-data-dir=${double ?? single}`)
    .replace(/\\/g, '/')
    .toLowerCase()
  const needle = `--user-data-dir=${normalizeForSearch(dir)}`
  const isBoundary = ch => ch === undefined || ch === '"' || ch === "'" || /\s/.test(ch)
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    const next = haystack[at + needle.length]
    if (isBoundary(next)) return true
    // A trailing separator is a boundary too, but only if nothing follows it -
    // otherwise `...\b` would match the prefix of `...\b\c`.
    if (next === '/' && isBoundary(haystack[at + needle.length + 1])) return true
    at = haystack.indexOf(needle, at + 1)
  }
  return false
}

/**
 * Processes whose command line points at exactly this profile directory.
 * Exact, boundary-checked equality (not substring, not image name, not the
 * directory naming convention alone) is what makes this safe: a sibling
 * directory that merely shares a prefix, or an unrelated Edge window, never
 * matches.
 */
export function findProfileOwners(dir, processes) {
  return (processes ?? []).filter(entry =>
    commandLineReferencesProfile(entry?.commandLine ?? entry?.cmd, dir))
}

function parseJsonList(stdout) {
  const text = (stdout ?? '').trim()
  if (text === '') return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/**
 * One PowerShell call that returns every live browser process with the fields
 * needed for attribution: pid, parent pid, image name, creation timestamp and
 * command line.
 *
 * This is deliberately a *snapshot* API: a sweep over N profile directories
 * costs one enumeration, not N. Callers that need to kill a process re-verify
 * against a fresh snapshot (or a single-PID identity query) immediately before
 * terminating, because a PID can be recycled between two snapshots.
 */
export function listBrowserProcesses({ imageNames = BROWSER_IMAGES, timeoutMs = 20000 } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, processes: [], detail: `process enumeration is Windows-only (platform ${process.platform})` }
  }
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$names=@($env:SHOT_IMAGES.ToLower().Split(';'))",
    'Get-CimInstance Win32_Process'
      + ' | Where-Object { $_.Name -and ($names -contains $_.Name.ToLower()) }'
      + ` | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='ppid';e={[int]$_.ParentProcessId}},@{n='name';e={[string]$_.Name}},${PS_CREATED},@{n='cmd';e={[string]$_.CommandLine}}`
      + ' | ConvertTo-Json -Compress -Depth 3',
  ].join('; ')
  const executed = spawnSync('powershell', [...POWERSHELL_ARGS, script], {
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, SHOT_IMAGES: imageNames.join(';') },
    timeout: timeoutMs,
  })
  if (executed.error) return { ok: false, processes: [], detail: String(executed.error.message) }
  if (executed.status !== 0) {
    return { ok: false, processes: [], detail: `powershell exited ${String(executed.status)}: ${(executed.stderr ?? '').trim().slice(0, 240)}` }
  }
  try {
    const processes = parseJsonList(executed.stdout).map(entry => ({
      pid: Number(entry.pid),
      parentPid: Number(entry.ppid),
      name: String(entry.name ?? ''),
      createdAt: String(entry.created ?? ''),
      commandLine: String(entry.cmd ?? ''),
    }))
    return { ok: true, processes: processes.filter(entry => Number.isInteger(entry.pid) && entry.pid > 0), detail: '' }
  } catch (error) {
    return { ok: false, processes: [], detail: `could not parse process list: ${String(error.message).slice(0, 200)}` }
  }
}

/**
 * Identity of one PID: creation timestamp plus command line. Used to prove that
 * the process about to be terminated is still the process that was inspected.
 */
export function queryProcessIdentity(pid) {
  if (process.platform !== 'win32') {
    return { ok: false, found: false, detail: `process enumeration is Windows-only (platform ${process.platform})` }
  }
  if (!Number.isInteger(pid) || pid <= 0) return { ok: true, found: false, detail: 'invalid pid' }
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    `Get-CimInstance Win32_Process -Filter "ProcessId=${String(pid)}"`
      + ` | Select-Object @{n='pid';e={[int]$_.ProcessId}},@{n='name';e={[string]$_.Name}},${PS_CREATED},@{n='cmd';e={[string]$_.CommandLine}}`
      + ' | ConvertTo-Json -Compress -Depth 3',
  ].join('; ')
  const result = spawnSync('powershell', [...POWERSHELL_ARGS, script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
  })
  if (result.error) return { ok: false, found: false, detail: String(result.error.message) }
  let entries
  try {
    entries = parseJsonList(result.stdout)
  } catch (error) {
    return { ok: false, found: false, detail: `could not parse identity: ${String(error.message).slice(0, 200)}` }
  }
  const entry = entries[0]
  if (entry === undefined) return { ok: true, found: false, detail: 'process not found' }
  return {
    ok: true,
    found: true,
    pid: Number(entry.pid),
    name: String(entry.name ?? ''),
    createdAt: String(entry.created ?? ''),
    commandLine: String(entry.cmd ?? ''),
    detail: '',
  }
}

/**
 * The one and only place a browser process is killed on Windows. Addressed to a
 * PID (plus its child tree) - never to an image name.
 *
 * Kept as a module-level function so `terminateProcessTree` can accept a stand-in
 * in tests while the production call stays a single, greppable call site.
 */
function taskkillPidTree(pid) {
  return spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    encoding: 'utf8',
  })
}

/**
 * Last-resort termination of a *specific* PID and its children on Windows.
 * `taskkill /T` walks the child tree, so a browser process that relaunched
 * itself and is still inside the same tree is covered. Killing by image name
 * (`/IM`) is deliberately never used.
 *
 * Two optional guards make the caller state its evidence explicitly:
 *   - expectedProfileDir: refuse when the live PID's `--user-data-dir` differs
 *     (this is what a recycled PID looks like);
 *   - expectedCreatedAt: refuse when the live PID's creation timestamp differs.
 * Both close the "inspect, then terminate" window to a small race, not to zero.
 *
 * `options.queryIdentity` and `options.taskkill` exist so a suite can prove the
 * refusal path without ever killing anything: when a guard rejects, the taskkill
 * stand-in must not be reached at all.
 */
export function terminateProcessTree(pid, options = {}) {
  if (!isProcessAlive(pid)) return { ok: true, method: 'already-exited', detail: '' }

  const queryIdentity = options.queryIdentity ?? queryProcessIdentity
  const runTaskkill = options.taskkill ?? taskkillPidTree
  let identityVerified = null
  const needsIdentity = options.expectedCreatedAt !== undefined || options.expectedProfileDir !== undefined
  if (needsIdentity) {
    const identity = queryIdentity(pid)
    if (!identity.ok) {
      // Cannot prove identity: for a PID this tool never started, refuse.
      if (options.requireIdentity === true) {
        return { ok: false, refused: true, method: 'identity-unknown', detail: identity.detail }
      }
      identityVerified = false
    } else if (!identity.found) {
      return { ok: true, method: 'already-exited', detail: 'process disappeared before termination' }
    } else {
      if (options.expectedCreatedAt !== undefined && identity.createdAt !== options.expectedCreatedAt) {
        return {
          ok: false,
          refused: true,
          method: 'identity-mismatch',
          detail: `pid ${String(pid)} is now created at ${identity.createdAt}, expected ${String(options.expectedCreatedAt)}`,
        }
      }
      if (options.expectedProfileDir !== undefined) {
        if (!commandLineReferencesProfile(identity.commandLine, options.expectedProfileDir)) {
          return {
            ok: false,
            refused: true,
            method: 'identity-mismatch',
            detail: `pid ${String(pid)} does not carry --user-data-dir=${String(options.expectedProfileDir)}`,
          }
        }
      }
      identityVerified = true
    }
  }

  const result = runTaskkill(pid)
  const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  return {
    ok: !isProcessAlive(pid),
    method: 'taskkill /PID /T /F',
    status: result.status,
    detail,
    identityVerified,
  }
}

/**
 * Reclaims browsers that survived the tracked-PID kill because they left the
 * process tree (Edge re-launching itself, a child outliving its parent).
 *
 * Each attempt takes a fresh snapshot, re-derives the owners of *this* profile
 * directory only, and terminates them with the creation timestamp from that
 * same snapshot. Attempts are bounded; the result always reports what was
 * killed, what was refused, and what is still alive.
 */
export function reapProfileOwners(dir, options = {}) {
  const attempts = options.attempts ?? 3
  const delayMs = options.delayMs ?? 400
  const exitTimeoutMs = options.exitTimeoutMs ?? 3000
  const imageNames = options.imageNames ?? BROWSER_IMAGES
  const listProcesses = options.listProcesses ?? listBrowserProcesses
  const kill = options.kill ?? ((pid, killOptions) => terminateProcessTree(pid, killOptions))

  const report = { ok: true, unknown: false, terminated: [], refused: [], remaining: [], attempts: 0, queries: 0, lastError: null, rejected: null }

  // Safety gate: only a directory this tool would create is ever "owned".
  let pattern
  try {
    pattern = profileNamePattern(options.prefix ?? PROFILE_PREFIX)
  } catch (error) {
    return { ...report, ok: false, rejected: error.message }
  }
  if (!pattern.test(basename(resolve(dir)))) {
    return { ...report, ok: false, rejected: `not a profile directory of this tool: ${String(dir)}` }
  }
  if (options.root !== undefined && dirname(resolve(dir)) !== resolve(options.root)) {
    return { ...report, ok: false, rejected: `profile directory escaped the sweep root: ${String(dir)}` }
  }

  let owners = []
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    report.attempts = attempt
    const snapshot = listProcesses({ imageNames })
    report.queries += 1
    if (!snapshot.ok) {
      report.ok = false
      report.unknown = true
      report.lastError = snapshot.detail
      report.remaining = owners.map(entry => entry.pid)
      return report
    }
    owners = findProfileOwners(dir, snapshot.processes)
    if (owners.length === 0) return report
    for (const owner of owners) {
      const outcome = kill(owner.pid, { expectedCreatedAt: owner.createdAt, requireIdentity: true })
      if (outcome.refused === true) {
        report.refused.push({ pid: owner.pid, createdAt: owner.createdAt, detail: outcome.detail })
        continue
      }
      report.terminated.push({ pid: owner.pid, createdAt: owner.createdAt, ok: outcome.ok, method: outcome.method, detail: outcome.detail })
      if (outcome.ok) waitForExit(owner.pid, exitTimeoutMs)
    }
    if (attempt < attempts) sleepSync(delayMs)
  }

  const finalSnapshot = listProcesses({ imageNames })
  report.queries += 1
  if (finalSnapshot.ok) {
    report.remaining = findProfileOwners(dir, finalSnapshot.processes).map(entry => entry.pid)
  } else {
    report.unknown = true
    report.lastError = finalSnapshot.detail
    report.remaining = owners.map(entry => entry.pid)
  }
  report.ok = report.remaining.length === 0 && !report.unknown
  return report
}

/**
 * Diagnostic view of which live processes still reference this profile path.
 * Shares the exact attribution rule used by the reaper, so a report and a kill
 * decision can never disagree.
 */
export function findProcessesUsingDir(dir, options = {}) {
  const listProcesses = options.listProcesses ?? listBrowserProcesses
  const snapshot = listProcesses({ imageNames: options.imageNames ?? BROWSER_IMAGES })
  if (!snapshot.ok) return { ok: false, pids: [], detail: snapshot.detail }
  return { ok: true, pids: findProfileOwners(dir, snapshot.processes).map(entry => entry.pid), detail: '' }
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
 *
 * Ownership is resolved from a *single* process snapshot taken once for the
 * whole sweep, so the cost no longer grows with the number of candidates
 * (previously each candidate started its own PowerShell). The safety rules are
 * unchanged: naming convention, age cutoff, no live owner, real-path gate,
 * bounded delete retry. If the snapshot cannot be read, every candidate is
 * skipped - "unknown" is never treated as "free".
 */
export function sweepStaleProfiles(options = {}) {
  const root = options.root ?? tmpdir()
  const olderThanHours = options.olderThanHours ?? 0
  const now = options.now ?? Date.now()
  const imageNames = options.imageNames ?? BROWSER_IMAGES
  const listProcesses = options.listProcesses ?? listBrowserProcesses
  const statOf = options.stat ?? (target => statSync(target))
  const cutoff = now - olderThanHours * 3600 * 1000
  const swept = []
  const skipped = []
  let processQueries = 0

  const prefix = options.prefix ?? PROFILE_PREFIX
  let pattern
  try {
    pattern = profileNamePattern(prefix)
  } catch (error) {
    return { swept, skipped, processQueries, error: error.message }
  }

  let names
  try {
    names = readdirSync(root)
  } catch (error) {
    return { swept, skipped, processQueries, error: String(error.message) }
  }

  const candidates = []
  for (const name of names) {
    if (!pattern.test(name)) continue
    const dir = join(root, name)
    let stat
    try {
      stat = statOf(dir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    candidates.push({ dir, mtimeMs: stat.mtimeMs })
  }
  if (candidates.length === 0) return { swept, skipped, processQueries }

  const snapshot = listProcesses({ imageNames })
  processQueries += 1
  if (!snapshot.ok) {
    for (const candidate of candidates) {
      skipped.push({ dir: candidate.dir, reason: `ownership unknown: ${String(snapshot.detail)}` })
    }
    return { swept, skipped, processQueries, error: snapshot.detail }
  }

  for (const candidate of candidates) {
    if (candidate.mtimeMs > cutoff) {
      skipped.push({ dir: candidate.dir, reason: 'newer than cutoff' })
      continue
    }
    const owners = findProfileOwners(candidate.dir, snapshot.processes)
    if (owners.length > 0) {
      skipped.push({ dir: candidate.dir, reason: `in use by pid ${owners.map(entry => entry.pid).join(',')}` })
      continue
    }
    try {
      assertSafeProfileDir(candidate.dir, root, { prefix })
    } catch (error) {
      skipped.push({ dir: candidate.dir, reason: error.message })
      continue
    }
    const removal = removeDirWithRetry(candidate.dir)
    swept.push({ dir: candidate.dir, removed: removal.removed, attemptCount: removal.attemptCount, lastError: removal.lastError })
  }
  return { swept, skipped, processQueries }
}
