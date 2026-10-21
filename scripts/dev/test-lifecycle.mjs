#!/usr/bin/env node
/**
 * Regression suite for the shot.mjs browser lifecycle.
 *
 * Covers the ten scenarios agreed for the Edge process / profile-directory
 * leak fix. Every integration case runs against a dedicated `--profile-root`
 * so the suite never touches real `%TEMP%` residue, and every case asserts on
 * actual process and filesystem state - not on static code reading.
 *
 * Usage:
 *   node scripts/dev/test-lifecycle.mjs [--browser <path-to-msedge-or-chrome>]
 *
 * Exit code: 0 when every case passes, 1 otherwise.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PROFILE_PREFIX,
  assertSafeProfileDir,
  findProcessesUsingDir,
  isProcessAlive,
  removeDirWithRetry,
  terminateProcessTree,
} from './browser-lifecycle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const shotScript = join(here, 'shot.mjs')
const publicRepoRoot = resolve(here, '..', '..')
const siblingRepoScript = resolve(publicRepoRoot, '..', 'dsh-extension-manager', 'scripts', 'dev', 'shot.mjs')

const PROFILE_NAME = /^dsh-em-chrome-\d{13}-\d{1,4}$/

function cliArg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}

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

function runShot({ script = shotScript, steps = 'steps-shot.json', chrome = browser, sweepHours = 0, extra = [], killAfterMs = 0, root = testRoot } = {}) {
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
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    const timer = killAfterMs > 0
      ? setTimeout(() => { child.kill('SIGTERM') }, killAfterMs)
      : null
    child.on('close', (code, signal) => {
      if (timer !== null) clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr, args: finalArgs })
    })
  })
}

const results = []
let currentCase = null

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function testCase(title, fn) {
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
// 10. Both repository copies
// ---------------------------------------------------------------------------
await testCase('T10 两份副本：内容一致且均通过正常路径', async () => {
  assert(existsSync(siblingRepoScript), `sibling copy missing: ${siblingRepoScript}`)
  const normalize = path => readFileSyncSafe(path).replace(/\r\n/g, '\n').trimEnd()
  assert(normalize(shotScript) === normalize(siblingRepoScript), 'the two shot.mjs copies diverge')

  const otherRoot = join(tmpdir(), `dsh-em-lifecycle-testroot-sibling-${stamp}`)
  mkdirSync(otherRoot, { recursive: true })
  const result = await runShot({ script: siblingRepoScript, root: otherRoot })
  assert(result.code === 0, `sibling copy failed with ${String(result.code)}: ${result.stderr.trim()}`)
  const leftovers = listProfileDirs(otherRoot)
  assert(leftovers.length === 0, `sibling copy leaked ${String(leftovers.length)} directories`)
  rmSync(otherRoot, { recursive: true, force: true })
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
