/**
 * Minimal JSON client for the isolated acceptance environment.
 *
 * Reads the test env's minted browser cookie and talks to the Extension
 * Manager Host API exactly like the Web client does (marker header,
 * same-origin cookie, JSON bodies), then polls tasks until they settle.
 *
 * Usage (as a library):
 *   import { api, callTask, testCookie } from './client.mjs'
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(dirname(here))
export const envRoot = join(projectRoot, '..', '_test', 'env1')
export const cookiePath = join(projectRoot, 'scripts', 'dev', 'cookie-test.json')
export const port = 3099
export const base = `http://127.0.0.1:${String(port)}/api/dsh-extension-manager`

/** Read the test env's minted cookie header value. */
export function testCookie() {
  const cookie = JSON.parse(readFileSync(cookiePath, 'utf8'))
  return `${cookie.name}=${cookie.value}`
}

/** Call one manager endpoint. */
export async function api(path, body) {
  const headers = {
    cookie: testCookie(),
    'x-dsh-extension-manager': '1',
  }
  if (body !== undefined) headers['content-type'] = 'application/json'
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: response.status, body: parsed }
}

/** Poll one task until it settles; returns the final TaskState. */
export async function waitTask(taskId, { timeoutMs = 240_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { body } = await api(`/task/${taskId}`)
    if (body?.task !== undefined && (body.task.status === 'done' || body.task.status === 'failed' || body.task.status === 'cancelled')) {
      return body.task
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(`task ${taskId} did not settle`)
}

/** Call an endpoint that returns a task, then wait for it. */
export async function callTask(path, body) {
  const started = await api(path, body)
  if (started.status !== 200 || started.body?.task === undefined) {
    throw new Error(`${path} failed: HTTP ${String(started.status)} ${JSON.stringify(started.body)}`)
  }
  return { started: started.body, task: await waitTask(started.body.task.id) }
}
