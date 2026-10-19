/**
 * Manager-owned structured log with size-bounded rotation and secret masking.
 *
 * File: $DSH_HOME/extension-manager/logs/manager.log (1 MiB × 3 files).
 * Every line is one JSON document; no user file contents are logged.
 */
import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 1 << 20
const KEEP_FILES = 3

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/gh[pousr]_[A-Za-z0-9_]{20,}/gu, 'gh***'],
  [/github_pat_[A-Za-z0-9_]{20,}/gu, 'github_pat_***'],
  [/npm_[A-Za-z0-9]{20,}/gu, 'npm_***'],
  [/Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gu, 'Bearer ***'],
  [/(https?:\/\/)[^/@\s]+@/gu, '$1***@'],
  [/(["'](?:token|apiKey|api_key|password|secret)["']\s*:\s*["'])[^"']+(["'])/gu, '$1***$2'],
]

/** Mask recognized credential material in one string. */
export function maskSecrets(text: string): string {
  let masked = text
  for (const [pattern, replacement] of SECRET_PATTERNS) masked = masked.replace(pattern, replacement)
  return masked
}

/** JSON-safe serialization of arbitrary thrown values. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

/** Append-only structured logger. */
export class ManagerLog {
  private queue: Promise<void> = Promise.resolve()
  private readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /** Append one event; failures never propagate into the operation. */
  write(level: 'info' | 'warn' | 'error', event: string, detail?: Record<string, unknown>): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...(detail === undefined ? {} : { detail: maskObject(detail) }),
    }) + '\n'
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await this.rotateIfNeeded()
        await appendFile(this.file, line, 'utf8')
      } catch {
        // Logging must never break a management operation.
      }
    })
  }

  info(event: string, detail?: Record<string, unknown>): void { this.write('info', event, detail) }
  warn(event: string, detail?: Record<string, unknown>): void { this.write('warn', event, detail) }
  error(event: string, detail?: Record<string, unknown>): void { this.write('error', event, detail) }

  /**
   * Append one structured task event. The lifecycle fields stay at the top
   * level (so logs can be filtered by taskId/extensionId), while unknown extra
   * fields remain nested under `detail`; every string is masked.
   */
  event(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown>): void {
    const top: Record<string, unknown> = {}
    const extra: Record<string, unknown> = {}
    const known = new Set(['taskId', 'extensionId', 'extensionType', 'action', 'phase', 'status', 'message', 'errorCode', 'timestamp'])
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue
      if (known.has(key)) top[key] = typeof value === 'string' ? maskSecrets(value) : maskValue(value)
      else extra[key] = maskValue(value)
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...top,
      ...(Object.keys(extra).length === 0 ? {} : { detail: extra }),
    }) + '\n'
    this.queue = this.queue.then(async () => {
      try {
        await mkdir(dirname(this.file), { recursive: true })
        await this.rotateIfNeeded()
        await appendFile(this.file, line, 'utf8')
      } catch {
        // Logging must never break a management operation.
      }
    })
  }

  /** Wait until queued lines are on disk. */
  async flush(): Promise<void> {
    await this.queue
  }

  private async rotateIfNeeded(): Promise<void> {
    const info = await stat(this.file).catch(() => undefined)
    if (info === undefined || info.size < MAX_BYTES) return
    for (let index = KEEP_FILES - 1; index >= 1; index -= 1) {
      const from = `${this.file}.${String(index)}`
      if (existsSync(from)) await rename(from, `${this.file}.${String(index + 1)}`).catch(() => undefined)
    }
    await rename(this.file, `${this.file}.1`).catch(() => undefined)
  }
}

/** Recursively mask strings in a structured detail object. */
function maskObject(value: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) masked[key] = maskValue(item)
  return masked
}

function maskValue(value: unknown): unknown {
  if (typeof value === 'string') return maskSecrets(value)
  if (Array.isArray(value)) return value.map(maskValue)
  if (typeof value === 'object' && value !== null) return maskObject(value as Record<string, unknown>)
  return value
}
