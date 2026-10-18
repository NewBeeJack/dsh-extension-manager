/**
 * Stop the isolated acceptance-test DSH Web server started by start.mjs.
 *
 * Only the recorded pid tree is terminated; no other process is touched.
 *
 * Usage: node scripts/test-env/stop.mjs [--root <dir>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const envRoot = resolve(process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : join(projectRoot, '..', '_test', 'env1'))
const env = JSON.parse(readFileSync(join(envRoot, 'env.json'), 'utf8'))
const pidPath = join(env.out, 'server.pid')
if (!existsSync(pidPath)) {
  console.log('[test-env] no recorded server pid; nothing to stop')
  process.exit(0)
}
const pid = Number(readFileSync(pidPath, 'utf8').trim())
if (!Number.isInteger(pid) || pid <= 0) {
  console.log('[test-env] invalid pid record; removing it')
  rmSync(pidPath, { force: true })
  process.exit(0)
}
try {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    process.kill(-pid, 'SIGTERM')
  }
  console.log(`[test-env] stopped pid tree ${pid}`)
} catch (error) {
  console.log(`[test-env] process tree ${pid} already gone (${error instanceof Error ? error.message : String(error)})`)
}
rmSync(pidPath, { force: true })
