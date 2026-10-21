#!/usr/bin/env node
/**
 * Regression suite for the shot.mjs browser lifecycle.
 *
 * WINDOWS-ONLY - by design, not by accident, and it says so rather than
 * pretending to pass:
 *   - reclamation terminates processes with `taskkill /PID <pid> /T /F`, whose
 *     tree semantics have no equivalent that behaves the same way;
 *   - T00 relies on NTFS junctions (`fs.symlinkSync(..., 'junction')`);
 *   - attribution reads Win32_Process through CIM (`Get-CimInstance`), and T05
 *     depends on Windows `TerminateProcess` semantics (no JavaScript runs, so
 *     exactly one directory is expected to leak);
 *   - T10/T14/T15 spawn a real browser and identify it by its `--user-data-dir`.
 * On any other platform the suite prints a skip notice and exits 0 without
 * executing or claiming a single case.
 *
 * Coverage: the ten scenarios agreed for the Edge process / profile-directory
 * leak fix, plus the three P2 follow-ups - reclamation of browsers that left the
 * process tree (T14/T15/T16), one process enumeration for the whole stale sweep
 * (T11/T12/T13), and this Windows-only marker.
 *
 * The suite is self-contained: it never depends on another checkout of the
 * repository being present. Cross-copy isolation is exercised by T10, which
 * builds its own two copies; keeping two working copies byte-identical is a
 * release-step concern, not something this suite can assert without that other
 * checkout.
 *
 * Every integration case runs against a dedicated `--profile-root` so the suite
 * never touches real `%TEMP%` residue, and every case asserts on actual process
 * and filesystem state - not on static code reading.
 *
 * Usage:
 *   node scripts/dev/test-lifecycle.mjs [--browser <path-to-msedge-or-chrome>]
 *                                       [--only <case-prefix>]
 *
 * Exit code: 0 when every executed case passes (or the suite is skipped),
 *            1 otherwise.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_PREFIX,
  assertSafeProfileDir,
  commandLineReferencesProfile,
  createProfileDir,
  findProfileOwners,
  isProcessAlive,
  listBrowserProcesses,
  queryProcessIdentity,
  reapProfileOwners,
  removeDirWithRetry,
  sweepStaleProfiles,
  terminateProcessTree,
} from './browser-lifecycle.mjs'

if (process.platform !== 'win32') {
  console.log('[skip] 生命周期套件仅支持 Windows；未执行任何用例')
  console.log(`       platform: ${process.platform}`)
  console.log('       依赖: taskkill /PID /T /F、NTFS junction、Win32_Process (CIM)')
  console.log('       这是跳过，不是通过；原因见文件头注释')
  process.exit(0)
}

/**
 * Mirrors ISOLATION_ARGS in shot.mjs. T10/T14/T15 launch a browser directly (not
 * through shot.mjs, because they need a browser that is *not* tracked by the
 * script), so the switches are repeated here: keep the two lists in sync.
 */
const SAFE_PROFILE_ARGS = [
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-sync',
  '--disable-features=msEdgeSyncConsent,msImplicitSignin,ImplicitSignInFlowV3,msEdgeIdentityFeature',
  '--no-service-autorun',
  '--disable-background-networking',
]

const here = dirname(fileURLToPath(import.meta.url))
const shotScript = join(here, 'shot.mjs')

const PROFILE_NAME = /^dsh-em-chrome-\d{13}-\d{1,4}$/

const sleepMs = (ms) => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

function cliArg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

/** `--only T10` narrows the run to matching cases while debugging. */
const only = cliArg('only', '')

function resolveBrowser() {
  const explicit = cliArg('browser', process.env.DSH_TEST_BROWSER)
  const candidates = [
    explicit,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean)
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    console.error('[fatal] no browser found; pass --browser <path>')
    process.exit(1)
  }
  return found
}

