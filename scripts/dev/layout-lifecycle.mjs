/**
 * Layout-verification session helpers for `verify-dialog-layout.mjs`.
 *
 * That script drives a real browser through CDP, so it needs the same lifecycle
 * guarantees as shot.mjs: attributed process reclamation, a gated recursive
 * delete, bounded waits and a visible failure report. All process handling is
 * delegated to `browser-lifecycle.mjs` - nothing here re-implements a reaper.
 * What this module adds is (a) the layout tool's own directory namespace
 * (`dsh-em-layout-`), (b) devtools-endpoint ownership verification, so the run
 * only ever talks to the browser it started, (c) the CDP plumbing with real
 * timeouts, (d) the asynchronous shutdown routine, (e) a synchronous twin of it
 * for the `exit` event, and (f) the signal/crash supervisor.
 *
 * The pieces are exported separately on purpose: the CDP client, the endpoint
 * resolver, the shutdown routine, the sync reaper and the report payload can
 * each be exercised with fakes, so the security suite never has to start a
 * browser.
 *
 * Every wait here is bounded and every bound lives in `TIMEOUTS`. A timeout is
 * a real cancellation, not just a race: the CDP request is removed from the
 * pending map and its timer cleared, a `fetch` is aborted through its
 * AbortController, and a socket that never opens is closed after the budget.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertSafeProfileDir,
  findProcessesUsingDir,
  isProcessAlive,
  reapProfileOwners,
  removeDirWithRetry,
  terminateProcessTree,
  waitForExit,
} from './browser-lifecycle.mjs'

/** This tool's own directory namespace. Never shared with shot.mjs. */
export const LAYOUT_PROFILE_PREFIX = 'dsh-em-layout-'

/**
 * Switches that keep the temporary profile from adopting the Windows/Microsoft
 * account or syncing personal data. Mirrors shot.mjs `ISOLATION_ARGS` and adds
 * `--disable-extensions`: the layout check measures the DSH web UI, which is a
 * page served by the app, not a browser extension.
 *
 * Having these switches is necessary, not sufficient: the only proof that the
 * profile stayed unlinked is inspecting `Preferences` after an isolated run.
 */
export const LAYOUT_ISOLATION_ARGS = [
  '--disable-sync',
  '--disable-features=msEdgeSyncConsent,msImplicitSignin,ImplicitSignInFlowV3,msEdgeIdentityFeature',
  '--no-service-autorun',
  '--disable-background-networking',
  '--disable-extensions',
]

/**
 * The complete launch argument list, in one place.
 *
 * `--remote-debugging-port=0` is load-bearing: the browser then chooses a free
 * port and writes it to `DevToolsActivePort` inside `profileDir`, which is the
 * only port this tool will ever talk to. Asking for a fixed or random port
 * would make "which browser answered" unprovable.
 */
export function buildLayoutLaunchArgs(profileDir) {
  return [
    ...LAYOUT_ISOLATION_ARGS,
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${String(profileDir)}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    'about:blank',
  ]
}

/** Every external wait in one place; no magic numbers at the call sites. */
export const TIMEOUTS = {
  spawnReadyMs: 15000,
  httpProbeMs: 2000,
  launchBudgetMs: 25000,
  wsOpenMs: 10000,
  cdpCommandMs: 20000,
  gracefulCloseCommandMs: 5000,
  shutdownGracefulMs: 5000,
  shutdownForceMs: 4000,
  reapAttempts: 3,
  reapDelayMs: 400,
  reappearPasses: 2,
  sweepOlderThanHours: 24,
}

export class CdpTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = 'CdpTimeoutError'
    this.code = 'ETIMEDOUT'
  }
}

const SECRET_PARAM = /^(?:token|access_token|refresh_token|auth|authorization|code|key|apikey|api_key|sig|signature|secret|password|pwd|session|sessionid|cookie)$/i

/**
 * Replaces credential-bearing query values and userinfo with `redacted`.
 * Used for anything that can reach a log line, an error message or a report.
 */
export function redactUrl(input) {
  let url
  try {
    url = new URL(String(input))
  } catch {
    return '<invalid-url>'
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_PARAM.test(key)) url.searchParams.set(key, 'redacted')
  }
  if (url.username !== '' || url.password !== '') {
    url.username = ''
    url.password = ''
  }
  return url.toString()
}

