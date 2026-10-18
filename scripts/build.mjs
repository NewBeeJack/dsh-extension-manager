/**
 * Build script for dsh-extension-manager.
 *
 * Two independent artifacts:
 *  - lib/index.js  — the Host plugin body (ESM, Node, fully bundled so the
 *    installed package needs no runtime dependencies).
 *  - lib/client.js — the Web client bundle, emitted as the loader closure
 *    factory `window.__ModuleLoader__.load({ id, factory })` and resolving
 *    shared platform modules through the injected `require`.
 *
 * Usage: node scripts/build.mjs [--watch]
 */
import { build, context } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const watch = process.argv.includes('--watch')

/** Platform modules the shell injects into every client bundle's `require`. */
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

/** Host-visible half of the package. */
const hostOptions = {
  absWorkingDir: root,
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
  // Bundled CommonJS dependencies (yaml, undici) use dynamic `require`; an ESM
  // bundle needs a real CommonJS resolver in scope for those calls to work.
  banner: {
    js: `// ${pkg.name} ${pkg.version} — Host half
import { createRequire as __dshEmCreateRequire } from 'node:module';
var require = __dshEmCreateRequire(import.meta.url);`,
  },
  sourcemap: false,
}

/** Marker the client loader expects; `id` must equal the package name. */
const CLIENT_HEADER = `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkg.name)}, factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n`
const CLIENT_FOOTER = `\nreturn module.exports;\n} });\n`

/** Emit the browser bundle wrapped in the loader factory closure. */
async function writeClient(options) {
  const result = await build({
    absWorkingDir: root,
    ...options,
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
  console.log(`[build] lib/client.js (${code.length} bytes)`)
}

/** Emit the Host bundle. */
async function writeHost(options) {
  await build(options)
  console.log('[build] lib/index.js')
}

if (!watch) {
  await writeHost(hostOptions)
  await writeClient({ entryPoints: ['src/client/index.tsx'] })
} else {
  const hostContext = await context(hostOptions)
  await hostContext.watch()
  console.log('[build] watching host and client…')
  const clientOptions = {
    entryPoints: ['src/client/index.tsx'],
    plugins: [{
      name: 'client-loader-wrapper',
      setup(pluginBuild) {
        pluginBuild.onEnd(async (result) => {
          if (result.errors.length > 0) return
          const output = result.outputFiles?.[0]
          if (output === undefined) return
          mkdirSync(join(root, 'lib'), { recursive: true })
          writeFileSync(join(root, 'lib/client.js'), CLIENT_HEADER + output.text + CLIENT_FOOTER)
          console.log('[build] lib/client.js updated')
        })
      },
    }],
  }
  const clientContext = await context({
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'react',
    external: CLIENT_EXTERNALS,
    logLevel: 'info',
    ...clientOptions,
  })
  await clientContext.watch()
}
