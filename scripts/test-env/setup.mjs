/**
 * Isolated acceptance-test environment for the Extension Manager.
 *
 * Creates a throw-away DSH home + agents home + a demo workspace with fixture
 * skills. The real `~/.dsh` and `~/.agents` are never touched.
 *
 * Usage: node scripts/test-env/setup.mjs [rootDir]
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const root = resolve(process.argv[2] ?? join(projectRoot, '..', '_test', 'env1'))

const dirs = {
  root,
  home: join(root, 'dsh-home'),
  agents: join(root, 'agents-home'),
  workspace: join(root, 'workspace', 'demo-project'),
  out: join(root, 'out'),
}
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true })

/** Write one fixture skill directory. */
function skill(rootDir, name, description, options = {}) {
  const dir = join(rootDir, name)
  mkdirSync(join(dir, 'references'), { recursive: true })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  const invocation = options.modelInvocable === false ? 'disable-model-invocation: true\n' : ''
  writeFileSync(join(dir, 'SKILL.md'), `---
name: ${name}
description: ${description}
${invocation}metadata:
  fixture: true
---

# ${name}

This fixture skill belongs to the isolated acceptance environment.

## Use it when
The test asks for ${name}.
`)
  writeFileSync(join(dir, 'references', 'notes.md'), `# ${name} notes\nfixture resource file\n`)
  writeFileSync(join(dir, 'scripts', 'run.mjs'), `console.log(${JSON.stringify(name)})\n`)
  return dir
}

// Shared agent skills root: one directory bundle, one flat markdown skill, one duplicate name.
skill(join(dirs.agents, 'skills'), 'shared-report-writer', 'Draft and refine reports from notes.')
skill(join(dirs.agents, 'skills'), 'shared-data-crunch', 'Summarize tabular data into tables.')
writeFileSync(join(dirs.agents, 'skills', 'flat-note.md'), `---
name: flat-note
description: A flat markdown fixture skill.
---

Flat fixture body.
`)
skill(join(dirs.agents, 'skills'), 'dup-skill', 'The agents-home copy of a duplicated skill name.')

// User DSH skills root: same name as one agents copy (shadowing) + a model-hidden skill.
skill(join(dirs.home, 'skills'), 'dup-skill', 'The DSH-home copy that wins the name in the user layer.')
skill(join(dirs.home, 'skills'), 'hidden-helper', 'A skill the model may not invoke.', { modelInvocable: false })

// Workspace project roots: project-level skills outrank user-level copies.
mkdirSync(join(dirs.workspace, '.git'), { recursive: true })
writeFileSync(join(dirs.workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n')
skill(join(dirs.workspace, '.agents', 'skills'), 'project-notes', 'Project-scoped fixture skill.')
skill(join(dirs.workspace, '.dsh', 'skills'), 'dup-skill', 'The project copy that wins over every user copy.')

const manifest = {
  version: 1,
  root,
  home: dirs.home,
  agents: dirs.agents,
  workspace: dirs.workspace,
  out: dirs.out,
}
writeFileSync(join(root, 'env.json'), JSON.stringify(manifest, undefined, 2), 'utf8')
console.log(`[test-env] ready at ${root}`)
console.log(`[test-env] DSH_HOME=${dirs.home}`)
console.log(`[test-env] DSH_AGENTS_HOME=${dirs.agents}`)
if (!existsSync(join(dirs.home, 'profiles'))) console.log('[test-env] profile will be initialized on first server start')
