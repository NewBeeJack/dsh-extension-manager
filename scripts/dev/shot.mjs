/**
 * Headless-Chrome screenshot + click helper over the Chrome DevTools Protocol.
 *
 * Verification-only tool: opens the locally running DSH Web GUI with the
 * owner-minted browser-session cookie, performs a scripted click path, and
 * saves screenshots. Built on Node's global WebSocket and fetch, so no
 * third-party browser driver is installed.
 *
 * Usage:
 *   node shot.mjs --cookie <cookie.json> --out <dir> --steps <steps.json>
 *
 * Steps file: an array of { "eval": "<js>" } | { "wait": ms } |
 * { "shot": "name" } | { "size": [w,h] } operations, executed in order.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

const cookie = JSON.parse(readFileSync(arg('cookie'), 'utf8'))
const outDir = arg('out', '.')
const steps = JSON.parse(readFileSync(arg('steps'), 'utf8'))
const chromePath = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const port = Number(arg('port', '0')) || (20000 + Math.floor(Math.random() * 20000))
// Chrome profiles are throw-away state: keep them out of the workspace and out
// of the evidence directories.
const profileDir = join(tmpdir(), `dsh-em-chrome-${String(Date.now())}-${String(Math.floor(Math.random() * 10000))}`)
mkdirSync(outDir, { recursive: true })
mkdirSync(profileDir, { recursive: true })

const chrome = spawn(chromePath, [
  '--headless=new',
  // A random debugging port per run keeps concurrent runs from attaching to a
  // stale browser left behind by a previous invocation.
  `--remote-debugging-port=${String(port)}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--hide-scrollbars',
  '--window-size=1600,1000',
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForDevtools(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
      if (response.ok) return await response.json()
    } catch {}
    await sleep(200)
  }
  throw new Error(`Chrome DevTools did not become reachable on port ${String(port)}`)
}

let pageWs
try {
  await waitForDevtools()
  const pages = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
  const page = pages.find(item => item.type === 'page')
  if (page === undefined) throw new Error('no page target')
  pageWs = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    pageWs.addEventListener('open', resolve, { once: true })
    pageWs.addEventListener('error', reject, { once: true })
  })

  let nextId = 0
  const pending = new Map()
  const consoleLines = []
  pageWs.addEventListener('message', (event) => {
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
    pageWs.send(JSON.stringify({ id, method, params }))
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
    console.log(`[shot] ${path}`)
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
    await evaluate("location.reload()")
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
      if (value !== undefined) console.log(`[eval] ${JSON.stringify(value)}`)
      continue
    }
    if (step.shot !== undefined) { await screenshot(step.shot); continue }
    if (step.method !== undefined) {
      // Direct CDP escape hatch for network/emulation checks in verification runs.
      const value = await send(step.method, step.params ?? {})
      if (value !== undefined) console.log(`[cdp] ${step.method}`)
      continue
    }
    throw new Error(`unknown step ${JSON.stringify(step)}`)
  }

  if (consoleLines.length > 0) {
    writeFileSync(join(outDir, 'console.log'), consoleLines.join('\n'), 'utf8')
    console.log(`[console] ${consoleLines.length} lines -> console.log`)
  }
} catch (error) {
  console.error('[failed]', error)
  process.exitCode = 1
} finally {
  try { pageWs?.close() } catch {}
  chrome.kill()
  await sleep(300)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
