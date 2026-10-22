#!/usr/bin/env node
/**
 * Security regression suite for `verify-dialog-layout.mjs` and the lifecycle
 * pieces it now shares with `shot.mjs`.
 *
 * WINDOWS-ONLY parts are marked: the junction check (B5) needs NTFS reparse
 * points. Everything else - argument tables, path gates, process attribution,
 * shutdown orchestration, CDP timeouts, URL redaction - is platform-independent
 * and uses fakes, so this suite never starts a browser, never reads a real Edge
 * profile and never touches an existing `dsh-em-layout-*` directory.
 *
 * Two kinds of evidence are produced, and the report says which is which:
 *   - static: the source of the two scripts is read and pattern-checked;
 *   - behavioural: the exported functions are called with injected fakes.
 * There is no "real browser" evidence here by design - that needs a separate,
 * explicitly authorised isolated run.
 *
 * Usage: node scripts/dev/test-layout-guard.mjs [--only B6]
 * Exit code: 0 when every case passes (skips do not fail the run), 1 otherwise.
 */
import { readFileSync, existsSync, mkdirSync, rmSync, symlinkSync, utimesSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_PREFIX,
  assertSafeProfileDir,
  createProfileDir,
  findProfileOwners,
  isProcessAlive,
  profileNamePattern,
  queryProcessIdentity,
  reapProfileOwners,
  sweepStaleProfiles,
  terminateProcessTree,
  waitForExit,
} from './browser-lifecycle.mjs'
import {
  CdpEndpointError,
  CdpTimeoutError,
  LAYOUT_ISOLATION_ARGS,
  LAYOUT_PROFILE_PREFIX,
  LIFECYCLE_EXIT_CODES,
  TIMEOUTS,
  assertOwnedWsUrl,
  buildLayoutLaunchArgs,
  buildReportPayload,
  connectCdp,
  connectVerifiedBrowser,
  createCdpClient,
  createLifecycleController,
  createShutdownRunner,
  describeUrl,
  fetchJsonWithTimeout,
  parseDevToolsActivePort,
  redactUrl,
  sanitizeText,
  shutdownLayoutSession,
  startBrowser,
  syncReapProfile,
  waitForCondition,
} from './layout-lifecycle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const layoutScript = join(here, 'verify-dialog-layout.mjs')
const lifecycleModule = join(here, 'browser-lifecycle.mjs')
const layoutModule = join(here, 'layout-lifecycle.mjs')

const stamp = String(Date.now())
// Deliberately NOT shaped like a profile directory: the suite must never look
// like something a sweep would claim.
const testRoot = join(tmpdir(), `dsh-em-layouttests-${stamp}`)
mkdirSync(testRoot, { recursive: true })

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : ''
const results = []

class SkipCase extends Error {}
const skip = reason => { throw new SkipCase(reason) }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function assert(condition, message) {
  if (!condition) throw new Error(message)
}
function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
async function assertRejects(promise, label, codeExpected) {
  try {
    await promise
  } catch (error) {
    if (codeExpected !== undefined && error.code !== codeExpected) {
      throw new Error(`${label}: rejected with code ${String(error.code)}, expected ${codeExpected}`)
    }
    return error
  }
  throw new Error(`${label}: expected a rejection but the promise resolved`)
}

const source = {
  layout: readFileSync(layoutScript, 'utf8'),
  lifecycle: readFileSync(lifecycleModule, 'utf8'),
  layoutModule: readFileSync(layoutModule, 'utf8'),
}

async function testCase(title, fn) {
  if (only !== '' && !title.startsWith(only)) return
  const startedAt = Date.now()
  try {
    await fn()
    results.push({ title, ok: true, ms: Date.now() - startedAt })
    console.log(`PASS  ${title}  (${String(Date.now() - startedAt)} ms)`)
  } catch (error) {
    if (error instanceof SkipCase) {
      results.push({ title, ok: true, skipped: true, ms: Date.now() - startedAt, reason: error.message })
      console.log(`SKIP  ${title}`)
      console.log(`        ${error.message}`)
      return
    }
    results.push({ title, ok: false, ms: Date.now() - startedAt, error: error.message })
    console.log(`FAIL  ${title}  (${String(Date.now() - startedAt)} ms)`)
    console.log(`        ${error.message}`)
  }
}

/** Minimal WebSocket stand-in: records sends, lets a test drive the events. */
class FakeSocket {
  constructor() {
    this.listeners = new Map()
    this.sent = []
    this.closed = false
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter(item => item !== handler))
  }
  emit(type, event = {}) {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler(event)
  }
  send(data) {
    this.sent.push(JSON.parse(String(data)))
  }
  close() {
    this.closed = true
  }
}

// ---------------------------------------------------------------------------
// A. Isolation arguments and namespace wiring
// ---------------------------------------------------------------------------
await testCase('A1 隔离参数：五项必需开关齐全且无重复', async () => {
  const required = [
    '--disable-sync',
    '--disable-features=msEdgeSyncConsent,msImplicitSignin,ImplicitSignInFlowV3,msEdgeIdentityFeature',
    '--no-service-autorun',
    '--disable-background-networking',
    '--disable-extensions',
  ]
  for (const flag of required) {
    assert(LAYOUT_ISOLATION_ARGS.includes(flag), `missing isolation switch: ${flag}`)
  }
  assertEqual(new Set(LAYOUT_ISOLATION_ARGS).size, LAYOUT_ISOLATION_ARGS.length, 'isolation switches must be unique')
  assert(!LAYOUT_ISOLATION_ARGS.some(item => item.startsWith('--user-data-dir')), 'the profile dir is added at the spawn site, not here')
})