const browser = resolveBrowser()
const stamp = String(Date.now())
const testRoot = join(tmpdir(), `dsh-em-lifecycle-testroot-${stamp}`)
const fixturesDir = join(tmpdir(), `dsh-em-lifecycle-fixtures-${stamp}`)
const outDir = join(fixturesDir, 'out')

mkdirSync(testRoot, { recursive: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(join(fixturesDir, 'cookie.json'), JSON.stringify({ name: 'lifecycle-probe', value: 'not-a-token' }))
writeFileSync(join(fixturesDir, 'steps-shot.json'), JSON.stringify([{ shot: 'lifecycle-probe' }]))
writeFileSync(join(fixturesDir, 'steps-throw.json'), JSON.stringify([{ eval: "throw new Error('probe-boom')" }]))
writeFileSync(join(fixturesDir, 'steps-badshot.json'), JSON.stringify([{ shot: 'x'.repeat(300) }]))
writeFileSync(join(fixturesDir, 'steps-long.json'), JSON.stringify([{ wait: 45000 }]))

function listProfileDirs(root = testRoot) {
  try {
    return readdirSync(root)
      .filter(name => PROFILE_NAME.test(name))
      .map(name => join(root, name))
  } catch {
    return []
  }
}

function findBrowsersUsingPrefix(prefix) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    'Get-CimInstance Win32_Process',
    "| Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($env:SHOT_PREFIX) }",
    '| Select-Object -ExpandProperty ProcessId',
  ].join(' ')
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, SHOT_PREFIX: prefix },
    timeout: 20000,
  })
  return (result.stdout ?? '').split(/\r?\n/).map(line => Number(line.trim())).filter(value => Number.isInteger(value) && value > 0)
}

function runShot({ script = shotScript, steps = 'steps-shot.json', chrome = browser, sweepHours = 0, extra = [], killAfterMs = 0, root = testRoot, timeoutMs = 180000 } = {}) {
  const finalArgs = [
    script,
    '--chrome', chrome,
    '--cookie', join(fixturesDir, 'cookie.json'),
    '--out', outDir,
    '--steps', join(fixturesDir, steps),
    '--profile-root', root,
    '--sweep-stale-hours', String(sweepHours),
    ...extra,
  ]
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = killAfterMs > 0
      ? setTimeout(() => { child.kill('SIGTERM') }, killAfterMs)
      : null
    // A run that never returns would hang the whole suite: the CDP calls inside
    // shot.mjs have no per-call timeout, so one stalled browser blocks forever.
    // Turn that into a deterministic failure instead of an indefinite wait.
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.on('close', (code, signal) => {
      clearTimeout(deadline)
      if (timer !== null) clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr, args: finalArgs, timedOut })
    })
  })
}

const results = []
let currentCase = null

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function testCase(title, fn) {
  // `--only T10` runs a single case while debugging; the summary then counts
  // only what actually ran.
  if (only !== '' && !title.startsWith(only)) return
  currentCase = title
  const startedAt = Date.now()
  try {
    await fn()
    results.push({ title, ok: true, ms: Date.now() - startedAt })
    console.log(`PASS  ${title}  (${String(Date.now() - startedAt)} ms)`)
  } catch (error) {
    results.push({ title, ok: false, ms: Date.now() - startedAt, error: error.message })
    console.log(`FAIL  ${title}  (${String(Date.now() - startedAt)} ms)`)
    console.log(`        ${error.message}`)
  } finally {
    currentCase = null
  }
}

console.log(`browser:  ${browser}`)
console.log(`testroot: ${testRoot}`)
console.log('')

