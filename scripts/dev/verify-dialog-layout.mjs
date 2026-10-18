/**
 * Automated dialog-layout regression check for the Extension Manager.
 *
 * Drives the real DSH Web UI through CDP, opens every Extension Manager dialog
 * (diagnostics, extension details, update plan in its complete/loading/error
 * states), and measures the geometry the brief cares about:
 *
 *   T = dialog top edge → top of the first visible title text
 *   B = bottom edge of the lowest action button → dialog bottom edge
 *
 * Required for every dialog: T ≈ 24px, B ≈ 24px, |T − B| ≤ 4px, the footer
 * keeps its natural height inside the card, the scrollable body never
 * overlaps the footer, and the whole card stays inside the viewport.
 *
 * It repeats the measurements across viewport sizes (zoom proxies) plus a
 * dark-scheme pass and writes screenshots + a JSON report. Exit code is
 * non-zero when any assertion fails.
 *
 * Usage:
 *   node scripts/dev/verify-dialog-layout.mjs \
 *     --url "http://127.0.0.1:3080/?token=..." \
 *     --out "C:/.../_test/layout-report"
 *
 *   --sizes "1920x1080,1536x864,1366x768,1093x614,911x512,683x384"
 *   --cookie <cookie.json>   optional; a token URL is enough
 *   --skip-update            skip update-dialog flows (diagnostics/details only)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const launchUrl = arg('url')
if (launchUrl === undefined || launchUrl === '') {
  console.error('usage: node verify-dialog-layout.mjs --url <token-url> [--out dir] [--sizes ...] [--cookie file] [--skip-update]')
  process.exit(2)
}
const origin = new URL(launchUrl).origin
const outDir = arg('out', join(tmpdir(), 'dsh-em-dialog-layout'))
const sizes = arg('sizes', '1920x1080,1536x864,1366x768,1093x614,911x512,683x384')
  .split(',')
  .map(text => text.trim())
  .filter(Boolean)
  .map((text) => { const [w, h] = text.split('x').map(Number); return { width: w, height: h, label: text } })
const skipUpdate = process.argv.includes('--skip-update')
mkdirSync(outDir, { recursive: true })
const chromePath = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe')
const port = 20000 + Math.floor(Math.random() * 20000)
const profileDir = join(tmpdir(), `dsh-em-layout-${String(Date.now())}-${String(Math.floor(Math.random() * 10000))}`)
mkdirSync(profileDir, { recursive: true })

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const failures = []
const results = []

/** Assert one measured dialog and record the result. */
function assertGeometry(label, value) {
  const problems = []
  const T = value.T
  const B = value.B
  if (T === null || T === undefined) problems.push('title not found')
  else if (T < 20 || T > 28) problems.push(`T=${T.toFixed(1)} outside 24±4`)
  if (B === null || B === undefined) problems.push('action buttons not found')
  else if (B < 20 || B > 28) problems.push(`B=${B.toFixed(1)} outside 24±4`)
  if (T !== null && B !== null && Math.abs(T - B) > 4) problems.push(`|T-B|=${Math.abs(T - B).toFixed(1)} > 4`)
  if (value.footerInside !== true) problems.push('footer extends outside the card')
  if (value.noOverlap !== true) problems.push('scrollable body overlaps the footer')
  if (value.inViewport !== true) problems.push('dialog extends outside the viewport')
  if (value.contentScrolls === true && value.doubleScroll === true) problems.push('double scroll containers')
  const passed = problems.length === 0
  results.push({ label, size: value.size, passed, T, B, problems, detail: value })
  if (!passed) failures.push({ label, problems, T, B })
  console.log(`[layout] ${passed ? 'PASS' : 'FAIL'} ${label} T=${T?.toFixed?.(1) ?? '?'} B=${B?.toFixed?.(1) ?? '?'}${problems.length ? ` — ${problems.join('; ')}` : ''}`)
  return passed
}

