/**
 * Headless-browser screenshot + click helper over the Chrome DevTools Protocol.
 *
 * Verification-only tool: opens the locally running DSH Web GUI with the
 * owner-minted browser-session cookie, performs a scripted click path, and
 * saves screenshots. Built on Node's global WebSocket and fetch, so no
 * third-party browser driver is installed.
 *
 * Usage:
 *   node shot.mjs --cookie <cookie.json> --out <dir> --steps <steps.json>
 *                 [--chrome <browser.exe>] [--url <url>] [--port <n>]
 *                 [--keep-profile] [--profile-root <dir>]
 *                 [--graceful-timeout <ms>] [--force-timeout <ms>]
 *                 [--sweep-stale-hours <n>]   (default 24, 0 disables)
 *
 * Steps file: an array of { "eval": "<js>" } | { "wait": ms } |
 * { "shot": "name" } | { "size": [w,h] } | { "method": "CDP.Method" } operations,
 * executed in order.
 *
 * Startup sweep: Windows cannot intercept TerminateProcess, so a run that is
 * killed outright (agent timeout, closed terminal) can still leave a profile
 * behind - the exit hook never runs. On every start this script therefore
 * reclaims directories older than the cutoff that carry its own naming
 * convention and are not referenced by a live browser process. Recent or
 * in-use directories are never touched.
 *
 * Lifecycle contract (why this file is longer than it used to be):
 *   - the browser is launched inside try/finally, so no earlier failure path
 *     can skip reaping;
 *   - the browser PID and profile directory are tracked explicitly, and the
 *     browser is closed through CDP `Browser.close` first;
 *   - if it is still alive afterwards, `taskkill /PID <pid> /T /F` is used on
 *     that exact PID - never by image name, so unrelated Edge windows are safe;
 *   - the profile directory is deleted only after the process is gone, with
 *     bounded retries and a visible failure report (no silent catch blocks);
 *   - SIGINT/SIGTERM/SIGHUP/uncaughtException still reap, because an
 *     interrupted verification run used to leak a browser and ~250 MB.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSafeProfileDir,
  createProfileDir,
  findProcessesUsingDir,
  isProcessAlive,
  removeDirWithRetry,
  sweepStaleProfiles,
  terminateProcessTree,
  waitForExit,
} from './browser-lifecycle.mjs'

const EXIT_OK = 0
const EXIT_RUNTIME = 1
const EXIT_SETUP = 2
const EXIT_CLEANUP = 3

const DEFAULT_CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/**
 * Throw-away profiles are still real Edge profiles: without these switches a
 * fresh `--user-data-dir` signs in with the Windows Microsoft account and pulls
 * synced history, extensions and passwords (measured: account_info=1,
 * sync=24 keys, 34 MB in 22 s). With them the same profile stays at
 * account_info=0, sync=0 keys, 0 extensions, 15 MB.
 */
const ISOLATION_ARGS = [
  '--disable-sync',
  '--disable-features=msEdgeSyncConsent,msImplicitSignin,ImplicitSignInFlowV3,msEdgeIdentityFeature',
  '--no-service-autorun',
  '--disable-background-networking',
]

const BASE_ARGS = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1600,1000',
]

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

function flag(name) {
  return process.argv.includes(`--${name}`)
}

function numberArg(name, fallback) {
  const raw = arg(name, undefined)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    const error = new Error(`--${name} expects a non-negative number, got ${String(raw)}`)
    error.setup = true
    throw error
  }
  return value
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const state = {
  profileDir: null,
  profileRoot: tmpdir(),
  browserPid: null,
  pageWs: null,
  port: null,
  keepProfile: flag('keep-profile'),
  gracefulTimeoutMs: 0,
  forceTimeoutMs: 0,
  shuttingDown: false,
  reaped: false,
  cleanup: null,
}

function log(message) {
  console.log(message)
}

function warn(message) {
  console.error(message)
}