await testCase('A2 布局脚本：启动参数由统一构造函数生成且不再自行管理进程', async () => {
  assert(source.layout.includes('buildLayoutLaunchArgs(profileDir)'), 'the launch args are not produced by the shared builder')
  assert(source.layout.includes('connectVerifiedBrowser('), 'the script does not verify the devtools endpoint owner')
  assert(source.layout.includes("'--remote-debugging-port=0'") === false, 'the port must be chosen by the browser, not pinned in the script')
  assert(!/remote-debugging-port=/u.test(source.layout), 'the script still decides the devtools port itself')
  assert(/requestBrowserClose\s*=\s*\(\)\s*=>\s*connected\.browserCdp\.send\('Browser\.close'/u.test(source.layout), 'Browser.close is not sent over the verified browser-level socket')
  assert(!/chrome\?\.kill\(\)/u.test(source.layout), 'the direct-PID kill is still present')
  assert(!/rmSync\(profileDir/u.test(source.layout), 'the ungated rmSync is still present')
  assert(!/await sleep\(300\)\s*\n\s*try \{ rmSync/u.test(source.layout), 'the fixed 300 ms wait before delete is still present')
  assert(source.layout.includes('shutdownLayoutSession') === false, 'the script should reach the shutdown through the memoised runner')
  assert(source.layout.includes('createShutdownRunner('), 'the script does not use the memoised shutdown runner')
  assert(source.layout.includes('startBrowser('), 'the script does not use the bounded spawn helper')
})

await testCase('A3 命名空间：布局工具与截图工具前缀不同且各自固定', async () => {
  assertEqual(LAYOUT_PROFILE_PREFIX, 'dsh-em-layout-', 'layout prefix')
  assertEqual(PROFILE_PREFIX, 'dsh-em-chrome-', 'default (shot.mjs) prefix must not change')
  assert(source.layout.includes('LAYOUT_PROFILE_PREFIX'), 'the layout script does not use its own namespace')
  const pattern = profileNamePattern(LAYOUT_PROFILE_PREFIX)
  assert(pattern.test('dsh-em-layout-1780000000000-1'), 'the layout pattern rejects a valid layout name')
  assert(!pattern.test('dsh-em-chrome-1780000000000-1'), 'the layout pattern accepts a shot.mjs name')
})

// ---------------------------------------------------------------------------
// B. Profile path boundaries
// ---------------------------------------------------------------------------
await testCase('B1 合法布局目录：创建即符合约定且通过校验', async () => {
  const dir = createProfileDir(testRoot, { prefix: LAYOUT_PROFILE_PREFIX })
  try {
    assert(profileNamePattern(LAYOUT_PROFILE_PREFIX).test(dir.split(/[\\/]/u).pop()), `created name does not match the layout convention: ${dir}`)
    const real = assertSafeProfileDir(dir, testRoot, { prefix: LAYOUT_PROFILE_PREFIX })
    assert(real.length > 0, 'assertSafeProfileDir returned an empty path')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testCase('B2 非法命名：非约定后缀被拒绝', async () => {
  const cases = [
    `dsh-em-layout-bad`,
    `dsh-em-layout-${stamp}-12345`,
    `dsh-em-layout-x${stamp}-1`,
    `dsh-em-layout-${stamp}-`,
    `dsh-chrome-${stamp}-1`,
  ]
  const accepted = []
  for (const name of cases) {
    const dir = join(testRoot, name)
    mkdirSync(dir, { recursive: true })
    try {
      assertSafeProfileDir(dir, testRoot, { prefix: LAYOUT_PROFILE_PREFIX })
      accepted.push(name)
    } catch {
      // expected
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  assertEqual(accepted.length, 0, `names accepted but should not be: ${accepted.join(', ')}`)
})

await testCase('B3 前缀碰撞：两个命名空间互不认领对方目录', async () => {
  const layout = join(testRoot, `dsh-em-layout-${stamp}-42`)
  const chrome = join(testRoot, `dsh-em-chrome-${stamp}-42`)
  mkdirSync(layout, { recursive: true })
  mkdirSync(chrome, { recursive: true })
  try {
    let layoutUnderChrome = false
    let chromeUnderLayout = false
    try {
      assertSafeProfileDir(layout, testRoot)                                   // default = chrome
    } catch { layoutUnderChrome = true }
    try {
      assertSafeProfileDir(chrome, testRoot, { prefix: LAYOUT_PROFILE_PREFIX })
    } catch { chromeUnderLayout = true }
    assert(layoutUnderChrome, 'a layout directory passed the chrome-prefix gate')
    assert(chromeUnderLayout, 'a chrome directory passed the layout-prefix gate')
  } finally {
    rmSync(layout, { recursive: true, force: true })
    rmSync(chrome, { recursive: true, force: true })
  }
})

await testCase('B4 越界路径：子目录不能被当成临时根的直接子项', async () => {
  const nested = join(testRoot, 'nested')
  const dir = join(nested, `dsh-em-layout-${stamp}-77`)
  mkdirSync(dir, { recursive: true })
  try {
    let rejected = false
    try {
      assertSafeProfileDir(dir, testRoot, { prefix: LAYOUT_PROFILE_PREFIX })
    } catch (error) {
      rejected = error.code === 'EOUTSIDE'
    }
    assert(rejected, 'a nested profile directory was not rejected with EOUTSIDE')
  } finally {
    rmSync(nested, { recursive: true, force: true })
  }
})

await testCase('B5 符号链接/联接：指向外部目录的链接被拒绝', async () => {
  if (process.platform !== 'win32') skip('junction creation is Windows-only')
  const outside = join(testRoot, 'outside-target')
  const link = join(testRoot, `dsh-em-layout-${stamp}-88`)
  mkdirSync(outside, { recursive: true })
  let linked = false
  try {
    symlinkSync(outside, link, 'junction')
    linked = true
  } catch (error) {
    skip(`could not create a junction here: ${error.message}`)
  }
  try {
    if (!linked) return
    let rejected = false
    try {
      assertSafeProfileDir(link, testRoot, { prefix: LAYOUT_PROFILE_PREFIX })
    } catch (error) {
      rejected = error.code === 'ESYMLINK' || error.code === 'EOUTSIDE' || error.code === 'ENAMING'
    }
    assert(rejected, 'a junction was accepted as a deletable profile directory')
  } finally {
    try { rmSync(link, { force: true }) } catch { /* junction may already be gone */ }
    rmSync(outside, { recursive: true, force: true })
  }
})

await testCase('B6 清扫隔离：各自只清理自己的命名空间', async () => {
  const root = join(testRoot, 'sweep')
  mkdirSync(root, { recursive: true })
  const old = new Date(Date.now() - 72 * 3600 * 1000)
  const layoutDir = join(root, `dsh-em-layout-${stamp}-1001`)
  const chromeDir = join(root, `dsh-em-chrome-${stamp}-1002`)
  for (const dir of [layoutDir, chromeDir]) {
    mkdirSync(dir, { recursive: true })
    utimesSync(dir, old, old)
  }
  const noProcesses = () => ({ ok: true, processes: [], detail: '' })
  try {
    const layoutSweep = sweepStaleProfiles({ root, olderThanHours: 24, prefix: LAYOUT_PROFILE_PREFIX, listProcesses: noProcesses })
    assertEqual(layoutSweep.swept.length, 1, `layout sweep should have claimed exactly one directory (got ${layoutSweep.swept.length})`)
    assert(layoutSweep.swept[0].dir === layoutDir, 'layout sweep claimed the wrong directory')
    assert(existsSync(chromeDir), 'the layout sweep deleted a shot.mjs profile directory')

    const chromeSweep = sweepStaleProfiles({ root, olderThanHours: 24, listProcesses: noProcesses })
    assertEqual(chromeSweep.swept.length, 1, `default sweep should have claimed exactly one directory (got ${chromeSweep.swept.length})`)
    assert(chromeSweep.swept[0].dir === chromeDir, 'default sweep claimed the wrong directory')
    assert(!existsSync(layoutDir), 'the layout directory was not removed by its own sweep')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

await testCase('B7 非法前缀：`dsh-em-` 不能被当成命名空间', async () => {
  let threw = false
  try {
    profileNamePattern('dsh-em-')
  } catch (error) {
    threw = error.code === 'EPREFIX'
  }
  assert(threw, 'the bare dsh-em- prefix was accepted')
  let threwAgain = false
  try {
    createProfileDir(testRoot, { prefix: 'dsh-em-' })
  } catch (error) {
    threwAgain = error.code === 'EPREFIX'
  }
  assert(threwAgain, 'createProfileDir accepted the bare dsh-em- prefix')
  const sweepResult = sweepStaleProfiles({ root: testRoot, olderThanHours: 0, prefix: 'dsh-em-', listProcesses: () => ({ ok: true, processes: [] }) })
  assert(sweepResult.error !== undefined, 'sweepStaleProfiles did not report the invalid prefix')
})

// ---------------------------------------------------------------------------
// C. Process attribution and reclamation
// ---------------------------------------------------------------------------
await testCase('C1 归属判定：精确匹配，前缀/无关目录不匹配', async () => {
  const dir = 'C:\\Temp\\dsh-em-layout-1780000000000-42'
  const processes = [
    { pid: 1, commandLine: `--user-data-dir="${dir}" --headless=new` },
    { pid: 2, commandLine: `--user-data-dir=${dir}` },
    { pid: 3, commandLine: '--user-data-dir=C:\\Temp\\dsh-em-layout-1780000000000-421' },
    { pid: 4, commandLine: '--user-data-dir=C:\\Temp\\dsh-em-chrome-1780000000000-42' },
    { pid: 5, commandLine: '--remote-debugging-port=1' },
    { pid: 6, commandLine: `--user-data-dir="C:/TEMP/DSH-EM-LAYOUT-1780000000000-42"` },
  ]
  const owners = findProfileOwners(dir, processes).map(entry => entry.pid)
  assert(owners.includes(1), 'a quoted exact match was missed')
  assert(owners.includes(2), 'a bare exact match was missed')
  assert(owners.includes(6), 'case/separator normalisation failed')
  assert(!owners.includes(3), 'a prefix collision was attributed to this profile')
  assert(!owners.includes(4), 'a directory from the other namespace was attributed to this profile')
  assert(!owners.includes(5), 'a process without --user-data-dir was attributed to this profile')
})

await testCase('C2 身份复核：kill 拒绝时如实记录，不当作已回收', async () => {
  const dir = join(testRoot, `dsh-em-layout-${stamp}-2001`)
  mkdirSync(dir, { recursive: true })
  const snapshot = () => ({ ok: true, processes: [{ pid: 4242, createdAt: '20260101000000000', commandLine: `--user-data-dir=${dir}` }], detail: '' })
  try {
    const report = reapProfileOwners(dir, {
      prefix: LAYOUT_PROFILE_PREFIX,
      root: testRoot,
      attempts: 1,
      delayMs: 0,
      listProcesses: snapshot,
      kill: () => ({ ok: false, refused: true, method: 'identity-mismatch', detail: 'createdAt differs' }),
    })
    assertEqual(report.refused.length, 1, 'the refused kill was not recorded')
    assert(report.refused[0].detail.includes('createdAt'), 'the refusal reason was not preserved')
    assertEqual(report.ok, false, 'a still-owning process must keep the reaper from reporting success')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await testCase('C3 终止方式：不存在按进程名批量终止', async () => {
  const killSites = [...source.lifecycle.matchAll(/spawnSync\('taskkill'[^)]{0,200}\)/gu)].map(match => match[0])
  assert(killSites.length >= 1, 'no PID-addressed taskkill call site found')
  for (const site of killSites) {
    assert(site.includes("'/PID'"), `taskkill called without /PID: ${site.slice(0, 120)}`)
    assert(!/['"]\/IM['"]/u.test(site), `taskkill called by image name: ${site.slice(0, 120)}`)
  }
  // Not just the call sites: no image-name kill may exist anywhere in either file.
  assert(!/['"]\/IM['"]/u.test(source.lifecycle), 'the lifecycle module mentions /IM')
  assert(!/['"]\/IM['"]/u.test(source.layout), 'the layout script mentions /IM')
  const taskkillHelper = /function taskkillPidTree[\s\S]{0,320}?\n\}/u.exec(source.lifecycle)
  assert(taskkillHelper !== null, 'the taskkill helper could not be located')
  assert(taskkillHelper[0].includes("'/T'"), 'the tree switch /T is missing')
  assert(taskkillHelper[0].includes("'/F'"), 'the force switch /F is missing')
})

await testCase('C4 枚举失败：保守保留目录并给出原因', async () => {
  let removeCalls = 0
  const report = await shutdownLayoutSession(
    { profileDir: join(testRoot, `dsh-em-layout-${stamp}-3001`), profileRoot: testRoot, browserPid: null, cdp: null },
    {
      isAlive: () => false,
      reap: () => ({ ok: false, unknown: true, remaining: [], lastError: 'enumeration failed' }),
      removeDir: () => { removeCalls += 1; return { removed: true } },
      exists: () => true,
      assertSafe: () => 'safe',
      findOwners: () => ({ ok: false, pids: [], detail: 'enumeration failed' }),
    },
  )
  assertEqual(removeCalls, 0, 'the directory was deleted although process ownership was unknown')
  assertEqual(report.directory.removed, false, 'the report claims the directory was removed')
  assertEqual(report.directory.blocked, 'process ownership unknown', 'the conservative reason is not reported')
})

await testCase('C5 删除失败：有界重试并保留可诊断信息', async () => {
  let removeCalls = 0
  const report = await shutdownLayoutSession(
    { profileDir: join(testRoot, `dsh-em-layout-${stamp}-3002`), profileRoot: testRoot, browserPid: null, cdp: null },
    {
      isAlive: () => false,
      reap: () => ({ ok: true, terminated: [], remaining: [] }),
      removeDir: () => {
        removeCalls += 1
        return { removed: false, attemptCount: 8, attempts: [], lastError: { code: 'EPERM', message: 'locked by another process' } }
      },
      exists: () => true,
      assertSafe: () => 'safe',
      findOwners: () => ({ ok: true, pids: [] }),
    },
  )
  assertEqual(removeCalls, 1 + TIMEOUTS.reappearPasses, `delete attempts must stay bounded (got ${removeCalls})`)
  assertEqual(report.directory.lastError.code, 'EPERM', 'the last error code was not surfaced')
  assertEqual(report.directory.removed, false, 'a failed delete was reported as success')
})

await testCase('C6 正常回收：进程退出后目录被删除且不重复删除', async () => {
  let exists = true
  let removeCalls = 0
  const report = await shutdownLayoutSession(
    { profileDir: join(testRoot, `dsh-em-layout-${stamp}-3003`), profileRoot: testRoot, browserPid: null, cdp: null },
    {
      isAlive: () => false,
      reap: () => ({ ok: true, terminated: [], remaining: [] }),
      removeDir: () => { removeCalls += 1; exists = false; return { removed: true, attemptCount: 1, attempts: [] } },
      exists: () => exists,
      assertSafe: () => 'safe',
      findOwners: () => ({ ok: true, pids: [] }),
    },
  )
  assertEqual(removeCalls, 1, `exactly one delete pass expected, got ${String(removeCalls)}`)
  assertEqual(report.directory.removed, true, 'the directory was not reported as removed')
  assertEqual(report.recreated, 0, 'a spurious recreate pass was reported')
})

// ---------------------------------------------------------------------------
// D. Timeouts, socket loss and shutdown order
// ---------------------------------------------------------------------------
await testCase('D1 CDP 命令无响应：超时拒绝且不遗留 pending', async () => {
  const socket = new FakeSocket()
  const cdp = createCdpClient(socket, { commandTimeoutMs: 60 })
  const error = await assertRejects(cdp.send('Runtime.evaluate', {}), 'silent socket', 'ETIMEDOUT')
  assert(error instanceof CdpTimeoutError, 'the rejection is not a CdpTimeoutError')
  assertEqual(cdp.pendingCount, 0, 'a timed-out request was left pending')
})

await testCase('D2 socket 关闭：所有在途请求全部拒绝', async () => {
  const socket = new FakeSocket()
  const cdp = createCdpClient(socket, { commandTimeoutMs: 5000 })
  const first = cdp.send('Page.enable', {})
  const second = cdp.send('Runtime.enable', {})
  await sleep(0)
  assertEqual(cdp.pendingCount, 2, 'both requests should be in flight')
  socket.emit('close')
  await assertRejects(first, 'first request after close')
  await assertRejects(second, 'second request after close')
  assertEqual(cdp.pendingCount, 0, 'pending map was not drained on close')
  await assertRejects(cdp.send('Page.navigate', {}), 'send after close')
})

await testCase('D3 WebSocket 从未 open：打开超时、关闭 socket、撤除监听器', async () => {
  const socket = new FakeSocket()
  const error = await assertRejects(
    connectCdp('ws://127.0.0.1:1/devtools/page/x', { createSocket: () => socket, openTimeoutMs: 60 }),
    'socket that never opens',
    'ETIMEDOUT',
  )
  assert(error instanceof CdpTimeoutError, 'the open timeout is not a CdpTimeoutError')
  assertEqual(socket.closed, true, 'the abandoned socket was not closed')
  assertEqual((socket.listeners.get('open') ?? []).length, 0, 'the open listener was not removed after the timeout')
  assertEqual((socket.listeners.get('error') ?? []).length, 0, 'the error listener was not removed after the timeout')
  // A late `open` must not resurrect the connection this call already gave up on.
  socket.closed = false
  socket.emit('open')
  assertEqual(socket.listeners.get('message'), undefined, 'a late open registered a CDP client on the abandoned socket')
})

await testCase('D3b socket.close() 抛错：仍返回原始超时错误', async () => {
  class ThrowingCloseSocket extends FakeSocket {
    close() {
      this.closed = true
      throw new Error('close exploded')
    }
  }
  const socket = new ThrowingCloseSocket()
  const error = await assertRejects(
    connectCdp('ws://127.0.0.1:1/devtools/page/x', { createSocket: () => socket, openTimeoutMs: 50 }),
    'socket whose close() throws',
    'ETIMEDOUT',
  )
  assert(error instanceof CdpTimeoutError, `the close() failure masked the timeout: ${error.name}`)
  assert(!String(error.message).includes('close exploded'), 'the close() failure replaced the original message')
  assertEqual(socket.closed, true, 'the socket was not closed')
})

await testCase('D4 WebSocket 报错：open 阶段立即拒绝并关闭 socket', async () => {
  const socket = new FakeSocket()
  setTimeout(() => socket.emit('error'), 0)
  const error = await assertRejects(
    connectCdp('ws://127.0.0.1:1/devtools/page/x', { createSocket: () => socket, openTimeoutMs: 2000 }),
    'socket that errors',
  )
  assert(String(error.message).includes('failed to open'), `unexpected message: ${error.message}`)
  assertEqual(socket.closed, true, 'a socket whose handshake failed was left open')
})

await testCase('D5 HTTP 探测无响应：AbortController 生效', async () => {
  const sockets = new Set()
  const server = createServer(() => { /* accept and never answer */ })
  server.on('connection', socket => { sockets.add(socket) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const startedAt = Date.now()
  try {
    await assertRejects(fetchJsonWithTimeout(`http://127.0.0.1:${String(port)}/json/version`, { timeoutMs: 150 }), 'unresponsive endpoint')
    const elapsed = Date.now() - startedAt
    assert(elapsed < 3000, `the probe was not aborted promptly (${String(elapsed)} ms)`)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})

await testCase('D6 条件轮询：到期返回 false 且不抛错', async () => {
  let calls = 0
  const value = await waitForCondition(async () => { calls += 1; return false }, 'x', { timeoutMs: 120, intervalMs: 10 })
  assertEqual(value, false, 'the poller should have returned false at the deadline')
  assert(calls >= 2, 'the poller did not actually poll')
})

await testCase('D7 条件轮询：探测异常被当作"尚未就绪"', async () => {
  const value = await waitForCondition(async () => { throw new Error('execution context destroyed') }, 'x', { timeoutMs: 100, intervalMs: 10 })
  assertEqual(value, false, 'a thrown probe escaped the poller')
})

await testCase('D8 关闭超时：CDP 关闭失败仍走受控回收，终止恰好一次', async () => {
  const terminated = []
  const report = await shutdownLayoutSession(
    {
      profileDir: join(testRoot, `dsh-em-layout-${stamp}-4001`),
      profileRoot: testRoot,
      browserPid: 999999,
      cdp: null,
      requestBrowserClose: async () => { throw new Error('Browser.close timed out') },
    },
    {
      isAlive: () => true,
      waitExit: () => false,
      terminate: pid => { terminated.push(pid); return { ok: true, method: 'taskkill /PID /T /F' } },
      reap: () => ({ ok: true, terminated: [], remaining: [] }),
      removeDir: () => ({ removed: true, attemptCount: 1, attempts: [] }),
      exists: () => false,
      assertSafe: () => 'safe',
      findOwners: () => ({ ok: true, pids: [] }),
    },
  )
  assertEqual(terminated.length, 1, 'the tracked PID was not terminated exactly once')
  assertEqual(report.graceful.ok, false, 'the failed CDP close was not recorded')
  assertEqual(report.forced.ok, true, 'the forced tree kill was not recorded')
  assertEqual(report.directory.removed, true, 'cleanup did not continue after the close timeout')
})

await testCase('D9 关闭幂等：重复调用只执行一次', async () => {
  let reapCalls = 0
  let reports = 0
  let exists = true
  const session = { profileDir: join(testRoot, `dsh-em-layout-${stamp}-4002`), profileRoot: testRoot, browserPid: null, cdp: null }
  const runner = createShutdownRunner(session, {
    isAlive: () => false,
    reap: () => { reapCalls += 1; return { ok: true, terminated: [], remaining: [] } },
    removeDir: () => { exists = false; return { removed: true, attemptCount: 1, attempts: [] } },
    exists: () => exists,
    assertSafe: () => 'safe',
    findOwners: () => ({ ok: true, pids: [] }),
  }, () => { reports += 1 })
  const first = await runner.run('done')
  const second = await runner.run('signal:SIGINT')
  assertEqual(reapCalls, 1, 'the reaper ran twice for one process')
  assertEqual(reports, 1, 'the report callback fired twice')
  assertEqual(first, second, 'the two calls returned different reports')
  assertEqual(first.reason, 'done', 'the first reason must win')
})

// ---------------------------------------------------------------------------
// E. Credential handling
// ---------------------------------------------------------------------------
await testCase('E1 URL 脱敏：query 中的 token 被替换', async () => {
  const redacted = redactUrl('http://127.0.0.1:3080/?token=super-secret-123&foo=bar')
  assert(!redacted.includes('super-secret-123'), `the token survived redaction: ${redacted}`)
  assert(redacted.includes('foo=bar'), 'a harmless query parameter was destroyed')
  assert(redacted.includes('redacted'), 'no redaction marker was written')
})

await testCase('E2 诊断形式：describeUrl 不包含 query', async () => {
  const described = describeUrl('http://127.0.0.1:3080/?token=super-secret-123#hash')
  assertEqual(described, 'http://127.0.0.1:3080/', 'describeUrl output')
  assert(!described.includes('super-secret'), 'describeUrl leaked the token')
  assertEqual(describeUrl('about:blank'), 'about:blank', 'non-http URLs must stay readable')
})

await testCase('E3 报告载荷：不含完整 token URL', async () => {
  const payload = buildReportPayload({
    launchUrl: 'http://127.0.0.1:3080/?token=super-secret-123',
    results: [{ label: 'a', passed: true }],
    failures: [],
  })
  const serialised = JSON.stringify(payload)
  assert(!serialised.includes('super-secret-123'), 'the report payload contains the launch token')
  assertEqual(payload.target, 'http://127.0.0.1:3080/', 'the report target should be origin+path')
  assertEqual(payload.credentialSupplied, true, 'the presence of a credential should still be recorded')
  assertEqual(payload.results.length, 1, 'results were dropped from the report')
})

await testCase('E4 错误文本：内嵌 URL 被脱敏后入库', async () => {
  const payload = buildReportPayload({
    launchUrl: 'http://127.0.0.1:3080/?token=super-secret-123',
    error: 'Error: failed to navigate http://127.0.0.1:3080/?token=super-secret-123&x=1',
  })
  assert(!JSON.stringify(payload).includes('super-secret-123'), 'the error text leaked the token')
  const sanitised = sanitizeText('see http://h/?token=abc123 for details')
  assert(!sanitised.includes('abc123'), `sanitizeText leaked the token: ${sanitised}`)
})

await testCase('E5 脚本静态：不再把原始 URL 写入报告或日志', async () => {
  assert(!/url:\s*launchUrl/u.test(source.layout), 'the script still stores the raw launch URL in the report')
  assert(source.layout.includes('buildReportPayload('), 'the report is not built through the redacting helper')
  assert(source.layout.includes('describeUrl(target)'), 'navigation logging does not use describeUrl')
  assert(!/console\.(log|warn|error)\([^)]*launchUrl/u.test(source.layout), 'a log line prints the raw launch URL')
})

// ---------------------------------------------------------------------------
// F-02  Endpoint ownership: the port must come from the browser we started
// ---------------------------------------------------------------------------
const tick = () => new Promise(resolve => setImmediate(resolve))

const VALID_PORT_FILE = '51234\n/devtools/browser/BROWSER-1\n'
const validPageList = [{
  id: 'TARGET-A',
  type: 'page',
  url: 'about:blank',
  webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/page/TARGET-A',
}]

/**
 * Records every command sent to either endpoint, so a refusal can be proven to
 * send nothing at all.
 */
function endpointHarness(options = {}) {
  const sent = { browser: [], page: [] }
  const connects = []
  const state = { browserClosed: false, pageClosed: false }
  const browserCdp = {
    async send(method) {
      sent.browser.push(method)
      if (method === 'Browser.getVersion') return { product: 'Fake/1.0', protocolVersion: '1.3' }
      if (method === 'Target.getTargets') return { targetInfos: options.targetInfos ?? [{ targetId: 'TARGET-A' }] }
      throw new Error(`unexpected browser command ${method}`)
    },
    close() { state.browserClosed = true },
  }
  const pageCdp = {
    async send(method) { sent.page.push(method); throw new Error(`unexpected page command ${method}`) },
    close() { state.pageClosed = true },
  }
  return {
    sent,
    connects,
    state,
    browserCdp,
    pageCdp,
    connect: (url) => {
      connects.push(String(url))
      return String(url).includes('/devtools/browser/') ? browserCdp : pageCdp
    },
  }
}

async function runEndpointCase(options = {}) {
  const harness = endpointHarness(options)
  let error
  try {
    await connectVerifiedBrowser({
      profileDir: join(testRoot, 'endpoint-fixture'),
      readFile: options.readFile ?? (() => options.file ?? VALID_PORT_FILE),
      fetchJson: async () => options.pages ?? validPageList,
      connect: harness.connect,
      timeoutMs: options.timeoutMs ?? 40,
      intervalMs: 5,
    })
  } catch (caught) {
    error = caught
  }
  return { error, harness }
}

await testCase('EP1 DevToolsActivePort 解析：合法内容通过，四类非法内容被拒', async () => {
  const ok = parseDevToolsActivePort(VALID_PORT_FILE)
  assertEqual(ok.port, 51234, 'port')
  assertEqual(ok.wsPath, '/devtools/browser/BROWSER-1', 'ws path')
  assertEqual(ok.wsUrl, 'ws://127.0.0.1:51234/devtools/browser/BROWSER-1', 'ws url')
  const cases = [
    ['', 'EFORMAT'],
    ['51234', 'EFORMAT'],
    ['garbage', 'EFORMAT'],
    ['80\n/devtools/browser/B', 'EPORT'],
    ['999999\n/devtools/browser/B', 'EPORT'],
    ['51234\n/devtools/page/P', 'EPATH'],
    ['51234\n/devtools/browser/B?x=1', 'EPATH'],
    ['51234\nhttp://evil/devtools/browser/B', 'EPATH'],
  ]
  for (const [text, code] of cases) {
    let thrown
    try { parseDevToolsActivePort(text) } catch (error) { thrown = error }
    assert(thrown instanceof CdpEndpointError, `accepted malformed port file ${JSON.stringify(text)}`)
    assertEqual(thrown.code, code, `wrong error code for ${JSON.stringify(text)}`)
  }

  const browserUrl = 'ws://127.0.0.1:51234/devtools/browser/BROWSER-1'
  assertEqual(assertOwnedWsUrl(browserUrl, 51234, { kind: 'browser' }).toString(), browserUrl, 'a browser-level endpoint was rejected')
  const asPage = (() => {
    try { assertOwnedWsUrl(browserUrl, 51234, { kind: 'page' }) } catch (error) { return error }
    return null
  })()
  assertEqual(asPage?.code, 'EENDPOINT', 'a browser endpoint was accepted as a page target')
})

await testCase('EP2 端口文件缺失：有界失败，不连接任何端点', async () => {
  const missing = () => { const error = new Error('ENOENT: no such file'); error.code = 'ENOENT'; throw error }
  const { error, harness } = await runEndpointCase({ readFile: missing })
  assertEqual(error?.code, 'ETIMEDOUT', 'a missing DevToolsActivePort must fail closed')
  assertEqual(error.lastErrorCode, 'EREAD', 'the underlying read failure should be preserved')
  assertEqual(harness.connects.length, 0, 'a socket was opened although the port was unknown')
})

await testCase('EP3 端口文件格式错误 / 非法端口：失败关闭，不回退随机端口', async () => {
  // A file that only carries one of the two required lines is a format failure.
  const malformed = await runEndpointCase({ file: '51234\n' })
  assertEqual(malformed.error?.code, 'ETIMEDOUT', 'malformed content must not be used')
  assertEqual(malformed.error.lastErrorCode, 'EFORMAT', 'the parse failure should be preserved')
  assertEqual(malformed.harness.connects.length, 0, 'a socket was opened for a malformed port file')

  const notNumeric = await runEndpointCase({ file: 'not-a-port\n/devtools/browser/BROWSER-1\n' })
  assertEqual(notNumeric.error?.code, 'ETIMEDOUT', 'a non-numeric port must not be used')
  assertEqual(notNumeric.error.lastErrorCode, 'EPORT', 'the port failure should be preserved')

  const badPort = await runEndpointCase({ file: '80\n/devtools/browser/BROWSER-1\n' })
  assertEqual(badPort.error?.code, 'ETIMEDOUT', 'an out-of-range port must not be used')
  assertEqual(badPort.error.lastErrorCode, 'EPORT', 'the port failure should be preserved')
  assertEqual(badPort.harness.connects.length, 0, 'a socket was opened for an out-of-range port')

  const browserExited = await runEndpointCase({ readFile: () => { throw new Error('ENOENT') }, timeoutMs: 40 })
  assert(browserExited.error !== undefined, 'a never-written port file must not hang forever')
})

await testCase('EP4 页面端点主机/端口/协议不匹配：拒绝且不发送任何浏览器命令', async () => {
  const hosts = [
    { url: 'ws://evil.example:51234/devtools/page/TARGET-A', why: 'host mismatch' },
    { url: 'ws://127.0.0.1:51235/devtools/page/TARGET-A', why: 'port mismatch' },
    { url: 'ws://127.0.0.1:51234/devtools/browser/TARGET-A', why: 'browser path offered as a page target' },
    { url: 'http://127.0.0.1:51234/devtools/page/TARGET-A', why: 'http instead of ws' },
    { url: 'ws://user:pass@127.0.0.1:51234/devtools/page/TARGET-A', why: 'credentials in the URL' },
  ]
  for (const item of hosts) {
    const { error, harness } = await runEndpointCase({
      pages: [{ id: 'TARGET-A', type: 'page', webSocketDebuggerUrl: item.url }],
    })
    assert(error instanceof CdpEndpointError, `${item.why}: the endpoint was accepted`)
    assertEqual(error.code, 'EENDPOINT', `${item.why}: wrong error code`)
    assertEqual(harness.connects.filter(url => url.includes('/devtools/page/')).length, 0, `${item.why}: the page socket was opened anyway`)
    assert(!harness.sent.browser.includes('Browser.close'), `${item.why}: Browser.close was sent`)
    assertEqual(harness.state.browserClosed, true, `${item.why}: the browser socket was left open`)
  }
})

await testCase('EP5 页面目标归属不一致 / 无页面目标：拒绝且不导航', async () => {
  const unknownTarget = await runEndpointCase({ targetInfos: [{ targetId: 'SOMEONE-ELSE' }] })
  assertEqual(unknownTarget.error?.code, 'EENDPOINT', 'a page target unknown to the browser endpoint was accepted')
  assertEqual(unknownTarget.harness.connects.filter(url => url.includes('/devtools/page/')).length, 0, 'the page socket was opened for an unknown target')

  const idMismatch = await runEndpointCase({
    pages: [{ id: 'DIFFERENT-ID', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/page/TARGET-A' }],
  })
  assertEqual(idMismatch.error?.code, 'EENDPOINT', 'a page whose id disagrees with its path was accepted')

  const noPage = await runEndpointCase({ pages: [{ id: 'W1', type: 'service_worker', webSocketDebuggerUrl: 'ws://127.0.0.1:51234/devtools/page/W1' }] })
  assertEqual(noPage.error?.code, 'ENOPAGE', 'a port without a page target was accepted')
  assertEqual(noPage.harness.connects.filter(url => url.includes('/devtools/page/')).length, 0, 'a page socket was opened without a page target')
})

await testCase('EP6 合法端点：两个连接都建立，验证阶段不触碰页面', async () => {
  const harness = endpointHarness()
  const result = await connectVerifiedBrowser({
    profileDir: join(testRoot, 'endpoint-valid'),
    readFile: () => VALID_PORT_FILE,
    fetchJson: async () => validPageList,
    connect: harness.connect,
    timeoutMs: 200,
    intervalMs: 5,
  })
  assertEqual(result.port, 51234, 'the verified port must be the one from the port file')
  assertEqual(result.pageId, 'TARGET-A', 'page target id')
  assert(result.browserCdp === harness.browserCdp, 'the browser-level client is not the verified one')
  assert(result.pageCdp === harness.pageCdp, 'the page-level client is not the verified one')
  assertEqual(harness.connects[0], 'ws://127.0.0.1:51234/devtools/browser/BROWSER-1', 'the browser socket must be the one named by the port file')
  assertEqual(harness.connects[1], 'ws://127.0.0.1:51234/devtools/page/TARGET-A', 'the page socket must be the verified target')
  assertEqual(harness.sent.browser.join(','), 'Browser.getVersion,Target.getTargets', 'unexpected browser-level commands')
  assertEqual(harness.sent.page.length, 0, 'the page connection must not be used before verification completes')
  assert(!harness.sent.browser.includes('Browser.close'), 'Browser.close must not be sent during verification')
})

// ---------------------------------------------------------------------------
// F-03  Synchronous exit-time reclamation must obey the same gates
// ---------------------------------------------------------------------------
function syncSession(suffix, extra = {}) {
  return {
    profileDir: join(testRoot, `dsh-em-layout-${stamp}-${suffix}`),
    profileRoot: testRoot,
    browserPid: null,
    reason: 'exit',
    ...extra,
  }
}

await testCase('SR1 同步回收：枚举失败即保留目录，不调用删除', async () => {
  let removeCalls = 0
  const report = syncReapProfile(syncSession('6001'), {
    isAlive: () => false,
    findOwners: () => ({ ok: false, pids: [], detail: 'powershell failed' }),
    assertSafe: () => { throw new Error('must not be reached') },
    removeDir: () => { removeCalls += 1; return { removed: true } },
    terminate: () => ({ ok: true }),
  })
  assertEqual(removeCalls, 0, 'the profile was deleted although ownership could not be read')
  assertEqual(report.directory.removed, false, 'the report claims a deletion')
  assertEqual(report.directory.blocked, 'process ownership unknown', 'the conservative reason is not reported')
  assertEqual(report.directory.detail, 'powershell failed', 'the enumeration failure is not preserved')
})

await testCase('SR2 同步回收：仍有占用进程即保留目录', async () => {
  let removeCalls = 0
  const report = syncReapProfile(syncSession('6002'), {
    isAlive: () => false,
    findOwners: () => ({ ok: true, pids: [4242] }),
    terminate: () => ({ ok: true, refused: false, method: 'taskkill /PID /T /F' }),
    assertSafe: () => { throw new Error('must not be reached') },
    removeDir: () => { removeCalls += 1; return { removed: true } },
  })
  assertEqual(removeCalls, 0, 'the profile was deleted while a process still owned it')
  assertEqual(report.directory.removed, false, 'the report claims a deletion')
  assertEqual(report.directory.blocked, 'a browser still owns the profile', 'the reason is not reported')
  assert(report.lingering.includes(4242), 'the surviving owner is not reported')
})

await testCase('SR3 同步回收：路径闸门拒绝时绝不删除', async () => {
  let removeCalls = 0
  const report = syncReapProfile(syncSession('6003'), {
    isAlive: () => false,
    findOwners: () => ({ ok: true, pids: [] }),
    assertSafe: () => {
      const error = new Error('refusing to use a symlinked profile directory')
      error.code = 'ESYMLINK'
      throw error
    },
    removeDir: () => { removeCalls += 1; return { removed: true } },
    terminate: () => ({ ok: true }),
  })
  assertEqual(removeCalls, 0, 'the directory was deleted without passing the path gate')
  assertEqual(report.directory.rejected, 'refusing to use a symlinked profile directory', 'the rejection is not reported')
})

await testCase('SR4 同步回收：正常路径先校验后删除，且只删一次', async () => {
  const order = []
  const report = syncReapProfile(syncSession('6004'), {
    isAlive: () => false,
    findOwners: () => ({ ok: true, pids: [] }),
    assertSafe: (dir, root, options) => {
      order.push('assertSafe')
      assertEqual(root, testRoot, 'the path gate must receive the profile root')
      assertEqual(options.prefix, LAYOUT_PROFILE_PREFIX, 'the path gate must receive the layout prefix')
      return dir
    },
    removeDir: () => { order.push('removeDir'); return { removed: true, attemptCount: 1, attempts: [] } },
    terminate: () => ({ ok: true }),
  })
  assertEqual(order.join(','), 'assertSafe,removeDir', 'the delete must not run before the path gate')
  assertEqual(report.directory.removed, true, 'a clean profile was not removed')
})

await testCase('SR5 同步回收：--keep-profile 不删除但也不谎报', async () => {
  let removeCalls = 0
  const report = syncReapProfile(syncSession('6005', { keepProfile: true }), {
    isAlive: () => false,
    findOwners: () => ({ ok: true, pids: [] }),
    assertSafe: () => { throw new Error('must not be reached') },
    removeDir: () => { removeCalls += 1; return { removed: true } },
    terminate: () => ({ ok: true }),
  })
  assertEqual(removeCalls, 0, '--keep-profile still deleted the directory')
  assertEqual(report.directory.kept, true, 'the kept directory is not reported as kept')
})

await testCase('SR6 同步回收：终止失败即保留目录并保留错误', async () => {
  let removeCalls = 0
  const report = syncReapProfile(syncSession('6006'), {
    isAlive: () => false,
    findOwners: () => ({ ok: true, pids: [777] }),
    terminate: () => { throw new Error('taskkill exploded') },
    assertSafe: () => { throw new Error('must not be reached') },
    removeDir: () => { removeCalls += 1; return { removed: true } },
  })
  assertEqual(removeCalls, 0, 'the profile was deleted after a failed termination')
  assertEqual(report.directory.blocked, 'termination failed for an owning process', 'the failure is not reported')
  assert(String(report.directory.detail).includes('taskkill exploded'), 'the termination error was swallowed')
})

// ---------------------------------------------------------------------------
// F-04  Signal / exit supervision
// ---------------------------------------------------------------------------
class FakeProcess {
  constructor() {
    this.handlers = new Map()
    this.exited = []
  }
  on(type, handler) {
    const list = this.handlers.get(type) ?? []
    list.push(handler)
    this.handlers.set(type, list)
    return this
  }
  emit(type, payload) {
    for (const handler of [...(this.handlers.get(type) ?? [])]) handler(payload)
  }
  exit(code) {
    throw new Error(`the real process.exit must never be used in tests (code ${String(code)})`)
  }
}

function lifecycleHarness(options = {}) {
  const proc = new FakeProcess()
  const codes = []
  const reasons = []
  let syncReapCalls = 0
  const controller = createLifecycleController({
    process: proc,
    exit: code => { codes.push(code) },
    shutdown: (reason) => {
      reasons.push(reason)
      return options.shutdown === undefined ? Promise.resolve() : options.shutdown(reason)
    },
    syncReap: () => { syncReapCalls += 1 },
    isComplete: options.isComplete ?? (() => false),
    log: { info: () => {}, error: () => {} },
  })
  controller.install()
  return { proc, codes, reasons, controller, get syncReapCalls() { return syncReapCalls } }
}

await testCase('LC1 连续两次 SIGINT：只关闭一次、只退出一次', async () => {
  const before = process.listenerCount('SIGINT')
  const harness = lifecycleHarness()
  harness.proc.emit('SIGINT')
  await tick()
  harness.proc.emit('SIGINT')
  await tick()
  assertEqual(harness.reasons.length, 1, 'the shutdown ran more than once')
  assertEqual(harness.codes.join(','), String(LIFECYCLE_EXIT_CODES.signal), 'the exit code is not the signal code')
  assertEqual(harness.controller.closing, 'signal:SIGINT', 'the closing reason is wrong')
  assertEqual(process.listenerCount('SIGINT'), before, 'the suite registered a real SIGINT listener')
})

await testCase('LC2 SIGTERM 与 SIGINT 竞争：不重复终止或删除', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const harness = lifecycleHarness({ shutdown: () => gate })
  harness.proc.emit('SIGINT')
  harness.proc.emit('SIGTERM')
  await tick()
  assertEqual(harness.reasons.length, 1, 'a second signal re-entered the shutdown')
  assertEqual(harness.reasons[0], 'signal:SIGINT', 'the first reason must win')
  release()
  await tick()
  await tick()
  assertEqual(harness.codes.length, 1, 'the process exit was requested more than once')
})

await testCase('LC3 关闭函数抛错：退出码仍然确定', async () => {
  const harness = lifecycleHarness({ shutdown: () => Promise.reject(new Error('cleanup exploded')) })
  harness.proc.emit('SIGINT')
  await tick()
  await tick()
  assertEqual(harness.codes.join(','), String(LIFECYCLE_EXIT_CODES.signal), 'the exit code is not deterministic')

  const crash = lifecycleHarness({ shutdown: () => Promise.reject(new Error('cleanup exploded')) })
  crash.proc.emit('uncaughtException', new Error('boom'))
  await tick()
  await tick()
  assertEqual(crash.reasons[0], 'uncaughtException', 'the crash reason is wrong')
  assertEqual(crash.codes.join(','), String(LIFECYCLE_EXIT_CODES.failure), 'a crash must not exit with the signal code')
})

await testCase('LC4 finally 与退出兜底竞争：已完成清理不再重复删除', async () => {
  const pending = lifecycleHarness({ isComplete: () => false })
  pending.proc.emit('exit')
  assertEqual(pending.syncReapCalls, 1, 'the synchronous fallback did not run')

  const complete = lifecycleHarness({ isComplete: () => true })
  complete.proc.emit('exit')
  assertEqual(complete.syncReapCalls, 0, 'the synchronous fallback ran on top of a completed shutdown')
})

await testCase('LC5 安装面：只注册 expected 处理器，且不触碰真实进程', async () => {
  const before = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']
    .map(type => `${type}:${String(process.listenerCount(type))}`)
    .join(',')
  const harness = lifecycleHarness()
  const installed = [...harness.proc.handlers.entries()].map(([type, list]) => `${type}:${String(list.length)}`)
  assert(installed.includes('exit:1'), 'the exit handler is not installed on the injected process')
  assert(installed.includes('SIGINT:1') && installed.includes('SIGTERM:1') && installed.includes('SIGHUP:1'), 'not every signal is handled')
  assert(installed.includes('uncaughtException:1') && installed.includes('unhandledRejection:1'), 'the crash handlers are missing')
  const after = ['exit', 'SIGINT', 'SIGTERM', 'SIGHUP', 'uncaughtException', 'unhandledRejection']
    .map(type => `${type}:${String(process.listenerCount(type))}`)
    .join(',')
  assertEqual(after, before, 'the controller touched the real process object')
})

// ---------------------------------------------------------------------------
// F-07  Termination identity guards (real child process, injected taskkill)
// ---------------------------------------------------------------------------
async function spawnSacrificialChild() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  return child
}

function stopSacrificialChild(child) {
  try {
    if (isProcessAlive(child.pid)) child.kill()
  } catch {
    // the child may already be gone
  }
}

await testCase('TK1 身份复核（真实进程）：createdAt 不符即拒绝，taskkill 不被调用', async () => {
  if (process.platform !== 'win32') skip('process identity queries are Windows-only')
  const child = await spawnSacrificialChild()
  try {
    const identity = queryProcessIdentity(child.pid)
    if (identity.ok !== true || identity.found !== true) skip(`process identity could not be read: ${String(identity.detail)}`)
    const kills = []
    const outcome = terminateProcessTree(child.pid, {
      expectedCreatedAt: '19990101000000000',
      requireIdentity: true,
      taskkill: (pid) => { kills.push(pid); return { status: 0, stdout: '', stderr: '' } },
    })
    assertEqual(outcome.refused, true, 'a mismatched creation time was not refused')
    assertEqual(outcome.method, 'identity-mismatch', 'the refusal reason is wrong')
    assertEqual(kills.length, 0, 'taskkill was invoked although identity verification failed')
    assert(isProcessAlive(child.pid), 'the refused process was terminated anyway')
  } finally {
    stopSacrificialChild(child)
  }
})

await testCase('TK2 身份复核（真实进程）：命令行不含该 profile 即拒绝', async () => {
  if (process.platform !== 'win32') skip('process identity queries are Windows-only')
  const child = await spawnSacrificialChild()
  try {
    const kills = []
    const outcome = terminateProcessTree(child.pid, {
      expectedProfileDir: join(testRoot, `dsh-em-layout-${stamp}-7001`),
      requireIdentity: true,
      taskkill: (pid) => { kills.push(pid); return { status: 0, stdout: '', stderr: '' } },
    })
    assertEqual(outcome.refused, true, 'a process without the expected --user-data-dir was not refused')
    assertEqual(kills.length, 0, 'taskkill was invoked for a process that does not own the profile')
    assert(isProcessAlive(child.pid), 'an unrelated process was terminated')
  } finally {
    stopSacrificialChild(child)
  }
})

await testCase('TK3 身份复核（真实进程）：时间戳一致才进入终止流程，且只调用一次', async () => {
  if (process.platform !== 'win32') skip('process identity queries are Windows-only')
  const child = await spawnSacrificialChild()
  try {
    const identity = queryProcessIdentity(child.pid)
    if (identity.ok !== true || identity.found !== true || identity.createdAt === '') {
      skip(`process identity could not be read: ${String(identity.detail)}`)
    }
    const kills = []
    const outcome = terminateProcessTree(child.pid, {
      expectedCreatedAt: identity.createdAt,
      taskkill: (pid) => { kills.push(pid); return { status: 0, stdout: '', stderr: '' } },
    })
    assertEqual(outcome.identityVerified, true, 'the identity check did not report a verified process')
    assertEqual(kills.length, 1, 'the termination path was not entered exactly once')
    assertEqual(kills[0], child.pid, 'a different pid was handed to taskkill')
    assertEqual(outcome.ok, false, 'a no-op taskkill must not be reported as a successful termination')
  } finally {
    stopSacrificialChild(child)
  }
})

await testCase('TK4 身份复核（真实进程）：通过校验后真实回收该子进程', async () => {
  if (process.platform !== 'win32') skip('process identity queries are Windows-only')
  const child = await spawnSacrificialChild()
  try {
    const identity = queryProcessIdentity(child.pid)
    if (identity.ok !== true || identity.found !== true || identity.createdAt === '') {
      skip(`process identity could not be read: ${String(identity.detail)}`)
    }
    const outcome = terminateProcessTree(child.pid, { expectedCreatedAt: identity.createdAt })
    assertEqual(outcome.ok, true, `the sacrificial child survived a verified termination: ${String(outcome.detail)}`)
    assertEqual(waitForExit(child.pid, 5000), true, 'the pid is still alive after a verified termination')
  } finally {
    stopSacrificialChild(child)
  }
})

// ---------------------------------------------------------------------------
// F-11  Launch arguments actually reach the spawn call
// ---------------------------------------------------------------------------
class FakeChildProcess extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
  }
}

await testCase('SP1 启动参数：隔离开关与唯一 profile 真正进入 spawn 参数', async () => {
  const spawnCalls = []
  const child = new FakeChildProcess(4242)
  const profileDir = join(testRoot, `dsh-em-layout-${stamp}-8001`)
  const launch = startBrowser({
    executable: 'C:/fake/chrome.exe',
    args: buildLayoutLaunchArgs(profileDir),
    spawnImpl: (executable, args, options) => {
      spawnCalls.push({ executable, args, options })
      return child
    },
  })
  setImmediate(() => child.emit('spawn'))
  assertEqual(await launch.ready, true, 'the spawn event did not settle the ready promise')
  assertEqual(spawnCalls.length, 1, 'spawn was not called exactly once')
  assertEqual(launch.pid, 4242, 'the tracked pid is not the spawned pid')
  const args = spawnCalls[0].args
  for (const flag of LAYOUT_ISOLATION_ARGS) {
    assert(args.includes(flag), `the isolation switch never reached spawn: ${flag}`)
  }
  assert(args.includes(`--user-data-dir=${profileDir}`), 'the unique profile directory never reached spawn')
  assertEqual(args.filter(item => item.startsWith('--user-data-dir=')).length, 1, 'exactly one profile argument expected')
  assert(!args.some(item => item.startsWith('--user-data-dir=') && item.includes('dsh-em-chrome-')), 'the launch used the shot.mjs namespace')
  assertEqual(spawnCalls[0].options.stdio, 'ignore', 'the browser output is not discarded')
})

await testCase('SP2 启动参数：端口由浏览器分配，且参数顺序可复现', async () => {
  const profileDir = join(testRoot, `dsh-em-layout-${stamp}-8002`)
  const args = buildLayoutLaunchArgs(profileDir)
  assertEqual(args[0], '--disable-sync', 'the isolation switches must come first')
  assert(args.includes('--remote-debugging-port=0'), 'the devtools port is not delegated to the browser')
  assert(!args.some(item => /^--remote-debugging-port=(?!0$)/u.test(item)), 'a fixed devtools port is still requested')
  assert(args.includes('--headless=new'), 'headless mode is missing')
  assertEqual(args.at(-1), 'about:blank', 'the browser must start on about:blank')
  assertEqual(args.join('|'), buildLayoutLaunchArgs(profileDir).join('|'), 'the builder is not deterministic')
})

await testCase('SP3 启动失败：spawn 抛错被收敛，不产生未捕获异常', async () => {
  const launch = startBrowser({
    executable: 'C:/does/not/exist.exe',
    args: ['--headless=new'],
    spawnImpl: () => { throw new Error('spawn ENOENT') },
  })
  assertEqual(await launch.ready, false, 'a throwing spawn must settle ready=false')
  assertEqual(launch.pid, null, 'a failed spawn must not report a pid')
  assertEqual(String(launch.error?.message), 'spawn ENOENT', 'the spawn failure is not preserved')
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
rmSync(testRoot, { recursive: true, force: true })

const skipped = results.filter(entry => entry.skipped === true).length
const passed = results.filter(entry => entry.ok === true && entry.skipped !== true).length
const failed = results.filter(entry => entry.ok !== true).length
console.log('')
console.log(`cases: ${String(results.length)}  passed: ${String(passed)}  skipped: ${String(skipped)}  failed: ${String(failed)}`)
if (failed > 0) {
  for (const entry of results.filter(item => item.ok !== true)) console.log(`  FAILED ${entry.title}: ${entry.error}`)
  process.exitCode = 1
}
