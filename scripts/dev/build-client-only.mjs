/**
 * DEV-ONLY helper: build just the Web client bundle (lib/client.js).
 *
 * The shipped build (`node scripts/build.mjs`) rebuilds the Host half too. While
 * the Host workstream is still landing, client visual work must not redeploy a
 * partial Host plugin into the running DSH instances, so this helper mirrors the
 * client half of scripts/build.mjs only. It is not part of the published package.
 *
 * Usage: node scripts/dev/build-client-only.mjs
 */
import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const CLIENT_HEADER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n`
const CLIENT_FOOTER = `\nreturn module.exports;\n} });\n`

const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'react',
  external: CLIENT_EXTERNALS,
  logLevel: 'info',
  sourcemap: false,
})
const code = result.outputFiles.map((file) => file.text).join('\n')
mkdirSync(join(root, 'lib'), { recursive: true })
writeFileSync(join(root, 'lib/client.js'), CLIENT_HEADER + code + CLIENT_FOOTER)
console.log(`[build-client-only] lib/client.js (${code.length} bytes)`)