/** Origin + path only - the diagnostic form that carries no query at all. */
export function describeUrl(input) {
  try {
    const url = new URL(String(input))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return `${url.protocol}${url.pathname}`
    return `${url.origin}${url.pathname}`
  } catch {
    return '<invalid-url>'
  }
}

/** Redacts every URL embedded in a free-text message (error strings, etc.). */
export function sanitizeText(text) {
  return String(text).replace(/https?:\/\/[^\s"'<>]+/gi, match => redactUrl(match))
}

/**
 * The persisted report. Deliberately never stores the launch URL: a launch
 * token in `report.json` would survive in the working tree long after the run.
 */
export function buildReportPayload(options = {}) {
  const payload = {
    at: new Date().toISOString(),
    target: describeUrl(options.launchUrl),
    credentialSupplied: /[?&](?:token|code|key|sig)=/i.test(String(options.launchUrl ?? '')),
    results: options.results ?? [],
    failures: options.failures ?? [],
  }
  if (options.error !== undefined) payload.error = sanitizeText(options.error)
  if (options.extra !== undefined) Object.assign(payload, options.extra)
  return payload
}

/**
 * `fetch(...).json()` with a real deadline. The AbortController cancels the
 * underlying request, so a hung endpoint cannot keep the process alive.
 */
export async function fetchJsonWithTimeout(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.httpProbeMs
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { signal: controller.signal })
    if (response.ok === false) throw new Error(`HTTP ${String(response.status)} from ${describeUrl(url)}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Polls a browser-side predicate inside a deadline.
 *
 * A failed probe is a "not yet", not a fatal error - but the loop is only
 * bounded because each `evaluate` is itself bounded by the CDP command timeout.
 */
export async function waitForCondition(evaluate, expression, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000
  const intervalMs = options.intervalMs ?? 300
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    try {
      if (await evaluate(expression) === true) return true
    } catch {
      // keep polling; the deadline is the only exit
    }
    await sleep(intervalMs)
  }
  return false
}

/**
 * CDP client over an already-open socket.
 *
 * Guarantees: every `send` settles (response, socket error, socket close or
 * timeout); a timeout drops the request from the pending map instead of leaving
 * a promise that never resolves; `close()` fails all in-flight requests.
 */
export function createCdpClient(socket, options = {}) {
  const commandTimeoutMs = options.commandTimeoutMs ?? TIMEOUTS.cdpCommandMs
  const pending = new Map()
  let nextId = 0
  let closed = false
  let closeReason = null

  const rejectAll = (error) => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    pending.clear()
  }

  const markClosed = (error) => {
    if (closed) return
    closed = true
    closeReason = error
    rejectAll(error)
    if (typeof options.onClose === 'function') options.onClose(error)
  }

  const onMessage = (event) => {
    let message
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }

  socket.addEventListener('message', onMessage)
  socket.addEventListener('close', () => markClosed(new Error('CDP socket closed')))
  socket.addEventListener('error', () => markClosed(new Error('CDP socket error')))

  const send = (method, params = {}, sendOptions = {}) => new Promise((resolve, reject) => {
    if (closed) {
      reject(closeReason ?? new Error('CDP client is closed'))
      return
    }
    const timeoutMs = sendOptions.timeoutMs ?? commandTimeoutMs
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new CdpTimeoutError(`CDP ${method} produced no response within ${String(timeoutMs)} ms`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    try {
      socket.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error)
    }
  })

  const evaluate = async (expression, sendOptions) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sendOptions)
    if (result?.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text ?? 'Runtime.evaluate failed')
    return result?.result?.value
  }

  return {
    send,
    evaluate,
    close() {
      try {
        socket.removeEventListener?.('message', onMessage)
      } catch {
        // a fake socket may not implement removeEventListener
      }
      try {
        socket.close?.()
      } catch {
        // already gone
      }
      markClosed(new Error('CDP client closed'))
    },
    get pendingCount() {
      return pending.size
    },
    get closed() {
      return closed
    },
  }
}

/**
 * Opens the CDP WebSocket. A socket that neither opens nor errors is closed
 * after `openTimeoutMs` instead of being left behind, and so is a socket whose
 * handshake failed: the caller gets a rejected promise plus a dead socket, never
 * a live connection nobody owns.
 *
 * The close happens *after* the handshake listeners are detached, so `close()`
 * (which fires a `close` event on some implementations) cannot re-enter the
 * completion path. A throwing `close()` is swallowed on purpose - the original
 * handshake error is the one the caller must see.
 */
export async function connectCdp(wsUrl, options = {}) {
  const createSocket = options.createSocket ?? (url => new WebSocket(url))
  const openTimeoutMs = options.openTimeoutMs ?? TIMEOUTS.wsOpenMs
  let socket
  try {
    socket = createSocket(wsUrl)
  } catch (error) {
    // No socket exists, so there is nothing to close; surface the real reason.
    throw error
  }

  const discard = () => {
    // A late `open` would otherwise resurrect a connection this call already
    // gave up on. Closing while CONNECTING is valid and makes that impossible.
    try {
      socket.close?.()
    } catch {
      // never mask the handshake failure with a close() failure
    }
  }

  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.removeEventListener?.('open', onOpen)
        socket.removeEventListener?.('error', onError)
        if (error === null) {
          resolve()
          return
        }
        discard()
        reject(error)
      }
      const onOpen = () => finish(null)
      const onError = () => finish(new Error('CDP socket failed to open'))
      const timer = setTimeout(
        () => finish(new CdpTimeoutError(`CDP socket did not open within ${String(openTimeoutMs)} ms`)),
        openTimeoutMs,
      )
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
    })
  } catch (error) {
    // Belt and braces: an implementation whose close() is asynchronous still
    // cannot hand the socket back to the caller.
    discard()
    throw error
  }

  return createCdpClient(socket, options)
}

/**
 * Starts the browser and waits, bounded, for the `spawn` event.
 *
 * The `error` listener is attached unconditionally and before anything else: a
 * missing executable otherwise raises an uncaught 'error' event, which would
 * skip the whole cleanup path and leave the just-created profile behind.
 */
export function startBrowser(options = {}) {
  const spawnImpl = options.spawnImpl ?? spawn
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.spawnReadyMs
  const state = { child: null, pid: null, exited: false, exitCode: null, error: null, ready: Promise.resolve(false) }

  let child
  try {
    child = spawnImpl(options.executable, options.args, { stdio: 'ignore' })
  } catch (error) {
    state.error = error
    return state
  }

  state.child = child
  state.pid = child.pid ?? null
  child.on('error', (error) => {
    state.error = error
  })
  child.on('exit', (code) => {
    state.exited = true
    state.exitCode = code ?? null
  })
  state.ready = new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.once('spawn', () => finish(true))
    child.once('error', () => finish(false))
    child.once('exit', () => finish(false))
  })
  return state
}

/**
 * Failure of the "whose devtools endpoint is this" check.
 *
 * `code` is stable so a caller (and the suite) can tell the failure classes
 * apart: EFORMAT/EPORT/EPATH (bad DevToolsActivePort content), ETIMEDOUT (no
 * usable file within the budget), EEXITED (the browser died first), EENDPOINT
 * (the advertised websocket is not on the verified port / host / path),
 * ENOPAGE (/json/list exposed nothing driveable).
 */
export class CdpEndpointError extends Error {
  constructor(code, message, detail) {
    super(message)
    this.name = 'CdpEndpointError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/** Written by Chromium into `--user-data-dir` when the port is 0 or a pipe. */
export const DEVTOOLS_PORT_FILE = 'DevToolsActivePort'

const BROWSER_WS_PATH = /^\/devtools\/browser\/[A-Za-z0-9._-]+$/u
const PAGE_WS_PATH = /^\/devtools\/page\/[A-Za-z0-9._-]+$/u

/**
 * Parses the two-line `DevToolsActivePort` file: a decimal port, then the
 * browser-level websocket path.
 *
 * Strict on purpose - this string decides where the tool connects next, so it
 * must not carry a query, a fragment, a host, a trailing slash or a second
 * path segment.
 */
export function parseDevToolsActivePort(text) {
  const lines = String(text)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line !== '')
  if (lines.length < 2) {
    throw new CdpEndpointError(
      'EFORMAT',
      `${DEVTOOLS_PORT_FILE} must carry a port line and a websocket path line`,
      `found ${String(lines.length)} usable line(s)`,
    )
  }
  const [portLine, wsPath] = lines
  if (!/^\d{1,5}$/u.test(portLine)) {
    throw new CdpEndpointError('EPORT', `${DEVTOOLS_PORT_FILE} does not start with a decimal port`, portLine.slice(0, 32))
  }
  const port = Number(portLine)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new CdpEndpointError('EPORT', `${DEVTOOLS_PORT_FILE} carries an out-of-range port`, String(port))
  }
  if (!BROWSER_WS_PATH.test(wsPath)) {
    throw new CdpEndpointError(
      'EPATH',
      `${DEVTOOLS_PORT_FILE} does not carry a browser-level devtools path`,
      wsPath.slice(0, 96),
    )
  }
  return { port, wsPath, wsUrl: `ws://127.0.0.1:${String(port)}${wsPath}` }
}

/**
 * Waits, bounded, for the browser to publish its own devtools port.
 *
 * Returns only after the file parses. A partially written file (port line
 * present, path line not yet flushed) is a "not yet", not an error. If the
 * browser process dies first, that is reported immediately instead of burning
 * the whole budget - and there is deliberately no fallback to a guessed port.
 */
export async function waitForDevToolsActivePort(options = {}) {
  const profileDir = options.profileDir
  if (typeof profileDir !== 'string' || profileDir === '') {
    throw new CdpEndpointError('ENOPROFILE', 'no profile directory to read the devtools port from')
  }
  const file = join(profileDir, DEVTOOLS_PORT_FILE)
  const timeoutMs = options.timeoutMs ?? TIMEOUTS.launchBudgetMs
  const intervalMs = options.intervalMs ?? 150
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now
  const readFile = options.readFile ?? (target => readFileSync(target, 'utf8'))
  const isExited = options.isBrowserExited ?? (() => false)
  const deadline = now() + timeoutMs
  let lastError = new CdpEndpointError('ENOENT', `${DEVTOOLS_PORT_FILE} has not been written yet`)

  for (;;) {
    if (isExited() === true) {
      throw new CdpEndpointError(
        'EEXITED',
        'the browser exited before it published a devtools endpoint',
        lastError.message,
      )
    }
    try {
      return parseDevToolsActivePort(readFile(file))
    } catch (error) {
      lastError = error instanceof CdpEndpointError
        ? error
        : new CdpEndpointError('EREAD', `could not read ${DEVTOOLS_PORT_FILE}`, String(error?.message ?? error))
    }
    if (now() >= deadline) break
    await sleep(intervalMs)
  }

  const timeout = new CdpEndpointError(
    'ETIMEDOUT',
    `${DEVTOOLS_PORT_FILE} was not usable within ${String(timeoutMs)} ms`,
    lastError.message,
  )
  timeout.lastErrorCode = lastError.code
  throw timeout
}

/**
 * Accepts a websocket URL only when it points at the verified loopback port and
 * at the endpoint kind the caller expects. Nothing is connected before this
 * passes, so a hostile or stale advertisement cannot be reached.
 */
export function assertOwnedWsUrl(rawUrl, expectedPort, options = {}) {
  const kind = options.kind === 'page' ? 'page' : 'browser'
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    throw new CdpEndpointError('EENDPOINT', 'the advertised devtools websocket is not a valid URL')
  }
  if (url.protocol !== 'ws:') {
    throw new CdpEndpointError('EENDPOINT', `the devtools websocket uses ${url.protocol} instead of ws:`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new CdpEndpointError('EENDPOINT', 'the devtools websocket carries credentials in its URL')
  }
  if (url.hostname !== '127.0.0.1') {
    throw new CdpEndpointError('EENDPOINT', `the devtools websocket points at ${url.hostname}, not 127.0.0.1`)
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port !== expectedPort) {
    throw new CdpEndpointError(
      'EENDPOINT',
      `the devtools websocket port ${url.port === '' ? '(none)' : url.port} is not the verified port ${String(expectedPort)}`,
    )
  }
  const pattern = kind === 'page' ? PAGE_WS_PATH : BROWSER_WS_PATH
  if (!pattern.test(url.pathname)) {
    throw new CdpEndpointError('EENDPOINT', `the devtools websocket path is not a ${kind}-level endpoint`, url.pathname.slice(0, 96))
  }
  return url
}

/**
 * Resolves the browser's *own* devtools endpoint and opens the two connections
 * the run needs: one browser-level (for `Browser.close`) and one page-level
 * (for navigation and DOM work).
 *
 * Ownership evidence, in order:
 *   1. the port comes from `DevToolsActivePort` inside the profile directory
 *      this process created with a unique name - not from a random guess, so a
 *      foreign CDP listener can never be "found" by accident;
 *   2. that file also names the browser-level websocket path, which is checked
 *      for protocol, host, port and shape;
 *   3. the browser endpoint is asked for `Target.getTargets` and must already
 *      know the page target taken from `/json/list` on the same port - the two
 *      connections therefore describe one browser, not two.
 *
 * If any step fails, the sockets opened so far are closed and nothing is sent
 * to the endpoint: in particular no navigation, no DOM evaluation and no
 * `Browser.close`.
 */
export async function connectVerifiedBrowser(options = {}) {
  const connect = options.connect ?? connectCdp
  const fetchJson = options.fetchJson ?? fetchJsonWithTimeout
  const commandTimeoutMs = options.commandTimeoutMs ?? TIMEOUTS.cdpCommandMs
  const httpProbeMs = options.httpProbeMs ?? TIMEOUTS.httpProbeMs

  const active = await waitForDevToolsActivePort(options)
  const browserUrl = assertOwnedWsUrl(active.wsUrl, active.port, { kind: 'browser' })
  const browserCdp = await connect(browserUrl.toString())
  let pageCdp = null

  try {
    const version = await browserCdp.send('Browser.getVersion', {}, { timeoutMs: commandTimeoutMs })
    const targets = await browserCdp.send('Target.getTargets', {}, { timeoutMs: commandTimeoutMs })
    if (!Array.isArray(targets?.targetInfos)) {
      throw new CdpEndpointError('EENDPOINT', 'the browser endpoint reported no target list')
    }

    const pages = await fetchJson(`http://127.0.0.1:${String(active.port)}/json/list`, { timeoutMs: httpProbeMs })
    if (!Array.isArray(pages)) {
      throw new CdpEndpointError('ENOPAGE', 'the verified devtools port did not return a target array')
    }
    const page = pages.find(item => item?.type === 'page')
    if (page === undefined) {
      throw new CdpEndpointError('ENOPAGE', 'the verified devtools port exposes no page target')
    }

    const pageUrl = assertOwnedWsUrl(page.webSocketDebuggerUrl, active.port, { kind: 'page' })
    const pageId = pageUrl.pathname.slice('/devtools/page/'.length)
    if (page.id !== undefined && String(page.id) !== pageId) {
      throw new CdpEndpointError(
        'EENDPOINT',
        'the page target id disagrees with its own websocket path',
        `${String(page.id)} !== ${pageId}`,
      )
    }
    if (!targets.targetInfos.some(info => String(info?.targetId) === pageId)) {
      throw new CdpEndpointError(
        'EENDPOINT',
        'the browser endpoint does not know the page target it is supposed to drive',
        pageId,
      )
    }

    pageCdp = await connect(pageUrl.toString())
    return { browserCdp, pageCdp, port: active.port, pageId, version }
  } catch (error) {
    try {
      browserCdp.close?.()
    } catch {
      // the socket may already be gone; the original failure is what matters
    }
    try {
      pageCdp?.close?.()
    } catch {
      // nothing was connected yet
    }
    throw error
  }
}

const SHUTDOWN_DEFAULTS = {
  isAlive: isProcessAlive,
  waitExit: waitForExit,
  terminate: terminateProcessTree,
  reap: reapProfileOwners,
  findOwners: findProcessesUsingDir,
  assertSafe: assertSafeProfileDir,
  removeDir: removeDirWithRetry,
  exists: existsSync,
}

/**
 * Idempotent shutdown: close the browser, reclaim every process that owns this
 * profile, then delete the directory - never the other way round.
 *
 * Order matters and is the whole point of this function:
 *   1. ask the browser to exit over CDP while the socket is still open;
 *   2. wait (bounded) for the tracked PID, then fall back to a tree kill of
 *      that exact PID - never by image name;
 *   3. re-enumerate owners of *this* directory and reclaim them, because a
 *      browser that left the process tree is not reachable by `taskkill /T`;
 *   4. only delete when no owner is left; if ownership cannot be determined
 *      (enumeration failed) keep the directory and say so;
 *   5. gate the delete through `assertSafeProfileDir`, retry with backoff, and
 *      re-check for a directory recreated by a slow-exiting browser.
 *
 * `session.reason` is copied into the report; calling twice returns the same
 * report, so a signal handler and the `finally` block cannot double-shut down.
 */
export async function shutdownLayoutSession(session, overrides = {}) {
  const d = { ...SHUTDOWN_DEFAULTS, ...overrides }
  const prefix = overrides.prefix ?? LAYOUT_PROFILE_PREFIX
  const report = {
    reason: session.reason ?? '',
    graceful: null,
    forced: null,
    reclaimed: null,
    directory: null,
    lingering: [],
    recreated: 0,
  }

  if (session.browserPid !== null && session.browserPid !== undefined && d.isAlive(session.browserPid)) {
    if (typeof session.requestBrowserClose === 'function') {
      try {
        await session.requestBrowserClose()
        report.graceful = { ok: true }
      } catch (error) {
        report.graceful = { ok: false, detail: sanitizeText(error?.message ?? error) }
      }
    }
    if (!d.waitExit(session.browserPid, TIMEOUTS.shutdownGracefulMs)) {
      report.forced = d.terminate(session.browserPid, { expectedProfileDir: session.profileDir })
      d.waitExit(session.browserPid, TIMEOUTS.shutdownForceMs)
    }
  }

  try {
    session.cdp?.close()
  } catch {
    // the socket may already be gone; the profile cleanup below still runs
  }
  try {
    session.browserCdp?.close()
  } catch {
    // `Browser.close` already took the browser-level socket down with it
  }

  if (session.profileDir === null || session.profileDir === undefined) return report
  if (session.keepProfile === true) {
    report.directory = { removed: false, kept: true }
    return report
  }

  const reclaim = d.reap(session.profileDir, {
    prefix,
    root: session.profileRoot,
    attempts: TIMEOUTS.reapAttempts,
    delayMs: TIMEOUTS.reapDelayMs,
  })
  report.reclaimed = reclaim
  if (reclaim?.ok !== true) {
    report.lingering = reclaim?.remaining ?? []
    report.directory = {
      removed: false,
      blocked: reclaim?.unknown === true ? 'process ownership unknown' : 'a browser still owns the profile',
      detail: reclaim?.lastError ?? reclaim?.rejected ?? null,
    }
    return report
  }

  if (!d.exists(session.profileDir)) {
    report.directory = { removed: true, attemptCount: 0, attempts: [] }
    return report
  }

  let safeDir
  try {
    safeDir = d.assertSafe(session.profileDir, session.profileRoot, { prefix })
  } catch (error) {
    report.directory = { removed: false, rejected: error.message }
    return report
  }

  let removal = d.removeDir(safeDir)
  let pass = 0
  while (pass < TIMEOUTS.reappearPasses && !(removal.removed === true && !d.exists(safeDir))) {
    pass += 1
    report.recreated = pass
    // A surviving browser can recreate the directory between two attempts, so
    // reclaim again before the next delete. One attempt keeps this bounded.
    const again = d.reap(safeDir, { prefix, root: session.profileRoot, attempts: 1, delayMs: 0 })
    if (again?.ok !== true) {
      report.lingering = again?.remaining ?? []
      break
    }
    removal = d.removeDir(safeDir)
  }

  report.directory = removal
  if (removal?.removed !== true) {
    const owners = d.findOwners(safeDir)
    if (owners?.ok === true && owners.pids.length > 0) report.lingering = owners.pids
  }
  return report
}

/**
 * Memoises one shutdown for the lifetime of a process.
 *
 * Both the signal handlers and the `finally` block need to clean up. This
 * wrapper makes the second call return the first call's promise, so the cleanup
 * never runs twice - double-running would double-kill and double-delete.
 */
export function createShutdownRunner(session, overrides = {}, onReport) {
  let promise = null
  return {
    run(reason) {
      if (promise === null) {
        session.reason = reason
        promise = shutdownLayoutSession(session, overrides).then((report) => {
          if (typeof onReport === 'function') onReport(report)
          return report
        })
      }
      return promise
    },
    get started() {
      return promise !== null
    },
  }
}

/**
 * Synchronous last-resort reclamation, used from the `exit` event where no
 * promise can be awaited.
 *
 * It applies the *same* safety rules as `shutdownLayoutSession`, only with
 * synchronous primitives:
 *   1. the tracked PID is terminated with a profile-directory guard;
 *   2. ownership of the profile is re-derived from the command lines - and if
 *      that cannot be read, the directory is kept, because "unknown" is not
 *      "free" (this is the difference between a leaked directory and deleting
 *      a profile a browser is still using);
 *   3. owners that refuse termination, or that are still there afterwards, also
 *      keep the directory;
 *   4. the delete is gated by `assertSafeProfileDir` (real parent, no symlink,
 *      this tool's namespace) and bounded by `removeDirWithRetry`;
 *   5. `--keep-profile` never deletes.
 *
 * Every step reports instead of throwing, and no failure is swallowed into an
 * empty catch: the exit handler is the last place a diagnostic can be printed.
 */
export function syncReapProfile(session, overrides = {}) {
  const d = { ...SHUTDOWN_DEFAULTS, ...overrides }
  const prefix = overrides.prefix ?? LAYOUT_PROFILE_PREFIX
  const report = {
    reason: session.reason === '' || session.reason === undefined ? 'exit' : String(session.reason),
    graceful: null,
    forced: null,
    reclaimed: null,
    directory: null,
    lingering: [],
    recreated: 0,
  }
  const dir = session.profileDir
  if (dir === null || dir === undefined) return report

  const describeError = error => sanitizeText(String(error?.message ?? error))

  if (session.browserPid !== null && session.browserPid !== undefined) {
    try {
      if (d.isAlive(session.browserPid)) {
        report.forced = d.terminate(session.browserPid, { expectedProfileDir: dir })
        d.waitExit?.(session.browserPid, TIMEOUTS.shutdownForceMs)
      }
    } catch (error) {
      report.forced = { ok: false, detail: describeError(error) }
    }
  }

  let owners
  try {
    owners = d.findOwners(dir)
  } catch (error) {
    owners = { ok: false, pids: [], detail: describeError(error) }
  }
  if (owners?.ok !== true) {
    report.directory = {
      removed: false,
      blocked: 'process ownership unknown',
      detail: owners?.detail ?? null,
    }
    return report
  }

  const terminated = []
  for (const pid of owners.pids) {
    try {
      terminated.push({
        pid,
        ...d.terminate(pid, { expectedProfileDir: dir, requireIdentity: true }),
      })
    } catch (error) {
      terminated.push({ pid, ok: false, detail: describeError(error) })
    }
  }
  report.reclaimed = { ok: terminated.every(entry => entry.ok === true), terminated }
  const failed = terminated.filter(entry => entry.ok !== true)
  if (failed.length > 0) {
    // "Kill failed" is not "no owner": the directory stays.
    report.lingering = failed.map(entry => entry.pid)
    report.directory = {
      removed: false,
      blocked: 'termination failed for an owning process',
      detail: failed[0]?.detail ?? null,
    }
    return report
  }

  let after
  try {
    after = d.findOwners(dir)
  } catch (error) {
    after = { ok: false, pids: owners.pids, detail: describeError(error) }
  }
  if (after?.ok !== true) {
    report.directory = { removed: false, blocked: 'process ownership unknown', detail: after?.detail ?? null }
    return report
  }
  if (after.pids.length > 0) {
    report.lingering = after.pids
    report.directory = { removed: false, blocked: 'a browser still owns the profile' }
    return report
  }
  if (session.keepProfile === true) {
    report.directory = { removed: false, kept: true }
    return report
  }

  let safeDir
  try {
    safeDir = d.assertSafe(dir, session.profileRoot, { prefix })
  } catch (error) {
    report.directory = { removed: false, rejected: error.message }
    return report
  }

  const removal = d.removeDir(safeDir, { attempts: 3, baseDelayMs: 100, maxDelayMs: 400 })
  report.directory = removal
  if (removal?.removed !== true) {
    try {
      const stragglers = d.findOwners(safeDir)
      if (stragglers?.ok === true && stragglers.pids.length > 0) report.lingering = stragglers.pids
    } catch (error) {
      report.directory = { ...removal, detail: describeError(error) }
    }
  }
  return report
}

/** Exit codes owned by the supervisor; a signal and a crash must differ. */
export const LIFECYCLE_EXIT_CODES = { signal: 130, failure: 1 }

/**
 * Wires `exit`, `SIGINT`, `SIGTERM`, `SIGHUP`, `uncaughtException` and
 * `unhandledRejection` to one shutdown, with every dependency injectable so the
 * behaviour can be tested without touching the real process.
 *
 * Guarantees:
 *   - the shutdown runs at most once per process, whatever the order and number
 *     of signals - the second SIGINT is ignored instead of re-entering;
 *   - the exit code is deterministic: `130` for a signal, `1` for a crash, even
 *     when the shutdown itself rejects;
 *   - the synchronous `exit` fallback runs only when the asynchronous cleanup
 *     did not complete (`isComplete()`), so a completed shutdown is never
 *     repeated;
 *   - the fallback is synchronous by contract - it is never awaited, because
 *     `exit` cannot.
 */
export function createLifecycleController(options = {}) {
  const proc = options.process ?? process
  const exit = options.exit ?? (code => proc.exit(code))
  const shutdown = options.shutdown
  const syncReap = options.syncReap ?? (() => undefined)
  const isComplete = options.isComplete ?? (() => false)
  const log = options.log ?? { info: () => undefined, error: () => undefined }

  let closing = null
  let exits = 0

  const leave = (code) => {
    exits += 1
    exit(code)
  }

  const begin = (reason, code) => {
    if (closing !== null) {
      log.info(`already cleaning up (${String(closing)}); ignoring ${reason}`)
      return
    }
    closing = reason
    Promise.resolve()
      .then(() => shutdown(reason))
      .then(
        () => leave(code),
        (error) => {
          log.error(`cleanup failed (${reason}): ${sanitizeText(String(error?.message ?? error))}`)
          leave(code)
        },
      )
  }

  const handlers = {
    exit: () => {
      if (isComplete() === true) return
      try {
        syncReap()
      } catch (error) {
        log.error(`exit-time cleanup failed: ${sanitizeText(String(error?.message ?? error))}`)
      }
    },
    signals: Object.fromEntries(
      ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => [signal, () => {
        log.info(`received ${signal} - cleaning up`)
        begin(`signal:${signal}`, LIFECYCLE_EXIT_CODES.signal)
      }]),
    ),
    uncaughtException: (error) => {
      log.error(`uncaught exception: ${String(error?.stack ?? error)}`)
      begin('uncaughtException', LIFECYCLE_EXIT_CODES.failure)
    },
    unhandledRejection: (reason) => {
      log.error(`unhandled rejection: ${String(reason?.stack ?? reason)}`)
      begin('unhandledRejection', LIFECYCLE_EXIT_CODES.failure)
    },
  }

  const api = {
    handlers,
    install() {
      proc.on('exit', handlers.exit)
      for (const [signal, handler] of Object.entries(handlers.signals)) proc.on(signal, handler)
      proc.on('uncaughtException', handlers.uncaughtException)
      proc.on('unhandledRejection', handlers.unhandledRejection)
      return api
    },
    get closing() {
      return closing
    },
    get exitCount() {
      return exits
    },
  }
  return api
}

/** One-line, log-ready summary of a shutdown report. */
export function describeShutdown(report) {
  if (report === null || report === undefined) return 'no shutdown report'
  const parts = [report.reason === '' ? 'cleanup' : `cleanup (${report.reason})`]
  if (report.graceful !== null) parts.push(`cdp-close=${report.graceful.ok === true ? 'ok' : 'failed'}`)
  if (report.forced !== null) parts.push(`tree-kill=${report.forced?.ok === true ? 'ok' : 'incomplete'}`)
  if (report.reclaimed !== null) parts.push(`reclaimed=${String(report.reclaimed?.terminated?.length ?? 0)}`)
  const directory = report.directory
  if (directory === null) parts.push('directory=untouched')
  else if (directory.kept === true) parts.push('directory=kept(--keep-profile)')
  else if (directory.removed === true) parts.push(`directory=removed(attempts=${String(directory.attemptCount)})`)
  else if (directory.rejected !== undefined) parts.push(`directory=rejected(${directory.rejected})`)
  else if (directory.blocked !== undefined) parts.push(`directory=kept(${directory.blocked})`)
  else {
    const error = directory.lastError
    parts.push(`directory=FAILED(${String(directory.attemptCount)} attempts, ${String(error?.code)} ${String(error?.message ?? '').slice(0, 120)})`)
  }
  if (report.recreated > 0) parts.push(`recreated=${String(report.recreated)}`)
  if (report.lingering.length > 0) parts.push(`lingering-pid=${report.lingering.join(',')}`)
  return parts.join(' ')
}