async function closePageSocket() {
  try {
    state.pageWs?.close()
  } catch (error) {
    warn(`[cleanup] page socket close failed: ${error.message}`)
  }
}

/**
 * Normal close path: ask the browser to shut itself down over CDP so it can
 * flush its profile cleanly. Returns a report instead of throwing, because a
 * failure here is expected on a crashed browser and must not block reaping.
 */
async function requestBrowserClose() {
  if (!state.port) return { ok: false, detail: 'no debugging port' }
  try {
    const response = await fetch(`http://127.0.0.1:${String(state.port)}/json/version`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return { ok: false, detail: `HTTP ${String(response.status)}` }
    const version = await response.json()
    const socket = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('browser websocket timeout')), 3000)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('browser websocket error')) }, { once: true })
    })
    socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
    await sleep(250)
    try { socket.close() } catch { /* already closing */ }
    return { ok: true, detail: 'Browser.close sent' }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

async function shutdown(reason) {
  if (state.shuttingDown) return state.cleanup
  state.shuttingDown = true
  const report = { reason, graceful: null, forced: null, directory: null, lingering: [] }
  state.cleanup = report

  await closePageSocket()

  if (state.browserPid !== null && isProcessAlive(state.browserPid)) {
    report.graceful = await requestBrowserClose()
    if (!waitForExit(state.browserPid, state.gracefulTimeoutMs)) {
      report.forced = terminateProcessTree(state.browserPid)
      waitForExit(state.browserPid, state.forceTimeoutMs)
    }
    if (isProcessAlive(state.browserPid)) {
      const owners = findProcessesUsingDir(state.profileDir)
      report.lingering = owners.pids
      warn(`[cleanup] browser pid ${String(state.browserPid)} survived force termination`)
    }
  }

  if (state.profileDir === null) return report

  if (state.keepProfile) {
    report.directory = { removed: false, kept: true }
    log(`[cleanup] --keep-profile: directory kept at ${state.profileDir}`)
    return report
  }

  if (!existsSync(state.profileDir)) {
    report.directory = { removed: true, attemptCount: 0, attempts: [] }
    return report
  }

  let safeDir = null
  try {
    safeDir = assertSafeProfileDir(state.profileDir, state.profileRoot)
  } catch (error) {
    report.directory = { removed: false, rejected: error.message }
    warn(`[cleanup] refusing to delete profile directory: ${error.message}`)
    return report
  }

  const removal = removeDirWithRetry(safeDir)
  report.directory = removal
  if (!removal.removed) {
    const owners = findProcessesUsingDir(safeDir)
    report.lingering = owners.pids
    warn('[cleanup] FAILED to remove profile directory')
    warn(`[cleanup]   path: ${safeDir}`)
    warn(`[cleanup]   attempts: ${String(removal.attemptCount)}`)
    warn(`[cleanup]   last error: ${removal.lastError.code} ${removal.lastError.message}`)
    if (owners.pids.length > 0) warn(`[cleanup]   still referenced by pid: ${owners.pids.join(', ')}`)
  }
  return report
}

/**
 * Synchronous last chance, used by the `exit` handler: `exit` cannot await, so
 * this path only does what is possible without promises.
 */
function syncReap() {
  if (state.reaped) return
  state.reaped = true
  if (state.browserPid !== null && isProcessAlive(state.browserPid)) {
    try {
      terminateProcessTree(state.browserPid)
    } catch (error) {
      warn(`[cleanup] exit-time termination failed: ${error.message}`)
    }
  }
  if (state.profileDir && !state.keepProfile && existsSync(state.profileDir)) {
    try {
      const removal = removeDirWithRetry(state.profileDir, { attempts: 3, baseDelayMs: 100, maxDelayMs: 400 })
      if (!removal.removed) warn(`[cleanup] exit-time removal failed for ${state.profileDir}`)
    } catch (error) {
      warn(`[cleanup] exit-time removal failed: ${error.message}`)
    }
  }
}

