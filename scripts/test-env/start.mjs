/**
 * Start the isolated acceptance-test DSH Web server.
 *
 * Uses a throw-away DSH_HOME/DSH_AGENTS_HOME, a dedicated loopback port, and
 * `--no-open`; the printed authenticated URL is captured to `url.json` so the
 * verification scripts can drive a headless browser with the launch token.
 *
 * Usage: node scripts/test-env/start.mjs [--port 3099] [--root <dir>]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const rootAt = process.argv.indexOf('--root')
const envRoot = resolve(rootAt === -1 ? join(projectRoot, '..', '_test', 'env1') : process.argv[rootAt + 1])
const envFile = join(envRoot, 'env.json')
if (!existsSync(envFile)) {
  console.error(`[test-env] missing ${envFile}; run scripts/test-env/setup.mjs first`)
  process.exit(2)
}
const env = JSON.parse(readFileSync(envFile, 'utf8'))
const portAt = process.argv.indexOf('--port')
const port = portAt === -1 ? 3099 : Number(process.argv[portAt + 1])
mkdirSync(env.out, { recursive: true })

/** Resolve the dsh launcher through PATH / the npm global shim directory. */
function findDsh() {
  const separators = process.platform === 'win32' ? [';', ':'] : [':']
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', ''] : ['']
  const dirs = separators.flatMap(separator => (process.env.PATH ?? '').split(separator)).filter(Boolean)
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `dsh${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  const guess = join(process.env.APPDATA ?? '', 'npm', 'dsh.cmd')
  if (existsSync(guess)) return guess
  throw new Error('dsh launcher not found in PATH')
}

const logPath = join(env.out, 'server.log')
const pidPath = join(env.out, 'server.pid')
const urlPath = join(env.out, 'url.json')
writeFileSync(logPath, '', 'utf8')
const dsh = findDsh()
const argv = ['--profile', 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open']
const childEnv = { ...process.env, DSH_HOME: env.home, DSH_AGENTS_HOME: env.agents, DSH_TELEMETRY_DISABLED: '1' }

/** Resolve the shipped CLI entry so the server is spawned as a real Node process. */
function findCliEntry(launcher) {
  const npmPrefix = dirname(launcher)
  const candidates = process.platform === 'win32'
    ? [join(npmPrefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
    : [join(dirname(npmPrefix), 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

const cliEntry = findCliEntry(dsh)
const logFd = openSync(logPath, 'w')
let child
if (cliEntry !== undefined) {
  child = spawn(process.execPath, [cliEntry, ...argv], {
    cwd: env.workspace,
    env: childEnv,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  })
} else {
  child = spawn(dsh, argv, {
    cwd: env.workspace,
    env: childEnv,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
  })
}
child.unref()
writeFileSync(pidPath, String(child.pid), 'utf8')
console.log(`[test-env] started pid ${child.pid}; log ${logPath}`)

const deadline = Date.now() + 180_000
while (Date.now() < deadline) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 500))
  const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
  const match = /dsh web:\s+(http:\/\/\S+)/u.exec(text)
  if (match?.[1] !== undefined) {
    writeFileSync(urlPath, JSON.stringify({ url: match[1], port, pid: child.pid }, undefined, 2), 'utf8')
    console.log(`[test-env] ready: ${match[1]}`)
    process.exit(0)
  }
  if (/listen EADDRINUSE/u.test(text)) {
    console.error(text.slice(-3000))
    process.exit(1)
  }
}
console.error('[test-env] server did not become ready in 180s; tail of log:')
console.error((existsSync(logPath) ? readFileSync(logPath, 'utf8') : '').slice(-3000))
process.exit(1)
