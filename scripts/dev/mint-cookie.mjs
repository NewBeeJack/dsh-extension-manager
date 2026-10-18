/**
 * Mint the browser-session cookie for the locally running DSH Web GUI.
 *
 * Verification-only helper: it reads the owner's durable signing secret from
 * the DSH credentials store (the same file the Host loaded) and produces the
 * exact `dsh-auth-<hash>` cookie the browser would get from the launch URL.
 * The cookie is written to a file, never printed, so it does not end up in
 * logs or chat transcripts.
 *
 * Usage: node mint-cookie.mjs <authority> <cookie-path>
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'

const authority = process.argv[2] ?? '127.0.0.1:3080'
const outPath = process.argv[3]
if (outPath === undefined) {
  console.error('usage: node mint-cookie.mjs <authority> <cookie-path>')
  process.exit(2)
}
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const credentials = parse(readFileSync(join(home, '.credentials.yaml'), 'utf8'))
const secretText = credentials?.records?.['client-connection/browser-session']?.payload?.secret
if (typeof secretText !== 'string') {
  console.error('browser-session secret not found in credentials store')
  process.exit(1)
}
const secret = Buffer.from(secretText, 'base64url')
const b64url = (value) => Buffer.from(value).toString('base64url')
const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
const issuedAt = Date.now()
const expiresAt = issuedAt + 24 * 60 * 60 * 1000
const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }))
const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
writeFileSync(outPath, JSON.stringify({ name, value, authority }), 'utf8')
console.log(`cookie ${name} (${value.length} chars) -> ${outPath}`)