process.on('exit', syncReap)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    log(`[signal] ${signal} received; reaping browser and profile directory`)
    shutdown(`signal:${signal}`).then(
      () => process.exit(130),
      (error) => { warn(`[cleanup] shutdown after ${signal} failed: ${error.message}`); process.exit(130) },
    )
  })
}

process.on('uncaughtException', (error) => {
  warn('[failed] uncaught exception:', error.message)
  shutdown('uncaughtException').then(
    () => process.exit(EXIT_RUNTIME),
    () => process.exit(EXIT_RUNTIME),
  )
})

process.on('unhandledRejection', (reason) => {
  warn('[failed] unhandled rejection:', reason instanceof Error ? reason.message : String(reason))
  shutdown('unhandledRejection').then(
    () => process.exit(EXIT_RUNTIME),
    () => process.exit(EXIT_RUNTIME),
  )
})

function waitForSpawn(child, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (child.pid) {
      resolve(child.pid)
      return
    }
    const timer = setTimeout(() => reject(new Error('browser process did not report a pid')), timeoutMs)
    child.once('spawn', () => { clearTimeout(timer); resolve(child.pid) })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

async function waitForDevtools(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      if (response.ok) return await response.json()
    } catch { /* browser still starting */ }
    await sleep(200)
  }
  throw new Error(`browser DevTools did not become reachable on port ${String(port)}`)
}