let chrome
let ws
try {
  chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${String(port)}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1920,1080',
    'about:blank',
  ], { stdio: 'ignore' })

  const deadline = Date.now() + 25_000
  let version
  let page
  while (Date.now() < deadline) {
    try {
      version = await (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).json()
      const pages = await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()
      page = pages.find(item => item.type === 'page')
      if (version !== undefined && page !== undefined) break
    } catch {}
    await sleep(200)
  }
  if (page === undefined) throw new Error('Chrome DevTools did not become reachable')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let nextId = 0
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === undefined) return
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails !== undefined) throw new Error(result.exceptionDetails.text)
    return result.result?.value
  }
  const screenshot = async (name) => {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(shot.data, 'base64'))
  }
  const setSize = async (size) => {
    await send('Emulation.setDeviceMetricsOverride', { width: size.width, height: size.height, deviceScaleFactor: 1, mobile: false })
    await sleep(350)
  }
  const setDark = async (dark) => {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    await sleep(400)
  }

  /** The launch token is single-use: after the first exchange reuse the cookie. */
  let launchConsumed = false
  const navigationUrl = (url) => {
    const carriesToken = /[?&]token=/u.test(url)
    if (!carriesToken) return url
    if (launchConsumed) return origin + '/'
    launchConsumed = true
    return url
  }

  /** Poll one browser-side predicate until it is truthy. */
  const waitFor = async (expression, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expression) === true) return true
      } catch {}
      await sleep(300)
    }
    return false
  }

  /** Open the Extension Manager settings section from a fresh page load. */
  const openManager = async (url) => {
    const target = navigationUrl(url)
    await evaluate(`location.href = ${JSON.stringify(target)}`)
    await sleep(1500)
    try { await evaluate('location.reload()') } catch { /* the execution context is replaced by the reload */ }
    await sleep(2200)
    console.log('[layout] navigated to', target, '→', await evaluate('location.href'))
    const accountReady = await waitFor(`(()=>Boolean(document.querySelector('[aria-label="Account menu"]')||[...document.querySelectorAll('button')].find(b=>/account|账户|菜单/i.test(b.getAttribute('aria-label')||''))))()`, 20000)
    if (!accountReady) {
      console.log('[layout] wait: account menu not found; debug:', JSON.stringify({
        buttons: await evaluate("document.querySelectorAll('button').length"),
        labels: await evaluate("[...document.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).slice(-8)"),
        text: await evaluate("document.body.innerText.slice(0,80)"),
        direct: await evaluate("Boolean(document.querySelector('[aria-label=\"账户菜单\"]'))"),
      }))
      return false
    }
    await evaluate(`(()=>{const a=document.querySelector('[aria-label="Account menu"]')||[...document.querySelectorAll('button')].find(b=>/account|账户|菜单/i.test(b.getAttribute('aria-label')||''));a&&a.click();return 'ok'})()`)
    await sleep(600)
    const settingsReady = await waitFor(`(()=>Boolean([...document.querySelectorAll('button')].find(x=>{const t=(x.textContent||'').trim();const c=t.split(' ').join('');return c.startsWith('设置Ctrl')||c.startsWith('SettingsCtrl')||c==='设置'||c==='Settings'})))()`, 8000)
    if (!settingsReady) { console.log('[layout] wait: settings item not found'); return false }
    await evaluate(`(()=>{const b=[...document.querySelectorAll('button')].find(x=>{const t=(x.textContent||'').trim();const c=t.split(' ').join('');return c.startsWith('设置Ctrl')||c.startsWith('SettingsCtrl')||c==='设置'||c==='Settings'});b&&b.click();return 'ok'})()`)
    await sleep(1100)
    const sectionReady = await waitFor(`(()=>Boolean([...document.querySelectorAll('[role=dialog] nav button')].find(x=>(x.textContent||'').includes('扩展管理器'))))()`, 10000)
    if (!sectionReady) { console.log('[layout] wait: manager nav section not found'); return false }
    await evaluate(`(()=>{const b=[...document.querySelectorAll('[role=dialog] nav button')].find(x=>(x.textContent||'').includes('扩展管理器'));b&&b.click();return 'ok'})()`)
    const managerReady = await waitFor(`(()=>Boolean([...document.querySelectorAll('[role=dialog] button')].find(x=>/检查全部更新/.test(x.textContent||''))))()`, 15000)
    if (!managerReady) console.log('[layout] wait: manager toolbar not visible')
    return managerReady
  }

  /** Whether the Extension Manager settings section is currently visible. */
  const managerVisible = () => evaluate(`(()=>[...document.querySelectorAll('[role=dialog] button')].some(b=>/检查全部更新/.test(b.textContent||'')))()`)

  /** Reopen the manager when a stray close emptied the settings panel. */
  const ensureManager = async () => {
    if (await managerVisible() === true) return true
    console.log('[layout] reopening the settings section')
    return await openManager(origin + '/')
  }

  /** Click one button by visible text/aria label, returned for logging. */
  const clickButton = async (matcherSource) => {
    const result = await evaluate(`(()=>{const b=[...document.querySelectorAll('[role=dialog] button, button')].find(x=>(${matcherSource}));if(!b)return 'not-found:'+[...document.querySelectorAll('[role=dialog] button')].map(x=>(x.getAttribute('aria-label')||x.textContent||'').trim()).filter(Boolean).slice(0,25).join('|');b.click();return 'clicked'})()`)
    if (result !== 'clicked') console.log('[layout] click miss:', String(result).slice(0, 300))
    return result
  }

  /** Click one button inside the topmost dialog carrying the class fragment. */
  const clickInDialog = async (classFragment, matcherSource) => {
    const result = await evaluate(`(()=>{
      const dialogs=[...document.querySelectorAll('[role=dialog]')]
      const d=[...dialogs].reverse().find(x=>String(x.className).includes(${JSON.stringify(classFragment)}))
      if(!d)return 'no-dialog'
      const b=[...d.querySelectorAll('button')].find(x=>(${matcherSource}))
      if(!b)return 'not-found:'+[...d.querySelectorAll('button')].map(x=>(x.getAttribute('aria-label')||x.textContent||'').trim()).filter(Boolean).slice(0,20).join('|')
      b.click()
      return 'clicked'
    })()`)
    if (result !== 'clicked') console.log('[layout] in-dialog click miss:', String(result).slice(0, 240))
    return result
  }

  /** Press Escape (closes the topmost modal). */
  const pressEscape = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 })
    await sleep(450)
  }

  /** Measure the topmost dialog that matches the given CSS-class fragment. */
  const measure = async (classFragment, label) => {
    const raw = await evaluate(`(()=>{
      const dialogs=[...document.querySelectorAll('[role=dialog]')]
      const d=[...dialogs].reverse().find(x=>String(x.className).includes(${JSON.stringify(classFragment)}))
      if(!d)return JSON.stringify({missing:true, dialogs:dialogs.map(x=>String(x.className))})
      const r=d.getBoundingClientRect()
      const shell = d.querySelector('.em-modalScroll')
      const content = shell ?? d.querySelector('.em-detailBody')
      const footer = shell ? d.lastElementChild : d.querySelector('.em-detailFooter')
      const title = d.querySelector('.em-detailTitle') ?? d.querySelector('h2')
      const buttons = footer ? [...footer.querySelectorAll('button')] : []
      const lastButton = buttons[buttons.length-1]
      const cr = content.getBoundingClientRect()
      const fr = footer.getBoundingClientRect()
      const allOverflow = [...d.querySelectorAll('*')].filter(el=>{
        const cs=getComputedStyle(el)
        return (cs.overflowY==='auto'||cs.overflowY==='scroll') && el.scrollHeight>el.clientHeight+1
      })
      return JSON.stringify({
        className:String(d.className),
        width:r.width,height:r.height,top:r.top,left:r.left,
        T:title?title.getBoundingClientRect().top-r.top:null,
        B:lastButton?r.bottom-lastButton.getBoundingClientRect().bottom:null,
        gap:getComputedStyle(d).gap,
        footerPadding:footer?getComputedStyle(footer).padding:null,
        footerInside:footer?fr.bottom<=r.bottom+0.5:false,
        noOverlap:content?cr.bottom<=fr.top+0.5:false,
        inViewport:r.top>=-0.5&&r.left>=-0.5&&r.bottom<=innerHeight+0.5&&r.right<=innerWidth+0.5,
        contentScrolls:content?content.scrollHeight>content.clientHeight+1:false,
        doubleScroll:allOverflow.length>1,
        buttonCount:buttons.length,
        innerWidth,innerHeight,
      })
    })()`)
    const value = JSON.parse(raw)
    if (value.missing === true) {
      failures.push({ label, problems: ['dialog not found'], dialogs: value.dialogs })
      results.push({ label, passed: false, T: null, B: null, problems: ['dialog not found'], detail: value })
      console.log(`[layout] FAIL ${label} — dialog not found (${String(value.dialogs).slice(0, 160)})`)
      return false
    }
    value.size = `${String(value.innerWidth)}x${String(value.innerHeight)}`
    return assertGeometry(label, value)
  }

  /**
   * Scroll the active dialog body to its end and verify the last piece of text
   * is fully inside the visible scrollport (nothing hidden behind the footer).
   */
  const checkLastLine = async (classFragment, label, screenshotName) => {
    const raw = await evaluate(`(()=>{
      const dialogs=[...document.querySelectorAll('[role=dialog]')]
      const d=[...dialogs].reverse().find(x=>String(x.className).includes(${JSON.stringify(classFragment)}))
      if(!d)return JSON.stringify({missing:true})
      const content=d.querySelector('.em-modalScroll')||d.querySelector('.em-detailBody')
      if(!content)return JSON.stringify({missing:true})
      content.scrollTop=content.scrollHeight
      const leaves=[...content.querySelectorAll('*')].filter(el=>el.children.length===0&&(el.textContent||'').trim()!=='')
      const last=leaves[leaves.length-1]
      if(!last)return JSON.stringify({missing:true})
      const cr=content.getBoundingClientRect()
      const lr=last.getBoundingClientRect()
      return JSON.stringify({
        scrollable:content.scrollHeight>content.clientHeight+1,
        scrolledToEnd:content.scrollTop+content.clientHeight>=content.scrollHeight-1,
        lastText:(last.textContent||'').trim().slice(0,80),
        fullyVisible:lr.top>=cr.top-1&&lr.bottom<=cr.bottom+1,
      })
    })()`)
    const value = JSON.parse(raw)
    const problems = []
    if (value.missing === true) problems.push('body not found')
    else {
      if (value.scrolledToEnd !== true) problems.push('could not scroll to the end')
      if (value.fullyVisible !== true) problems.push('last line is clipped or hidden')
    }
    const passed = problems.length === 0
    results.push({ label, passed, T: null, B: null, problems, detail: value })
    if (!passed) failures.push({ label, problems })
    console.log(`[layout] ${passed ? 'PASS' : 'FAIL'} ${label} — last="${value.lastText ?? ''}"${problems.length ? ` (${problems.join('; ')})` : ''}`)
    if (screenshotName !== undefined) await screenshot(screenshotName)
    return passed
  }

  /** Close whatever is open (dialog or settings) until the manager page shows. */
  const closeDialogs = async () => {
    for (let index = 0; index < 3; index += 1) {
      const open = await evaluate(`document.querySelectorAll('[role=dialog]').length`)
      if (open === 0) return
      await pressEscape()
    }
  }

  // ---------------------------------------------------------------- boot
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')
  const cookiePath = arg('cookie')
  if (cookiePath !== undefined) {
    const cookie = JSON.parse(readFileSync(cookiePath, 'utf8'))
    await send('Network.setCookie', {
      name: cookie.name,
      value: cookie.value,
      url: `${origin}/`,
    })
    console.log('[layout] browser-session cookie installed for', origin)
  }
  const managerReady = await openManager(launchUrl)
  if (managerReady !== true) throw new Error('Extension Manager settings section did not open')

  // ------------------------------------------------- diagnostics per size
  for (const size of sizes) {
    await setSize(size)
    if (results.length > 0) {
      console.log('[layout] state before next size:', await evaluate(`JSON.stringify({dialogs:[...document.querySelectorAll('[role=dialog]')].map(d=>String(d.className).slice(0,50)),toolbar:[...document.querySelectorAll('[role=dialog] button')].some(b=>/检查全部更新/.test(b.textContent||''))})`))
    }
    const opened = await clickButton(`/^诊断$/.test((x.textContent||'').trim())`)
    if (opened !== 'clicked') { failures.push({ label: `${size.label} diagnostics`, problems: ['diagnostics button not found'] }); continue }
    await sleep(1500)
    await measure('em-dialogShell', `${size.label} diagnostics`)
    if (size.label === sizes[0].label) {
      await screenshot('diagnostics')
      await checkLastLine('em-dialogShell', 'diagnostics last-line', 'diagnostics-scrolled')
    }
    await clickInDialog('em-dialogShell', `(x.textContent||'').trim()==='关闭'`)
    await sleep(500)
  }
  if (!await ensureManager()) throw new Error('settings section closed before details checks')

  // ------------------------------------------------------ details per size
  for (const size of sizes) {
    await setSize(size)
    const opened = await clickButton(`/查看详情/.test(x.getAttribute('aria-label')||'')||/查看详情/.test(x.textContent||'')`)
    if (opened !== 'clicked') { failures.push({ label: `${size.label} details`, problems: ['details button not found'] }); continue }
    await sleep(1200)
    await measure('em-modalWide', `${size.label} details`)
    if (size.label === sizes[0].label) {
      await screenshot('details')
      await checkLastLine('em-modalWide', 'details last-line', 'details-scrolled')
    }
    await pressEscape()
    await sleep(300)
  }
  if (!await ensureManager()) throw new Error('settings section closed before update checks')

  // -------------------------------------------- update dialogs (optional)
  if (!skipUpdate) {
    // Refresh the check so a real Host plan is preferred over the preview fixture.
    await clickButton(`/^检查全部更新$/.test((x.textContent||'').trim())`)
    const checkSettled = await waitFor(`(()=>{
      const all=[...document.querySelectorAll('[role=dialog] button')].map(b=>(b.textContent||'').trim())
      const updateAll=[...document.querySelectorAll('[role=dialog] button')].find(x=>(x.textContent||'').trim().startsWith('更新全部'))
      return Boolean(updateAll&&!updateAll.disabled) || all.some(t=>t==='检查全部更新')
    })()`, 45000)
    if (!checkSettled) console.log('[layout] update check did not settle in time')
    const hasUpdates = await evaluate(`(()=>{const b=[...document.querySelectorAll('[role=dialog] button')].find(x=>(x.textContent||'').trim().startsWith('更新全部'));return Boolean(b&&!b.disabled)})()`)
    const fixtureUrl = `${origin}/?emFixture=1`
    if (hasUpdates !== true) {
      console.log('[layout] no real updates available — using the preview fixture for update dialogs')
      await evaluate(`location.href = ${JSON.stringify(navigationUrl(fixtureUrl))}`)
      await sleep(4500)
      await openManager(fixtureUrl)
    }
    await setSize(sizes[0])

    // complete plan
    let opened = await clickButton(`(x.textContent||'').trim().startsWith('更新全部')`)
    if (opened !== 'clicked') {
      // fixture pages may show a single update instead; fall back to the row action
      opened = await clickButton(`(x.textContent||'').trim()==='更新'`)
    }
    await sleep(3500)
    await measure('em-dialogShell', 'update-plan complete')
    await screenshot('update-plan-complete')
    await checkLastLine('em-dialogShell', 'update-plan complete last-line', 'update-plan-complete-scrolled')
    await clickInDialog('em-dialogShell', `(x.textContent||'').trim()==='取消'`)
    await sleep(500)

    // loading state (delayed plan request); wait for the dialog itself so a
    // slow first paint or a cached plan cannot race the measurement
    await send('Network.emulateNetworkConditions', { offline: false, latency: 3000, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' })
    opened = await clickButton(`(x.textContent||'').trim().startsWith('更新全部')`)
    const loadingVisible = await waitFor(`(()=>Boolean([...document.querySelectorAll('[role=dialog]')].find(x=>String(x.className).includes('em-dialogShell'))))()`, 8000)
    if (!loadingVisible) console.log('[layout] loading dialog did not appear, measured anyway')
    await sleep(250)
    await measure('em-dialogShell', 'update-plan loading')
    await screenshot('update-plan-loading')
    await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: 'wifi' })
    await sleep(1200)
    await clickInDialog('em-dialogShell', `(x.textContent||'').trim()==='取消'`)
    await sleep(500)

    // error state (blocked plan request)
    await send('Network.setBlockedURLs', { urls: ['*update-plan*'] })
    opened = await clickButton(`(x.textContent||'').trim().startsWith('更新全部')`)
    await sleep(2200)
    await measure('em-dialogShell', 'update-plan error')
    await screenshot('update-plan-error')
    await send('Network.setBlockedURLs', { urls: [] })
    await clickInDialog('em-dialogShell', `(x.textContent||'').trim()==='取消'`)
    await sleep(500)
  }

  // ---------------------------------------------------------- dark pass
  await setDark(true)
  await openManager(launchUrl)
  const darkOpened = await clickButton(`(x.textContent||'').trim()==='诊断'`)
  if (darkOpened === 'clicked') {
    await sleep(1500)
    await measure('em-dialogShell', 'dark diagnostics')
    await screenshot('dark-diagnostics')
    await clickInDialog('em-dialogShell', `(x.textContent||'').trim()==='关闭'`)
  } else {
    failures.push({ label: 'dark diagnostics', problems: ['diagnostics button not found'] })
  }
  await setDark(false)

  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), url: launchUrl, results, failures }, undefined, 2), 'utf8')
  console.log(`[layout] report: ${join(outDir, 'report.json')}`)
  console.log(`[layout] ${String(results.filter(item => item.passed).length)}/${String(results.length)} checks passed`)
  process.exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ at: new Date().toISOString(), error: String(error), results, failures }, undefined, 2), 'utf8')
  console.error('[layout] run failed:', error)
  process.exitCode = 1
} finally {
  try { ws?.close() } catch {}
  chrome?.kill()
  await sleep(300)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch {}
}
