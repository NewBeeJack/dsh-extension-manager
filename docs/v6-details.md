# V6 details dialog

> Local-only build 0.3.0. Not published to npm/GitHub.

## Default information architecture

Plugins and Skills share one detail dialog:

1. **Basic information** — icon, name, version (or the inventory's trusted short tree/commit hash), one primary status, and the existing description. The technical name, raw source kind and package spec are no longer in the default header.
2. **GitHub repository** — a single normalized project link; a monorepo subdirectory is shown separately. If there is no reliable GitHub address the dialog says so and never guesses from the extension name.
3. **Installation location** — one current-profile path with a copy button and the complete path in the DOM; flat-file Skills show their `SKILL.md` file, virtual Provider Skills say they have no independent directory.
4. **Update situation** — last check time, available target version and only non-duplicated blockers. The primary status stays in the header; buttons stay in the footer.
5. **高级信息与诊断** — closed by default. It contains every former section: overview, update details, provenance, runtime, paths, local modification, bundle/row contribution, Skill root/rank/provider/effective/scope, same-name competing and non-competing copies, repository conflicts, diagnostics and update history.

The footer keeps 诊断, 检查更新 and (when a safe target exists) 更新. The old footer GitHub button was removed because the repository section now owns that action.

## Repository resolution

The read-only resolver lives in `src/shared/repository.ts`.

Accepted spellings include:

- `https://github.com/owner/repo` and `.git`
- `git+https://github.com/owner/repo.git`
- `git+ssh://git@github.com/owner/repo.git`
- `git@github.com:owner/repo.git`
- `github:owner/repo`
- GitHub URLs with a `/tree/...` suffix (normalized to the project home)
- GitLab, Bitbucket, Codeberg and Gitee HTTPS project URLs as non-GitHub “项目仓库”

Candidate order is local provenance first (Git install/skill lock or verified source), then the installed package.json `repository` declaration. The plugin inventory reads only the installed package's own package.json; it does not query the network or change update sources. If two distinct candidates exist the default shows “仓库来源待核实” and the advanced section lists both. Credentials, `javascript:`, `file:`, unknown hosts and malformed declarations are rejected.

A monorepo tree link is built only for GitHub with a commit of 7–40 hex characters and a safe relative subdirectory:

`https://github.com/owner/repo/tree/<commit>/<subdirectory>`

Without a trustworthy commit, only the repository home is linked; the subdirectory remains visible as text in the advanced/repository section.

## Data preservation

The following are display-only additions:

- `SourceInfo.repository` — installed package.json `repository` URL.
- `SourceInfo.repositoryDirectory` — package.json `repository.directory`.

All existing fields, API payloads, update checks, transactions, backups, Skills scope mapping and diagnostics are unchanged.

## Verification (local)

- 115 unit tests pass; 13 cover repository normalization, package.json parsing, conflicts, credentials and monorepo links.
- Default plugin body measured ~284–365 px in the isolated/real UI; advanced details scroll inside the body while the footer remains visible.
- Details dialog top/bottom padding 24 px at 1920×1080, 1536×864, 1366×768, 1093×614, 911×512 and 683×384.
- Real profile: 7/7 plugin bundles expose a declared GitHub repository; 8/25 physical Skills expose a verified Skill source repository (8 Tavily Skills); 17 physical Skills and 1 virtual Skill have no reliable GitHub repository; 0 conflicts in the observed data.
