/**
 * Create a local git repository holding a tiny DSH bundle plugin, for the
 * isolated git-provenance update scenario (no public repository required).
 *
 * Usage: node scripts/test-env/prepare-git-plugin.mjs
 * Prints: repository path, initial commit, update commit (both 40-hex).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { envRoot } from './client.mjs'

export const pluginName = 'dsh-em-test-git-plugin'
const repoDir = join(envRoot, 'git-plugin-repo')

/** Run one git command in the fixture repository. */
function git(args, options = {}) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', ...options }).trim()
}

/** Write the plugin package at one version. */
function writePlugin(version) {
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({
    name: pluginName,
    version,
    description: 'Isolated git-provenance fixture bundle for the Extension Manager acceptance run',
    type: 'module',
    main: 'index.js',
    files: ['index.js', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    license: 'MIT',
  }, undefined, 2) + '\n')
  writeFileSync(join(repoDir, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${pluginName}`,
    `      name: '${pluginName}'`,
    '',
  ].join('\n'))
  writeFileSync(join(repoDir, 'index.js'), [
    `export const name = ${JSON.stringify(pluginName)}`,
    'export function apply() {}',
    `// fixture version ${version}`,
    '',
  ].join('\n'))
}

rmSync(repoDir, { recursive: true, force: true })
mkdirSync(repoDir, { recursive: true })
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoDir })
execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repoDir })
execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repoDir })

writePlugin('0.1.0')
git(['add', '-A'])
git(['commit', '-q', '-m', 'fixture: initial bundle'])
const initialCommit = git(['rev-parse', 'HEAD'])

if (process.argv.includes('--initial-only')) {
  console.log(JSON.stringify({
    repoDir,
    initialCommit,
    gitSpec: `${fileUrl()}#${initialCommit}`,
    branchSpec: `${fileUrl()}#main`,
  }, undefined, 2))
  process.exit(0)
}

writePlugin('0.1.1')
writeFileSync(join(repoDir, 'CHANGELOG.md'), '## 0.1.1\n- new version for update scenario\n')
git(['add', '-A'])
git(['commit', '-q', '-m', 'fixture: 0.1.1'])
const updateCommit = git(['rev-parse', 'HEAD'])

/** file:// URL: keep the drive colon, percent-encode spaces (pnpm needs it). */
function fileUrl() {
  const normalized = repoDir.split(String.fromCharCode(92)).join('/')
  return `git+file:///${encodeURI(normalized)}`
}

console.log(JSON.stringify({
  repoDir,
  initialCommit,
  updateCommit,
  gitSpec: `${fileUrl()}#${initialCommit}`,
  updateSpec: `${fileUrl()}#${updateCommit}`,
}, undefined, 2))
if (!existsSync(join(repoDir, '.git'))) throw new Error('fixture repository was not created')