// ---------------------------------------------------------------------------
// 0. Path safety gates (unit)
// ---------------------------------------------------------------------------
await testCase('T00 路径安全：拒绝根目录之外/符号链接/非约定命名', () => {
  const outside = join(tmpdir(), `dsh-em-outside-${stamp}`)
  mkdirSync(outside, { recursive: true })
  let rejectedOutside = false
  try { assertSafeProfileDir(outside, testRoot) } catch { rejectedOutside = true }
  assert(rejectedOutside, 'directory outside the profile root must be rejected')

  const linkTarget = join(testRoot, `${PROFILE_PREFIX}${stamp}-1111`)
  mkdirSync(linkTarget, { recursive: true })
  const linkPath = join(testRoot, `${PROFILE_PREFIX}${stamp}-2222`)
  symlinkSync(linkTarget, linkPath, 'junction')
  let rejectedLink = false
  try { assertSafeProfileDir(linkPath, testRoot) } catch { rejectedLink = true }
  assert(rejectedLink, 'symlinked/junction profile directory must be rejected')

  const badName = join(testRoot, 'dsh-em-chrome-notatimestamp')
  mkdirSync(badName, { recursive: true })
  let rejectedName = false
  try { assertSafeProfileDir(badName, testRoot) } catch { rejectedName = true }
  assert(rejectedName, 'directory not matching the naming convention must be rejected')

  rmSync(outside, { recursive: true, force: true })
  rmSync(linkPath, { force: true })
  rmSync(linkTarget, { recursive: true, force: true })
  rmSync(badName, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------
await testCase('T01 正常路径：启动-截图-退出，目录与进程零残留', async () => {
  const before = listProfileDirs()
  const result = await runShot()
  assert(result.code === 0, `expected exit 0, got ${String(result.code)}; stderr=${result.stderr.trim()}`)
  assert(existsSync(join(outDir, 'lifecycle-probe.png')), 'screenshot was not written')
  const after = listProfileDirs()
  assert(after.length === before.length, `profile directories grew: ${String(before.length)} -> ${String(after.length)}`)
  const lingering = findBrowsersUsingPrefix(testRoot)
  assert(lingering.length === 0, `browser still alive after exit: pid ${lingering.join(',')}`)
  assert(result.stdout.includes('profile directory removed'), 'cleanup was not reported')
})

// ---------------------------------------------------------------------------
// 2. Browser start failure
// ---------------------------------------------------------------------------
await testCase('T02 启动失败：浏览器可执行文件不存在', async () => {
  const before = listProfileDirs()
  const result = await runShot({ chrome: join(testRoot, 'no-such-browser.exe') })
  assert(result.code === 2, `expected exit 2 for setup failure, got ${String(result.code)}`)
  assert(result.stderr.includes('browser executable not found'), `stderr missing cause: ${result.stderr.trim()}`)
  assert(listProfileDirs().length === before.length, 'profile directory leaked on spawn failure')
})

// ---------------------------------------------------------------------------
// 3. Page/script failure
// ---------------------------------------------------------------------------
await testCase('T03 页面脚本异常：退出码非零且完成回收', async () => {
  const before = listProfileDirs()
  const result = await runShot({ steps: 'steps-throw.json' })
  assert(result.code === 1, `expected exit 1, got ${String(result.code)}`)
  assert(result.stderr.includes('[failed]'), `failure was not reported: ${result.stderr.trim()}`)
  assert(listProfileDirs().length === before.length, 'profile directory leaked after page failure')
  assert(findBrowsersUsingPrefix(testRoot).length === 0, 'browser still alive after page failure')
})

// ---------------------------------------------------------------------------
// 4. Screenshot failure
// ---------------------------------------------------------------------------
await testCase('T04 截图异常：非法文件名不阻断回收', async () => {
  const before = listProfileDirs()
  const result = await runShot({ steps: 'steps-badshot.json' })
  assert(result.code === 1, `expected exit 1, got ${String(result.code)}`)
  assert(listProfileDirs().length === before.length, 'profile directory leaked after screenshot failure')
  assert(findBrowsersUsingPrefix(testRoot).length === 0, 'browser still alive after screenshot failure')
})

// ---------------------------------------------------------------------------
// 5. Interruption
// ---------------------------------------------------------------------------
await testCase('T05 中途强制终止：不留孤儿浏览器，陈旧目录可被下次运行清扫', async () => {
  const before = listProfileDirs()
  const killed = await runShot({ steps: 'steps-long.json', killAfterMs: 4000 })
  assert(killed.code !== 0, 'interrupted run should not report success')
  const lingering = findBrowsersUsingPrefix(testRoot)
  assert(lingering.length === 0, `orphan browser after SIGTERM: pid ${lingering.join(',')}`)
  const leaked = listProfileDirs()
  assert(leaked.length === before.length + 1, `expected exactly one leaked directory after a hard kill, got ${String(leaked.length - before.length)}`)
  await new Promise(resolveWait => setTimeout(resolveWait, 3000))
  const sweep = await runShot({ sweepHours: 0.0005 })
  assert(sweep.code === 0, `sweep run failed with ${String(sweep.code)}`)
  assert(listProfileDirs().length === before.length, 'startup sweep did not reclaim the interrupted run leftover')
})

// ---------------------------------------------------------------------------
// 6. Termination fallback
// ---------------------------------------------------------------------------
await testCase('T06 关闭失败兜底：只终止指定 PID 树，不按进程名批量杀', async () => {
  const target = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  const bystander = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  await new Promise(resolveWait => setTimeout(resolveWait, 1200))
  assert(isProcessAlive(target.pid), 'target process did not start')
  const report = terminateProcessTree(target.pid)
  assert(report.ok, `terminateProcessTree reported failure: ${report.detail}`)
  assert(!isProcessAlive(target.pid), 'target process survived termination')
  assert(isProcessAlive(bystander.pid), 'termination affected an unrelated process')
  target.kill('SIGKILL')
  bystander.kill('SIGKILL')

  const source = readFileSyncSafe(join(here, 'browser-lifecycle.mjs'))
  assert(!/'\s*\/IM\s*'|"\s*\/IM\s*"/.test(source), 'library must not terminate processes by image name')
  assert(!apiSurfaceUsesImageKill(), 'shot.mjs must not terminate processes by image name')
})

function readFileSyncSafe(path) {
  return spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(${JSON.stringify(path)},'utf8'))`], { encoding: 'utf8' }).stdout ?? ''
}

function apiSurfaceUsesImageKill() {
  const source = readFileSyncSafe(shotScript)
  return /\/IM\b/.test(source)
}

// ---------------------------------------------------------------------------
// 7. Delete fails once, then succeeds
// ---------------------------------------------------------------------------
await testCase('T07 删除首次失败：退避重试后成功', () => {
  const dir = join(testRoot, `${PROFILE_PREFIX}${stamp}-7001`)
  mkdirSync(dir, { recursive: true })
  let calls = 0
  const removal = removeDirWithRetry(dir, {
    attempts: 4,
    baseDelayMs: 20,
    rm: (target) => {
      calls += 1
      if (calls === 1) {
        const error = new Error('simulated lock')
        error.code = 'EBUSY'
        throw error
      }
      rmSync(target, { recursive: true, force: true })
    },
  })
  assert(removal.removed, 'retry did not recover from a transient failure')
  assert(removal.attemptCount === 2, `expected 2 attempts, got ${String(removal.attemptCount)}`)
  assert(removal.attempts[0].code === 'EBUSY', 'first attempt error was not recorded')
})

// ---------------------------------------------------------------------------
// 8. Delete keeps failing
// ---------------------------------------------------------------------------
await testCase('T08 删除持续失败：明确报告路径/次数/错误码', () => {
  const dir = join(testRoot, `${PROFILE_PREFIX}${stamp}-8001`)
  mkdirSync(dir, { recursive: true })
  const removal = removeDirWithRetry(dir, {
    attempts: 4,
    baseDelayMs: 10,
    rm: () => {
      const error = new Error('still locked')
      error.code = 'EPERM'
      throw error
    },
  })
  assert(!removal.removed, 'removal must report failure rather than pretend success')
  assert(removal.attemptCount === 4, `expected 4 attempts, got ${String(removal.attemptCount)}`)
  assert(removal.lastError.code === 'EPERM', 'last error code was not preserved')
  assert(removal.attempts.length === 4, 'per-attempt diagnostics were not preserved')
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 9. Ten consecutive runs
// ---------------------------------------------------------------------------
await testCase('T09 连续 10 次运行：目录数不随运行次数增长', async () => {
  const baseline = listProfileDirs().length
  for (let index = 1; index <= 10; index += 1) {
    const result = await runShot()
    assert(result.code === 0, `run ${String(index)} failed with ${String(result.code)}: ${result.stderr.trim()}`)
  }
  const after = listProfileDirs().length
  assert(after === baseline, `profile directories grew after 10 runs: ${String(baseline)} -> ${String(after)}`)
  const lingering = findBrowsersUsingPrefix(testRoot)
  assert(lingering.length === 0, `browsers still alive after 10 runs: pid ${lingering.join(',')}`)
})

// ---------------------------------------------------------------------------
// 10. Two independent copies sharing one profile root (self-contained)
// ---------------------------------------------------------------------------
// This case used to compare the working tree against a sibling checkout
// (`../dsh-extension-manager`). That made a lifecycle test depend on another
// clone being present on the developer's machine, and it could never pass while
// the two copies were intentionally out of sync. It now builds its own two
// copies and asserts the property that actually matters: one copy's startup
// sweep must neither delete a foreign copy's live profile directory nor
// terminate the browser that owns it.
await testCase('T10 双副本隔离：一份副本的清扫不删除也不终止另一副本的活跃 Profile', async () => {
  const sharedRoot = join(tmpdir(), `dsh-em-copies-root-${stamp}`)
  const copies = ['a', 'b'].map(tag => join(tmpdir(), `dsh-em-copy-${tag}-${stamp}`, 'dev'))
  mkdirSync(sharedRoot, { recursive: true })
  for (const copy of copies) {
    mkdirSync(copy, { recursive: true })
    for (const file of ['shot.mjs', 'browser-lifecycle.mjs']) {
      copyFileSync(join(here, file), join(copy, file))
    }
  }
  const [copyA] = copies
  const foreignDir = createProfileDir(sharedRoot)
  const foreign = spawn(browser, [...SAFE_PROFILE_ARGS, `--user-data-dir=${foreignDir}`, 'about:blank'], { stdio: 'ignore' })
  try {
    const owners = await waitForOwners(foreignDir, 25000)
    assert(owners.length > 0, 'the browser of copy B never appeared as an owner of its profile')
    // Age the directory past the sweep cutoff. A long-running verification is
    // exactly the case where only the ownership check can protect it.
    const longAgo = new Date(Date.now() - 30 * 60 * 1000)
    utimesSync(foreignDir, longAgo, longAgo)

    const result = await runShot({ script: join(copyA, 'shot.mjs'), root: sharedRoot, sweepHours: 0.0003 })
    const output = `${result.stdout}${result.stderr}`
    assert(result.code === 0, `copy A failed with ${String(result.code)}${result.timedOut === true ? ' (timed out)' : ''}: ${output.trim()}`)
    assert(existsSync(foreignDir), 'copy A deleted the live profile directory of copy B')
    const stillB = findProfileOwners(foreignDir, listBrowserProcesses().processes)
    assert(stillB.length > 0, 'copy A terminated the browser that belongs to copy B')
    // The reason matters: "newer than cutoff" would mean the directory was
    // protected only by its age, not by the ownership check under test.
    assert(
      output.includes('in use by pid'),
      `copy A did not attribute the directory to the live browser: ${output.trim()}`,
    )
    const remaining = listProfileDirs(sharedRoot)
    assert(
      remaining.length === 1 && remaining[0] === foreignDir,
      `shared root should hold exactly the foreign profile, got ${JSON.stringify(remaining)}`,
    )
  } finally {
    if (isProcessAlive(foreign.pid)) terminateProcessTree(foreign.pid)
    for (const owner of findProfileOwners(foreignDir, listBrowserProcesses().processes ?? [])) {
      terminateProcessTree(owner.pid, { expectedCreatedAt: owner.createdAt, requireIdentity: true })
    }
    removeDirWithRetry(foreignDir, { attempts: 4, baseDelayMs: 150 })
    for (const copy of copies) rmSync(dirname(copy), { recursive: true, force: true })
    rmSync(sharedRoot, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 11. Batch sweep: one enumeration for every candidate (P2-3)
// ---------------------------------------------------------------------------
await testCase('T11 批量清扫：30 个候选目录只用 1 次进程枚举', () => {
  const root = join(tmpdir(), `dsh-em-sweep-batch-${stamp}`)
  mkdirSync(root, { recursive: true })
  const count = 30
  for (let index = 0; index < count; index += 1) {
    mkdirSync(join(root, `${PROFILE_PREFIX}${stamp}-${String(1000 + index)}`), { recursive: true })
  }
  let enumerations = 0
  const startedAt = Date.now()
  const result = sweepStaleProfiles({
    root,
    olderThanHours: 0,
    now: Date.now() + 60000,
    listProcesses: () => { enumerations += 1; return { ok: true, processes: [], detail: '' } },
  })
  const elapsed = Date.now() - startedAt
  assert(enumerations === 1, `expected exactly 1 enumeration for ${String(count)} candidates, got ${String(enumerations)}`)
  assert(result.processQueries === 1, `processQueries reported ${String(result.processQueries)}`)
  assert(result.swept.length === count, `expected ${String(count)} swept, got ${String(result.swept.length)}`)
  assert(result.swept.every(entry => entry.removed), 'some candidates were not removed')
  assert(listProfileDirs(root).length === 0, 'directories remain after the sweep')
  console.log(`        candidates=${String(count)} enumerations=${String(enumerations)} elapsed=${String(elapsed)} ms`)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 12. Batch sweep: in-use candidate is skipped, others still removed
// ---------------------------------------------------------------------------
await testCase('T12 批量清扫：被占用目录跳过，其余目录正常清理', () => {
  const root = join(tmpdir(), `dsh-em-sweep-mixed-${stamp}`)
  mkdirSync(root, { recursive: true })
  const busyDir = join(root, `${PROFILE_PREFIX}${stamp}-2001`)
  const freeDirs = [0, 1, 2].map(index => join(root, `${PROFILE_PREFIX}${stamp}-${String(3000 + index)}`))
  mkdirSync(busyDir, { recursive: true })
  for (const dir of freeDirs) mkdirSync(dir, { recursive: true })
  const result = sweepStaleProfiles({
    root,
    olderThanHours: 0,
    now: Date.now() + 60000,
    listProcesses: () => ({
      ok: true,
      detail: '',
      processes: [{ pid: 4242, name: 'msedge.exe', createdAt: '20260101000000000', commandLine: `--headless=new --user-data-dir=${busyDir}` }],
    }),
  })
  assert(existsSync(busyDir), 'a directory reported in use must not be deleted')
  assert(freeDirs.every(dir => !existsSync(dir)), 'unused candidates were not removed')
  assert(result.skipped.length === 1, `expected 1 skipped entry, got ${String(result.skipped.length)}`)
  assert(result.skipped[0].reason.includes('4242'), `skip reason lost the owning pid: ${result.skipped[0].reason}`)
  assert(result.swept.length === freeDirs.length, `expected ${String(freeDirs.length)} swept, got ${String(result.swept.length)}`)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 13. Batch sweep: enumeration failure must never be read as "free"
// ---------------------------------------------------------------------------
await testCase('T13 批量清扫：进程枚举失败时全部跳过且不删除', () => {
  const root = join(tmpdir(), `dsh-em-sweep-fail-${stamp}`)
  mkdirSync(root, { recursive: true })
  const dirs = [0, 1, 2].map(index => join(root, `${PROFILE_PREFIX}${stamp}-${String(4000 + index)}`))
  for (const dir of dirs) mkdirSync(dir, { recursive: true })
  const result = sweepStaleProfiles({
    root,
    olderThanHours: 0,
    now: Date.now() + 60000,
    listProcesses: () => ({ ok: false, processes: [], detail: 'simulated enumeration failure' }),
  })
  assert(result.swept.length === 0, 'nothing may be deleted while ownership is unknown')
  assert(dirs.every(dir => existsSync(dir)), 'a candidate was deleted on unknown ownership')
  assert(result.skipped.length === dirs.length, `expected ${String(dirs.length)} skipped entries, got ${String(result.skipped.length)}`)
  assert(typeof result.error === 'string' && result.error.includes('simulated'), 'enumeration failure was not surfaced')
  assert(result.processQueries === 1, `expected 1 enumeration attempt, got ${String(result.processQueries)}`)
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 14. Reclaim a browser that is not in our process tree (P2-2)
// ---------------------------------------------------------------------------
async function waitForOwners(dir, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const snapshot = listBrowserProcesses()
    if (snapshot.ok) {
      const owners = findProfileOwners(dir, snapshot.processes)
      if (owners.length > 0) return owners
    }
    await sleepMs(400)
  }
  return []
}

await testCase('T14 残留进程回收：识别并终止只属于本 Profile 的浏览器', async () => {
  const dir = createProfileDir(testRoot)
  const child = spawn(browser, [...SAFE_PROFILE_ARGS, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' })
  let reap = null
  try {
    const owners = await waitForOwners(dir, 25000)
    assert(owners.length > 0, 'the spawned browser never showed up as an owner of its profile directory')
    reap = reapProfileOwners(dir, { root: testRoot, attempts: 3, delayMs: 300 })
    assert(reap.rejected === null, `reclaim was rejected: ${String(reap.rejected)}`)
    assert(reap.terminated.length > 0, 'no process was reclaimed')
    assert(reap.terminated.some(entry => entry.ok), 'every termination attempt failed')
    assert(reap.remaining.length === 0, `owners still alive after reclaim: ${reap.remaining.join(',')}`)
  } finally {
    if (isProcessAlive(child.pid)) terminateProcessTree(child.pid)
    for (const pid of reap?.remaining ?? []) if (isProcessAlive(pid)) terminateProcessTree(pid)
  }
  const removal = removeDirWithRetry(dir, { attempts: 4, baseDelayMs: 150 })
  assert(removal.removed, `profile directory of the reaped browser could not be removed: ${JSON.stringify(removal.lastError)}`)
})

// ---------------------------------------------------------------------------
// 15. Reclaiming one profile must not touch another browser
// ---------------------------------------------------------------------------
await testCase('T15 归属隔离：回收 A 的残留不影响 B 的浏览器', async () => {
  const dirA = createProfileDir(testRoot)
  const dirB = createProfileDir(testRoot)
  const childA = spawn(browser, [...SAFE_PROFILE_ARGS, `--user-data-dir=${dirA}`, 'about:blank'], { stdio: 'ignore' })
  const childB = spawn(browser, [...SAFE_PROFILE_ARGS, `--user-data-dir=${dirB}`, 'about:blank'], { stdio: 'ignore' })
  try {
    const ownersA = await waitForOwners(dirA, 25000)
    assert(ownersA.length > 0, 'browser A never showed up as an owner')
    const ownersB = await waitForOwners(dirB, 25000)
    assert(ownersB.length > 0, 'browser B never showed up as an owner')
    const reap = reapProfileOwners(dirA, { root: testRoot, attempts: 2, delayMs: 300 })
    assert(reap.remaining.length === 0, `A was not fully reclaimed: ${reap.remaining.join(',')}`)
    const stillB = findProfileOwners(dirB, listBrowserProcesses().processes)
    assert(stillB.length > 0, 'reclaiming profile A also killed the browser of profile B')
  } finally {
    for (const [child, dir] of [[childA, dirA], [childB, dirB]]) {
      if (isProcessAlive(child.pid)) terminateProcessTree(child.pid)
      removeDirWithRetry(dir, { attempts: 4, baseDelayMs: 150 })
    }
  }
})

// ---------------------------------------------------------------------------
// 16. Identity checks before terminating
// ---------------------------------------------------------------------------
await testCase('T16 身份复核：PID 不存在或创建时间不符时拒绝终止', async () => {
  const gone = terminateProcessTree(999999999)
  assert(gone.ok === true && gone.method === 'already-exited', 'a non-existent pid must report already-exited')

  const probe = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  try {
    await sleepMs(900)
    assert(isProcessAlive(probe.pid), 'identity probe process did not start')
    const identity = queryProcessIdentity(probe.pid)
    assert(identity.ok && identity.found, `could not read process identity: ${String(identity.detail)}`)
    const mismatch = terminateProcessTree(probe.pid, { expectedCreatedAt: '19990101000000000' })
    assert(mismatch.refused === true, 'termination must be refused when the creation time does not match')
    assert(isProcessAlive(probe.pid), 'process was terminated despite an identity mismatch')
    const matched = terminateProcessTree(probe.pid, { expectedCreatedAt: identity.createdAt })
    assert(matched.ok === true, `termination with matching identity failed: ${String(matched.detail)}`)
    assert(!isProcessAlive(probe.pid), 'process survived a verified termination')
  } finally {
    if (isProcessAlive(probe.pid)) probe.kill('SIGKILL')
  }
})

// ---------------------------------------------------------------------------
// 17. Attribution rules (must never match by prefix, name, or directory alone)
// ---------------------------------------------------------------------------
await testCase('T17 归属判定：前缀/子目录/无参数不匹配，空格路径与引号可匹配', () => {
  const target = `C:\\Temp\\DSH Space\\${PROFILE_PREFIX}${stamp}-42`
  const checks = [
    ['精确（含空格、整参数被引号包裹）', `"--user-data-dir=${target}" --headless=new`, true],
    ['大小写与斜杠混用', `--user-data-dir=${target.toLowerCase().replace(/\\/g, '/')}`, true],
    ['尾部多一个分隔符', `--user-data-dir=${target}\\ --headless`, true],
    ['前缀碰撞 -42 与 -421', `--user-data-dir=${target}1 --headless`, false],
    ['子目录', `--user-data-dir=${target}\\Default`, false],
    ['另一个 profile', '--user-data-dir=C:\\Temp\\dsh-em-chrome-1792600000000-99', false],
    ['完全没有该参数', '--headless=new about:blank', false],
  ]
  const wrong = []
  for (const [label, commandLine, expected] of checks) {
    const actual = commandLineReferencesProfile(commandLine, target)
    if (actual !== expected) wrong.push(`${label} -> ${String(actual)}`)
  }
  assert(wrong.length === 0, `attribution mismatch: ${wrong.join('; ')}`)
  const owners = findProfileOwners(target, checks.map(([label, commandLine], index) => ({ pid: index + 1, commandLine })))
  assert(owners.length === 3, `expected 3 matching processes, got ${String(owners.length)}`)
})

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
rmSync(testRoot, { recursive: true, force: true })
rmSync(fixturesDir, { recursive: true, force: true })

const passed = results.filter(entry => entry.ok).length
const failed = results.length - passed
console.log('')
console.log(`cases: ${String(results.length)}  passed: ${String(passed)}  failed: ${String(failed)}`)
if (failed > 0) {
  for (const entry of results.filter(item => !item.ok)) {
    console.log(`  FAILED ${entry.title}: ${entry.error}`)
  }
  process.exitCode = 1
}
