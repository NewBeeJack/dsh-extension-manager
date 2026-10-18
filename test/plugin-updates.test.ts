/**
 * Unit tests for the plugin update-checker primitives.
 *
 * Run with Node's native TypeScript runner (no build step, no network):
 *   node --test test/plugin-updates.test.ts
 *
 * Everything tested here is a pure function exported by `npmClient.ts` (registry
 * policy, packument parsing, version selection, DSH compatibility, proxy
 * selection) or `gitClient.ts` (install-spec parsing, GitHub URL parsing,
 * pnpm-lock resolution). The orchestration in `pluginUpdates.ts` is exercised
 * separately by an integration smoke run against the real registries.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NpmFetchError,
  OFFICIAL_NPM_REGISTRY,
  NPMMIRROR_REGISTRY,
  buildRegistryPolicy,
  describeRegistry,
  downloadTarball,
  evaluatePluginCompatibility,
  fetchNpmDocument,
  isPublicRegistry,
  manifestOf,
  normalizeRegistryUrl,
  normalizeSemver,
  packageDocumentUrl,
  parsePackument,
  proxyForUrl,
  selectUpdateCandidate,
  tarballUrlOf,
  type RegistryConfig,
} from '../src/host/updates/npmClient.ts'
import {
  isCommitRef,
  isTagRef,
  parseGitHostUrl,
  parseGitSpec,
  parseLockfileGitResolution,
  parseLockfileGitResolutions,
  parseLsRemoteOutput,
  resolveRemoteCommit,
  splitLockfileKey,
} from '../src/host/updates/gitClient.ts'

const PUBLIC_CONFIG: RegistryConfig = {
  registry: OFFICIAL_NPM_REGISTRY,
  fallbackRegistries: [NPMMIRROR_REGISTRY],
  resolved: OFFICIAL_NPM_REGISTRY,
}

test('npm: registry URL normalization and public detection', () => {
  assert.equal(normalizeRegistryUrl('https://registry.npmjs.org'), 'https://registry.npmjs.org/')
  assert.equal(normalizeRegistryUrl('  https://registry.example.com/mirror '), 'https://registry.example.com/mirror/')
  assert.throws(() => normalizeRegistryUrl('ftp://registry.example.com/'))
  assert.equal(isPublicRegistry('https://registry.npmjs.org/'), true)
  assert.equal(isPublicRegistry('https://registry.npmmirror.com'), true)
  assert.equal(isPublicRegistry('https://npm.corp.example/'), false)
  assert.equal(isPublicRegistry(null), false)
  assert.equal(describeRegistry('https://registry.npmjs.org/'), 'registry.npmjs.org')
  assert.equal(describeRegistry(null), 'pnpm 配置的 registry')
})

test('npm: public registries may fall back to each other', () => {
  const policy = buildRegistryPolicy(PUBLIC_CONFIG)
  assert.deepEqual(policy.plan, [OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY])
  assert.equal(policy.registry, OFFICIAL_NPM_REGISTRY)
  assert.deepEqual(policy.fallbackRegistries, [NPMMIRROR_REGISTRY])
  assert.equal(policy.allowFallback, true)
  assert.equal(policy.resolved, OFFICIAL_NPM_REGISTRY)
})

test('npm: a private registry is asked alone and never falls back to a public mirror', () => {
  const policy = buildRegistryPolicy({
    registry: 'https://npm.corp.example/registry',
    fallbackRegistries: [NPMMIRROR_REGISTRY],
    resolved: 'https://npm.corp.example/registry',
  })
  assert.deepEqual(policy.plan, ['https://npm.corp.example/registry/'])
  assert.deepEqual(policy.fallbackRegistries, [])
  assert.equal(policy.allowFallback, false)
  assert.equal(policy.registry, 'https://npm.corp.example/registry/')
})

test('npm: pnpm-owned registry is only part of the plan when it is known to be public', () => {
  const publicOwn = buildRegistryPolicy({
    registry: null,
    fallbackRegistries: [NPMMIRROR_REGISTRY],
    resolved: OFFICIAL_NPM_REGISTRY,
  })
  assert.deepEqual(publicOwn.plan, [null, NPMMIRROR_REGISTRY])
  assert.equal(publicOwn.registry, null)
  assert.equal(publicOwn.allowFallback, true)
  assert.equal(publicOwn.resolved, OFFICIAL_NPM_REGISTRY)

  const privateOwn = buildRegistryPolicy({
    registry: null,
    fallbackRegistries: [NPMMIRROR_REGISTRY],
    resolved: 'https://npm.corp.example/',
  })
  assert.deepEqual(privateOwn.plan, [null])
  assert.equal(privateOwn.allowFallback, false)

  const unknownOwn = buildRegistryPolicy({ registry: null, fallbackRegistries: [], resolved: null })
  assert.deepEqual(unknownOwn.plan, [null])
  assert.equal(unknownOwn.resolved, null)
})

test('npm: a requested registry outside the configured set is asked alone; duplicates collapse', () => {
  const requested = buildRegistryPolicy(PUBLIC_CONFIG, 'https://private.example/')
  assert.deepEqual(requested.plan, ['https://private.example/'])

  const duplicate = buildRegistryPolicy({
    registry: OFFICIAL_NPM_REGISTRY,
    fallbackRegistries: [OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY],
    resolved: OFFICIAL_NPM_REGISTRY,
  })
  assert.deepEqual(duplicate.plan, [OFFICIAL_NPM_REGISTRY, NPMMIRROR_REGISTRY])
})

test('npm: package document URLs encode scoped names', () => {
  assert.equal(packageDocumentUrl('dsh-context', OFFICIAL_NPM_REGISTRY), 'https://registry.npmjs.org/dsh-context')
  assert.equal(
    packageDocumentUrl('@michengai/dsh-skills-manager', OFFICIAL_NPM_REGISTRY),
    'https://registry.npmjs.org/@michengai%2Fdsh-skills-manager',
  )
  assert.equal(
    packageDocumentUrl('pkg', 'https://registry.npmmirror.com'),
    'https://registry.npmmirror.com/pkg',
  )
})

test('npm: an unreadable pnpm registry asks nothing, so nothing leaks to a public mirror', async () => {
  const policy = buildRegistryPolicy({ registry: null, fallbackRegistries: [], resolved: null })
  const outcome = await fetchNpmDocument('dsh-context', { policy, timeoutMs: 1000 })
  assert.equal(outcome.status, 'unavailable')
  if (outcome.status !== 'unavailable') return
  assert.equal(outcome.attempts.length, 1)
  assert.equal(outcome.attempts[0]?.kind, 'unconfigured')
})

test('npm: a private registry is the only registry attempted', async () => {
  const policy = buildRegistryPolicy({
    registry: 'http://127.0.0.1:9/',
    fallbackRegistries: [NPMMIRROR_REGISTRY],
    resolved: 'http://127.0.0.1:9/',
  })
  const outcome = await fetchNpmDocument('dsh-context', { policy, timeoutMs: 2000 })
  assert.notEqual(outcome.status, 'ok')
  if (outcome.status !== 'unavailable') return
  assert.equal(outcome.attempts.length, 1)
  assert.equal(outcome.attempts[0]?.registry, 'http://127.0.0.1:9/')
  assert.equal(outcome.attempts[0]?.kind, 'network')
})

test('npm: packument parsing keeps tags, versions, engines and peers', () => {
  const document = parsePackument(JSON.stringify({
    name: 'demo-plugin',
    'dist-tags': { latest: '1.2.0', next: '2.0.0-rc.1', broken: 42 },
    versions: {
      '1.2.0': {
        name: 'demo-plugin',
        version: '1.2.0',
        engines: { dsh: '>=0.2.0' },
        dist: { tarball: 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.2.0.tgz', integrity: 'sha512-x' },
      },
    },
  }))
  assert.ok(document !== undefined)
  assert.deepEqual(document['dist-tags'], { latest: '1.2.0', next: '2.0.0-rc.1' })
  const manifest = manifestOf(document, '1.2.0')
  assert.equal(manifest?.engines?.dsh, '>=0.2.0')
  assert.equal(tarballUrlOf(manifest), 'https://registry.npmjs.org/demo-plugin/-/demo-plugin-1.2.0.tgz')
  assert.equal(manifestOf(document, '9.9.9'), undefined)

  assert.equal(parsePackument('not json'), undefined)
  assert.equal(parsePackument('[]'), undefined)
  assert.equal(parsePackument(JSON.stringify({ error: 'not found' })), undefined)
})

test('npm: semver normalization rejects ranges', () => {
  assert.equal(normalizeSemver('1.2.3'), '1.2.3')
  assert.equal(normalizeSemver('v1.2.3'), '1.2.3')
  assert.equal(normalizeSemver(' =1.2.3 '), '1.2.3')
  assert.equal(normalizeSemver('1.2.3-rc.2'), '1.2.3-rc.2')
  assert.equal(normalizeSemver('^1.2.3'), undefined)
  assert.equal(normalizeSemver('latest'), undefined)
  assert.equal(normalizeSemver(''), undefined)
  assert.equal(normalizeSemver(undefined), undefined)
})

test('npm: a newer stable release is an update', () => {
  const evaluation = selectUpdateCandidate({ latest: '1.2.0' }, '1.1.0')
  assert.equal(evaluation.kind, 'update-available')
  if (evaluation.kind !== 'update-available') return
  assert.equal(evaluation.candidate.version, '1.2.0')
  assert.equal(evaluation.candidate.tag, 'latest')
  assert.equal(evaluation.candidate.channel, 'stable')
  assert.equal(evaluation.currentIsPrerelease, false)
})

test('npm: the installed version being latest is up to date, never a downgrade', () => {
  assert.equal(selectUpdateCandidate({ latest: '1.2.0' }, '1.2.0').kind, 'up-to-date')
  const ahead = selectUpdateCandidate({ latest: '1.0.0' }, '1.3.0')
  assert.equal(ahead.kind, 'up-to-date')
  if (ahead.kind !== 'up-to-date') return
  assert.equal(ahead.version, '1.0.0')
  assert.equal(ahead.channel, 'stable')
})

test('npm: a newer prerelease is reported as prerelease-only for a stable install', () => {
  const evaluation = selectUpdateCandidate({ latest: '1.1.0', next: '1.2.0-rc.1' }, '1.1.0')
  assert.equal(evaluation.kind, 'prerelease-only')
  if (evaluation.kind !== 'prerelease-only') return
  assert.equal(evaluation.candidate.version, '1.2.0-rc.1')
  assert.equal(evaluation.candidate.channel, 'prerelease')
  assert.equal(evaluation.stable?.version, '1.1.0')
})

test('npm: prerelease installs follow both stable and prerelease channels', () => {
  const graduation = selectUpdateCandidate({ latest: '1.2.0', next: '1.2.1-rc.1' }, '1.2.0-rc.2')
  assert.equal(graduation.kind, 'update-available')
  if (graduation.kind !== 'update-available') return
  assert.equal(graduation.candidate.version, '1.2.0')
  assert.equal(graduation.currentIsPrerelease, true)

  const newerPrerelease = selectUpdateCandidate({ latest: '1.1.0', next: '1.2.0-rc.3' }, '1.2.0-rc.2')
  assert.equal(newerPrerelease.kind, 'update-available')
  if (newerPrerelease.kind !== 'update-available') return
  assert.equal(newerPrerelease.candidate.version, '1.2.0-rc.3')
  assert.equal(newerPrerelease.candidate.channel, 'prerelease')
})

test('npm: an older prerelease tag never counts as an update', () => {
  const evaluation = selectUpdateCandidate({ latest: '0.28.0', beta: '0.12.0-beta.1' }, '0.28.0')
  assert.equal(evaluation.kind, 'up-to-date')
  const rc = selectUpdateCandidate({ latest: '1.0.0', rc: '2.0.0-rc.1' }, '1.0.0')
  assert.equal(rc.kind, 'prerelease-only')
  if (rc.kind !== 'prerelease-only') return
  assert.equal(rc.candidate.version, '2.0.0-rc.1')
})

test('npm: missing or unusable tags yield no candidate', () => {
  assert.equal(selectUpdateCandidate({}, '1.0.0').kind, 'no-candidate')
  assert.equal(selectUpdateCandidate(undefined, '1.0.0').kind, 'no-candidate')
  assert.equal(selectUpdateCandidate({ latest: 'main' }, '1.0.0').kind, 'no-candidate')
  assert.equal(selectUpdateCandidate({ latest: '1.0.0' }, 'not-a-version').kind, 'no-candidate')
})

test('compatibility: engines.dsh decides alone, exactly like app-boot', () => {
  const compatible = evaluatePluginCompatibility({ engines: { dsh: '>=0.2.0-rc.2' } }, '0.2.1-rc.2')
  assert.deepEqual(compatible, { compatibility: 'compatible', requirements: {} })

  const incompatible = evaluatePluginCompatibility({ engines: { dsh: '>=0.3.0' } }, '0.2.1-rc.2')
  assert.equal(incompatible.compatibility, 'incompatible')
  assert.deepEqual(incompatible.requirements, { 'engines.dsh': '>=0.3.0' })

  // engines.dsh wins even when peer dependencies would otherwise be unmet.
  const precedence = evaluatePluginCompatibility({
    engines: { dsh: '>=0.2.0-rc.2' },
    peerDependencies: { '@deepseek-ai/dsh-llm': '^9.0.0' },
  }, '0.2.1-rc.2')
  assert.equal(precedence.compatibility, 'compatible')
})

test('compatibility: every @deepseek-ai/dsh peer must match, other peers are ignored', () => {
  const compatible = evaluatePluginCompatibility({
    peerDependencies: {
      '@deepseek-ai/cordis': '>=4.0.1 <5.0.0',
      '@deepseek-ai/dsh-llm': '^0.2.1-rc.1',
      react: '^18.2.0',
    },
  }, '0.2.1-rc.2')
  assert.equal(compatible.compatibility, 'compatible')

  const incompatible = evaluatePluginCompatibility({
    peerDependencies: {
      '@deepseek-ai/dsh-llm': '^0.1.0',
      '@deepseek-ai/dsh': '^0.1.0',
      react: '^18.2.0',
    },
  }, '0.2.1-rc.2')
  assert.equal(incompatible.compatibility, 'incompatible')
  assert.deepEqual(incompatible.requirements, {
    '@deepseek-ai/dsh-llm': '^0.1.0',
    '@deepseek-ai/dsh': '^0.1.0',
  })
})

test('compatibility: workspace ranges mean the running runtime; empty ranges are unmet', () => {
  const workspace = evaluatePluginCompatibility({
    peerDependencies: { '@deepseek-ai/dsh-tools': 'workspace:*' },
  }, '0.2.1-rc.2')
  assert.equal(workspace.compatibility, 'compatible')

  const empty = evaluatePluginCompatibility({
    peerDependencies: { '@deepseek-ai/dsh-tools': '' },
  }, '0.2.1-rc.2')
  assert.equal(empty.compatibility, 'incompatible')
  assert.deepEqual(empty.requirements, { '@deepseek-ai/dsh-tools': '' })
})

test('compatibility: prereleases participate in ranges', () => {
  const range = evaluatePluginCompatibility({ engines: { dsh: '>=0.2.0-rc.2' } }, '0.2.1-rc.2')
  assert.equal(range.compatibility, 'compatible')
  const dshPeer = evaluatePluginCompatibility({
    peerDependencies: { '@deepseek-ai/dsh-session': '^0.2.1-rc.1' },
  }, '0.2.1-rc.2')
  assert.equal(dshPeer.compatibility, 'compatible')
})

test('compatibility: unknown instead of a guess when data is missing or malformed', () => {
  assert.equal(evaluatePluginCompatibility({}, undefined).compatibility, 'unknown')
  assert.equal(evaluatePluginCompatibility(undefined, '0.2.1-rc.2').compatibility, 'unknown')
  const malformedEngine = evaluatePluginCompatibility({ engines: { dsh: 42 } as never }, '0.2.1-rc.2')
  assert.equal(malformedEngine.compatibility, 'unknown')
  const malformedPeer = evaluatePluginCompatibility({
    peerDependencies: { '@deepseek-ai/dsh-session': 42 } as never,
  }, '0.2.1-rc.2')
  assert.equal(malformedPeer.compatibility, 'unknown')
  assert.equal(evaluatePluginCompatibility({}, '0.2.1-rc.2').compatibility, 'compatible')
})

test('proxy: HTTPS_PROXY / NO_PROXY selection', () => {
  assert.equal(proxyForUrl({}, 'https://registry.npmjs.org/dsh-context'), undefined)
  assert.equal(
    proxyForUrl({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, 'https://registry.npmjs.org/dsh-context'),
    'http://127.0.0.1:7890/',
  )
  assert.equal(
    proxyForUrl({ https_proxy: 'http://proxy.example:8080' }, 'https://registry.npmjs.org/x'),
    'http://proxy.example:8080/',
  )
  assert.equal(
    proxyForUrl({ HTTPS_PROXY: 'nonsense-value' }, 'https://registry.npmjs.org/x'),
    undefined,
  )
  const proxyEnv = { HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost, .npmjs.org' }
  assert.equal(proxyForUrl(proxyEnv, 'https://registry.npmjs.org/x'), undefined)
  assert.equal(proxyForUrl(proxyEnv, 'https://sub.npmjs.org/x'), undefined)
  assert.equal(proxyForUrl(proxyEnv, 'https://registry.npmmirror.com/x'), 'http://127.0.0.1:7890/')
  assert.equal(proxyForUrl({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: '*' }, 'https://example.com/x'), undefined)
  assert.equal(
    proxyForUrl({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'registry.npmjs.org:8443' }, 'https://registry.npmjs.org/x'),
    'http://127.0.0.1:7890/',
  )
})

test('git: install specs parse into a clone URL plus ref', () => {
  const shorthand = parseGitSpec('github:octocat/Hello-World#main')
  assert.equal(shorthand?.url, 'https://github.com/octocat/Hello-World.git')
  assert.equal(shorthand?.provider, 'github')
  assert.equal(shorthand?.repo, 'octocat/Hello-World')
  assert.equal(shorthand?.ref, 'main')
  assert.equal(shorthand?.refType, 'branch')

  const https = parseGitSpec('git+https://github.com/octocat/Hello-World.git#abc1234')
  assert.equal(https?.url, 'https://github.com/octocat/Hello-World.git')
  assert.equal(https?.ref, 'abc1234')
  assert.equal(https?.refType, 'commit')

  const scp = parseGitSpec('git@github.com:octocat/Hello-World.git#master')
  assert.equal(scp?.url, 'git@github.com:octocat/Hello-World.git')
  assert.equal(scp?.host, 'github.com')
  assert.equal(scp?.repo, 'octocat/Hello-World')
  assert.equal(scp?.ref, 'master')

  const ssh = parseGitSpec('git+ssh://git@example.com:2222/owner/repo.git')
  assert.equal(ssh?.url, 'ssh://git@example.com:2222/owner/repo.git')
  assert.equal(ssh?.host, 'example.com')

  const semverRange = parseGitSpec('github:owner/repo#semver:^1.2.0')
  assert.equal(semverRange?.ref, '^1.2.0')
  assert.equal(semverRange?.refType, 'semver')

  const pathFragment = parseGitSpec('github:owner/repo#path:/packages/plugin')
  assert.equal(pathFragment?.subdir, 'packages/plugin')

  const tagged = parseGitSpec('github:owner/repo#v1.2.3')
  assert.equal(tagged?.refType, 'tag')

  const gitPrefix = parseGitSpec('git:github.com/owner/repo.git')
  assert.equal(gitPrefix?.url, 'https://github.com/owner/repo.git')

  assert.equal(parseGitSpec('dsh-context'), undefined)
  assert.equal(parseGitSpec('@michengai/dsh-skills-manager'), undefined)
  assert.equal(parseGitSpec('1.2.3'), undefined)
  assert.equal(parseGitSpec(''), undefined)
  assert.equal(parseGitSpec(undefined), undefined)
  assert.equal(isCommitRef('abc1234'), true)
  assert.equal(isCommitRef('main'), false)
  assert.equal(isTagRef('v1.2.3'), true)
  assert.equal(isTagRef('main'), false)
})

test('git: GitHub/GitLab/Bitbucket web URLs expose owner, repo, ref and subdir', () => {
  const github = parseGitHostUrl('https://github.com/octocat/Hello-World/tree/master/some/dir')
  assert.equal(github?.provider, 'github')
  assert.equal(github?.owner, 'octocat')
  assert.equal(github?.repo, 'Hello-World')
  assert.equal(github?.ref, 'master')
  assert.equal(github?.subdir, 'some/dir')
  assert.equal(github?.cloneUrl, 'https://github.com/octocat/Hello-World.git')

  const plain = parseGitHostUrl('https://github.com/owner/repo.git')
  assert.equal(plain?.ref, undefined)
  assert.equal(plain?.webUrl, 'https://github.com/owner/repo')

  const gitlab = parseGitHostUrl('https://gitlab.com/owner/repo/-/tree/main/packages/plugin')
  assert.equal(gitlab?.provider, 'gitlab')
  assert.equal(gitlab?.ref, 'main')
  assert.equal(gitlab?.subdir, 'packages/plugin')

  const bitbucket = parseGitHostUrl('https://bitbucket.org/owner/repo/src/main/sub')
  assert.equal(bitbucket?.provider, 'bitbucket')
  assert.equal(bitbucket?.ref, 'main')

  assert.equal(parseGitHostUrl('https://not-a-git-host.example/owner/repo'), undefined)
  assert.equal(parseGitHostUrl('git@github.com:owner/repo.git'), undefined)
  assert.equal(parseGitHostUrl('github:owner/repo'), undefined)
})

test('git: lockfile keys split into name and version for scoped and legacy layouts', () => {
  assert.deepEqual(splitLockfileKey('@scope/pkg@1.2.3'), { name: '@scope/pkg', version: '1.2.3' })
  assert.deepEqual(splitLockfileKey('pkg@1.2.3'), { name: 'pkg', version: '1.2.3' })
  assert.deepEqual(splitLockfileKey('/pkg@1.2.3'), { name: 'pkg', version: '1.2.3' })
  assert.deepEqual(
    splitLockfileKey('@scope/pkg@git+ssh://git@github.com/o/r.git#0123456789abcdef0123456789abcdef01234567'),
    { name: '@scope/pkg', version: 'git+ssh://git@github.com/o/r.git#0123456789abcdef0123456789abcdef01234567' },
  )
})

const LOCKFILE_V9 = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dsh-git-plugin:
        specifier: github:owner/dsh-git-plugin
        version: git+https://github.com/owner/dsh-git-plugin.git#0123456789abcdef0123456789abcdef01234567
packages:
  dsh-git-plugin@https://github.com/owner/dsh-git-plugin.git#0123456789abcdef0123456789abcdef01234567:
    resolution: {commit: 0123456789abcdef0123456789abcdef01234567, repo: https://github.com/owner/dsh-git-plugin.git, type: git}
snapshots:
  dsh-git-plugin@https://github.com/owner/dsh-git-plugin.git#0123456789abcdef0123456789abcdef01234567: {}
`

const LOCKFILE_V6 = `lockfileVersion: '6.0'
importers:
  .:
    dependencies:
      '@scope/git-plugin':
        specifier: github:scope/git-plugin#v1.2.3
        version: github.com/scope/git-plugin/89abcdef0123456789abcdef0123456789abcdef
packages:
  /@scope/git-plugin@github.com/scope/git-plugin/89abcdef0123456789abcdef0123456789abcdef:
    resolution: {tarball: https://codeload.github.com/scope/git-plugin/tar.gz/89abcdef0123456789abcdef0123456789abcdef}
`

test('git: pnpm-lock v9 resolution commit is read and normalized', () => {
  const resolution = parseLockfileGitResolution(LOCKFILE_V9, 'dsh-git-plugin')
  assert.ok(resolution !== undefined)
  assert.equal(resolution.commit, '0123456789abcdef0123456789abcdef01234567')
  assert.equal(resolution.repo, 'https://github.com/owner/dsh-git-plugin.git')
  assert.equal(resolution.specifier, 'github:owner/dsh-git-plugin')
  // The recorded ref is "no ref / default branch", never the resolved commit.
  assert.equal(resolution.ref, undefined)
  const all = parseLockfileGitResolutions(LOCKFILE_V9)
  assert.equal(all.length, 1)
})

test('git: pnpm-lock v6 github tarball resolution is read for scoped packages', () => {
  const resolution = parseLockfileGitResolution(LOCKFILE_V6, '@scope/git-plugin')
  assert.ok(resolution !== undefined)
  assert.equal(resolution.commit, '89abcdef0123456789abcdef0123456789abcdef')
  assert.equal(resolution.ref, 'v1.2.3')
})

test('git: npm-only and malformed lockfiles contain no git resolution', () => {
  const npmOnly = `lockfileVersion: '9.0'
importers:
  .:
    dependencies:
      dsh-context:
        specifier: 0.73.0
        version: 0.73.0
packages:
  dsh-context@0.73.0:
    resolution: {integrity: sha512-abc}
`
  assert.deepEqual(parseLockfileGitResolutions(npmOnly), [])
  assert.equal(parseLockfileGitResolution(npmOnly, 'dsh-context'), undefined)
  assert.deepEqual(parseLockfileGitResolutions('not: [valid'), [])
  assert.deepEqual(parseLockfileGitResolutions(''), [])
})

test('git: ls-remote output parsing keeps peeled tags', () => {
  const refs = parseLsRemoteOutput([
    '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d\tHEAD',
    '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d\trefs/heads/master',
    '1111111111111111111111111111111111111111\trefs/tags/v1.0.0',
    '2222222222222222222222222222222222222222\trefs/tags/v1.0.0^{}',
    'garbage line',
    '',
  ].join('\n'))
  assert.equal(refs.length, 4)
  assert.equal(refs[0]?.refName, 'HEAD')
  assert.equal(refs[3]?.peeled, true)
})

test('git: a pinned commit ref needs no remote call; an empty url is invalid', async () => {
  const pinned = await resolveRemoteCommit({ url: 'https://example.com/repo.git', ref: '0123456789abcdef0123456789abcdef01234567', refType: 'commit' })
  assert.equal(pinned.ok, true)
  if (!pinned.ok) return
  assert.equal(pinned.commit, '0123456789abcdef0123456789abcdef01234567')

  // Abbreviated pinned commits are answered locally too (matching happens by prefix).
  const abbreviated = await resolveRemoteCommit({ url: 'https://example.com/repo.git', ref: 'abc1234', refType: 'commit' })
  assert.equal(abbreviated.ok, true)
  if (!abbreviated.ok) return
  assert.equal(abbreviated.commit, 'abc1234')

  const invalid = await resolveRemoteCommit({ url: '   ' })
  assert.equal(invalid.ok, false)
  if (invalid.ok) return
  assert.equal(invalid.kind, 'invalid')
})

test('npm: NpmFetchError carries kind, url and status', () => {
  const error = new NpmFetchError('https://registry.npmjs.org/x', 'http', 'HTTP 500', 500)
  assert.equal(error.name, 'NpmFetchError')
  assert.equal(error.kind, 'http')
  assert.equal(error.status, 500)
  assert.equal(error.url, 'https://registry.npmjs.org/x')
})

test('npm: downloadTarball rejects unusable URLs instead of returning bytes', async () => {
  await assert.rejects(
    () => downloadTarball('http://127.0.0.1:9/definitely-not-a-tarball.tgz', { timeoutMs: 2000 }),
    (error: unknown) => error instanceof NpmFetchError,
  )
})
