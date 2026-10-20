/**
 * Read-only repository resolution tests. These cover the exact URL spellings
 * produced by git, pnpm and package.json, plus refusal cases and conflicts.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { ExtensionRecord, SourceInfo } from '../src/shared/types.ts'
import {
  normalizeRepositoryUrl,
  parsePackageRepository,
  resolveRepository,
  type GithubRepositoryView,
  type RepositoryView,
} from '../src/shared/repository.ts'

function source(patch: Partial<SourceInfo> = {}): SourceInfo {
  return { kind: 'npm', trust: 'verified', label: 'npm Registry', packageName: 'demo', ...patch }
}

function plugin(patch: Partial<SourceInfo> = {}, kind: ExtensionRecord['kind'] = 'plugin-bundle'): Pick<ExtensionRecord, 'kind' | 'source'> {
  return { kind, source: source(patch) }
}

function skill(patch: Partial<SourceInfo> = {}): Pick<ExtensionRecord, 'kind' | 'source'> {
  return { kind: 'skill', source: source({ kind: 'skill-lock', trust: 'verified', label: 'skills lock', ...patch }) }
}

function assertGithub(view: RepositoryView): asserts view is GithubRepositoryView {
  assert.equal(view.kind, 'github')
}

describe('normalizeRepositoryUrl', () => {
  test('normalizes the common GitHub spellings', () => {
    const cases = [
      'https://github.com/Owner/Repo',
      'https://github.com/Owner/Repo.git',
      'git+https://github.com/Owner/Repo.git',
      'git@github.com:Owner/Repo.git',
      'git+ssh://git@github.com/Owner/Repo.git',
      'github:Owner/Repo',
      'http://github.com/Owner/Repo',
      'https://github.com/Owner/Repo/tree/main/skills/demo',
    ]
    for (const entry of cases) {
      const normalized = normalizeRepositoryUrl(entry)
      assert.notEqual(normalized, undefined, entry)
      assert.equal(normalized?.url, 'https://github.com/Owner/Repo', entry)
      assert.equal(normalized?.github, true, entry)
    }
  })

  test('refuses credentials, non-repository schemes, and unknown hosts', () => {
    assert.equal(normalizeRepositoryUrl('https://user:token@github.com/o/r'), undefined)
    assert.equal(normalizeRepositoryUrl('javascript:alert(1)'), undefined)
    assert.equal(normalizeRepositoryUrl('file:///C:/repo'), undefined)
    assert.equal(normalizeRepositoryUrl('https://example.com/o/r'), undefined)
    assert.equal(normalizeRepositoryUrl('not a url'), undefined)
  })

  test('supports known non-GitHub hosts without calling them GitHub', () => {
    const normalized = normalizeRepositoryUrl('https://gitlab.com/team/project.git')
    assert.equal(normalized?.url, 'https://gitlab.com/team/project')
    assert.equal(normalized?.github, false)
    assert.equal(normalized?.platform, 'GitLab')
  })
})

describe('parsePackageRepository', () => {
  test('parses string and object repository declarations', () => {
    assert.deepEqual(parsePackageRepository('github:owner/repo'), { url: 'github:owner/repo' })
    assert.deepEqual(parsePackageRepository({ type: 'git', url: 'git+https://github.com/owner/repo.git' }), {
      url: 'git+https://github.com/owner/repo.git',
    })
    assert.deepEqual(parsePackageRepository({ type: 'git', url: 'https://github.com/owner/repo', directory: 'packages/demo' }), {
      url: 'https://github.com/owner/repo',
      directory: 'packages/demo',
    })
  })

  test('ignores missing and malformed declarations', () => {
    assert.equal(parsePackageRepository(undefined), undefined)
    assert.equal(parsePackageRepository({}), undefined)
    assert.equal(parsePackageRepository({ url: 42 }), undefined)
    assert.equal(parsePackageRepository(''), undefined)
  })
})

describe('resolveRepository', () => {
  test('uses an installed package.json declaration for an npm plugin', () => {
    const view = resolveRepository(plugin({ repository: 'git+https://github.com/Owner/Repo.git' }))
    assertGithub(view)
    assert.equal(view.url, 'https://github.com/Owner/Repo')
    assert.equal(view.origin, 'manifest')
    assert.equal(view.declared, true)
    assert.match(view.sourceLabel, /项目声明/u)
  })

  test('shows only the npm package page when no repository is declared', () => {
    const view = resolveRepository(plugin())
    assert.equal(view.kind, 'npm')
    if (view.kind === 'npm') assert.match(view.url, /^https:\/\/www\.npmjs\.com\/package\/demo$/u)
  })

  test('uses git install provenance and keeps a commit-pinned monorepo subdirectory', () => {
    const view = resolveRepository(skill({
      kind: 'skill-git',
      url: 'https://github.com/tavily-ai/skills.git',
      repo: 'tavily-ai/skills',
      subdir: 'skills/tavily-search',
      commit: '371b07b3a6885fc61686160d5cee5101d7a863a0',
    }))
    assertGithub(view)
    assert.equal(view.origin, 'skill-source')
    assert.equal(view.subdir, 'skills/tavily-search')
    assert.equal(view.subdirUrl, 'https://github.com/tavily-ai/skills/tree/371b07b3a6885fc61686160d5cee5101d7a863a0/skills/tavily-search')
  })

  test('does not construct a tree link without a trustworthy commit', () => {
    const view = resolveRepository(skill({
      url: 'https://github.com/tavily-ai/skills',
      repo: 'tavily-ai/skills',
      subdir: 'skills/tavily-search',
    }))
    assertGithub(view)
    assert.equal(view.subdir, 'skills/tavily-search')
    assert.equal(view.subdirUrl, undefined)
  })

  test('reports conflicting install and package declarations instead of choosing one', () => {
    const view = resolveRepository(plugin({
      kind: 'git',
      trust: 'verified',
      url: 'git+https://github.com/install-owner/install-repo.git',
      repository: 'https://github.com/declared-owner/declared-repo',
    }))
    assert.equal(view.kind, 'conflict')
    if (view.kind === 'conflict') {
      assert.deepEqual(view.conflicts.map(item => item.url).sort(), [
        'https://github.com/declared-owner/declared-repo',
        'https://github.com/install-owner/install-repo',
      ])
    }
  })

  test('keeps a non-GitHub project repository distinct', () => {
    const view = resolveRepository(skill({ kind: 'skill-lock', url: 'https://gitlab.com/team/project' }))
    assert.equal(view.kind, 'other')
    if (view.kind === 'other') assert.equal(view.platform, 'GitLab')
  })

  test('does not guess a repository for a local filesystem skill', () => {
    const view = resolveRepository({ kind: 'skill', source: source({ kind: 'filesystem', trust: 'local-custom', label: '本地文件系统' }) })
    assert.equal(view.kind, 'none')
    if (view.kind === 'none') assert.equal(view.reason, 'unverified')
  })

  test('deduplicates the same install and declaration repository', () => {
    const view = resolveRepository(plugin({
      kind: 'git',
      url: 'git+https://github.com/owner/repo.git',
      repo: 'owner/repo',
      repository: 'https://github.com/owner/repo',
    }))
    assertGithub(view)
    assert.equal(view.origin, 'install')
    assert.equal(view.declared, false)
  })
})