async function main() {
  const cookiePath = arg('cookie')
  const stepsPath = arg('steps')
  if (!cookiePath || !stepsPath) {
    const error = new Error('missing required --cookie and/or --steps')
    error.setup = true
    throw error
  }

  const outDir = arg('out', '.')
  const cookie = JSON.parse(readFileSync(cookiePath, 'utf8'))
  const steps = JSON.parse(readFileSync(stepsPath, 'utf8'))
  const chromePath = arg('chrome', DEFAULT_CHROME)
  const profileRoot = arg('profile-root', tmpdir())

  state.port = Number(arg('port', '0')) || (20000 + Math.floor(Math.random() * 20000))
  state.gracefulTimeoutMs = numberArg('graceful-timeout', 4000)
  state.forceTimeoutMs = numberArg('force-timeout', 5000)
  state.profileRoot = profileRoot

  if (!existsSync(chromePath)) {
    const error = new Error(`browser executable not found: ${chromePath}`)
    error.setup = true
    throw error
  }

  mkdirSync(outDir, { recursive: true })

  const sweepHours = numberArg('sweep-stale-hours', 24)
  if (sweepHours > 0) {
    const swept = sweepStaleProfiles({ root: profileRoot, olderThanHours: sweepHours })
    if (swept.swept.length > 0) {
      log(`[cleanup] swept ${String(swept.swept.length)} stale profile director${swept.swept.length === 1 ? 'y' : 'ies'}`)
      for (const entry of swept.swept) {
        if (!entry.removed) warn(`[cleanup]   could not remove ${entry.dir}: ${entry.lastError.code} ${entry.lastError.message}`)
      }
    }
    if (swept.skipped.length > 0) log(`[cleanup] skipped ${String(swept.skipped.length)} director${swept.skipped.length === 1 ? 'y' : 'ies'} (in use or too new)`)
  }

  // Profile directory and browser are both created inside the try: from here on
  // every exit path goes through finally -> shutdown().
  state.profileDir = createProfileDir(profileRoot)
  assertSafeProfileDir(state.profileDir, profileRoot)

  const child = spawn(chromePath, [
    ...BASE_ARGS,
    ...ISOLATION_ARGS,
    // A random debugging port per run keeps concurrent runs from attaching to a
    // stale browser left behind by a previous invocation.
    `--remote-debugging-port=${String(state.port)}`,
    `--user-data-dir=${state.profileDir}`,
    'about:blank',
  ], { stdio: 'ignore' })

  state.browserPid = await waitForSpawn(child)

  await waitForDevtools(state.port)
  const pages = await (await fetch(`http://127.0.0.1:${String(state.port)}/json/list`)).json()
  const page = pages.find(item => item.type === 'page')
  if (page === undefined) throw new Error('no page target')
  state.pageWs = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    state.pageWs.addEventListener('open', resolve, { once: true })
    state.pageWs.addEventListener('error', () => reject(new Error('page websocket error')), { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const consoleLines = []
  state.pageWs.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (entry !== undefined) {
        pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
        else entry.resolve(message.result)
      }
      return
    }
    if (message.method === 'Runtime.consoleAPICalled') {
      const text = (message.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' ')
      consoleLines.push(`[${message.params.type}] ${text}`)
    }
    if (message.method === 'Runtime.exceptionThrown') {
      consoleLines.push(`[exception] ${message.params.exceptionDetails?.text ?? ''} ${message.params.exceptionDetails?.exception?.description ?? ''}`)
    }
  })

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    state.pageWs.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  const screenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const path = join(outDir, `${name}.png`)
    writeFileSync(path, Buffer.from(shot.data, 'base64'))
    log(`[shot] ${path}`)
  }

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')

  const launchUrl = arg('url', '')
  await send('Network.setCookie', {
    name: cookie.name,
    value: cookie.value,
    // Host-only, non-secure cookie. Current Chrome rejects some attribute
    // combinations (httpOnly + sameSite) for http loopback origins, so only the
    // transport-safe fields are set; the server checks the value, not the flags.
    url: 'http://127.0.0.1:3080/',
  })

  const stepsText = JSON.stringify(steps)
  const resolvedSteps = launchUrl === '' ? steps : JSON.parse(stepsText.replaceAll('{{LAUNCH_URL}}', launchUrl))
  if (launchUrl !== '') {
    // A launch token URL mints the browser-session cookie and redirects to ./.
    await evaluate(`location.href = ${JSON.stringify(launchUrl)}`)
    await sleep(1500)
    await evaluate('location.reload()')
    await sleep(1500)
  }

  for (const step of resolvedSteps) {
    if (step.wait !== undefined) { await sleep(step.wait); continue }
    if (step.size !== undefined) {
      await send('Emulation.setDeviceMetricsOverride', {
        width: step.size[0], height: step.size[1], deviceScaleFactor: 1, mobile: false,
      })
      continue
    }
    if (step.eval !== undefined) {
      const value = await evaluate(step.eval)
      if (value !== undefined) log(`[eval] ${JSON.stringify(value)}`)
      continue
    }
    if (step.shot !== undefined) { await screenshot(step.shot); continue }
    if (step.method !== undefined) {
      // Direct CDP escape hatch for network/emulation checks in verification runs.
      const value = await send(step.method, step.params ?? {})
      if (value !== undefined) log(`[cdp] ${step.method}`)
      continue
    }
    throw new Error(`unknown step ${JSON.stringify(step)}`)
  }

  if (consoleLines.length > 0) {
    writeFileSync(join(outDir, 'console.log'), consoleLines.join('\n'), 'utf8')
    log(`[console] ${consoleLines.length} lines -> console.log`)
  }
}

let exitCode = EXIT_OK
let failed = false

try {
  await main()
} catch (error) {
  failed = true
  exitCode = error.setup === true ? EXIT_SETUP : EXIT_RUNTIME
  warn(`[failed] ${error.message}`)
} finally {
  const report = await shutdown(failed ? 'error' : 'normal')
  const directoryFailed = report?.directory !== null && report?.directory?.removed === false && report?.directory?.kept !== true
  if (directoryFailed || (report?.lingering?.length ?? 0) > 0) exitCode = EXIT_CLEANUP
  if (report?.directory?.removed === true) {
    log(`[cleanup] profile directory removed (${String(report.directory.attemptCount)} attempt${report.directory.attemptCount === 1 ? '' : 's'})`)
  }
  if (report?.forced) log(`[cleanup] forced termination: ${report.forced.method}${report.forced.status !== undefined ? ` (status ${String(report.forced.status)})` : ''}`)
  process.exitCode = exitCode
}
