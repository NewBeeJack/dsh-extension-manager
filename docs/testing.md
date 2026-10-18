# Testing & acceptance

The project keeps three layers of verification. All of them are runnable from a clean checkout; none of them touch your real `~/.dsh` or `~/.agents` unless you point them there explicitly.

## 1. Unit tests — `npm test`

`node --test` with the native TypeScript runner (no build step). 98 tests:

| File | Coverage |
| --- | --- |
| `test/plugin-updates.test.ts` | registry policy / public-mirror fallback limits, packument parsing, candidate selection, compatibility, proxy/NO_PROXY, git spec & lockfile parsing, ref peeling |
| `test/skills.test.ts` | SKILL.md frontmatter, skill root resolution, git tree hashing, lockfile parsing, shadowing |
| `test/updater.test.ts` | transaction state machine, backup verification, tarball/archive parsing, Windows replace semantics, rollback, crash recovery, serialized queue |

Expected: 98 passing in roughly 2 seconds; `npm run typecheck` is clean.

## 2. Isolated acceptance environment — `scripts/test-env/`

Creates a throw-away `DSH_HOME`, `DSH_AGENTS_HOME`, demo workspace and fixture skills under `../_test/env1` (or a custom root), then drives a real DSH Web server on a dedicated port.

```bash
node scripts/test-env/setup.mjs [root]
node scripts/test-env/start.mjs --port 3099 [--root <root>]
node scripts/test-env/run-all.mjs
node scripts/test-env/stop.mjs
```

Scenarios (`run-all.mjs`):

1. npm plugin update — full transaction, verified backup, HMR loaded.
2. git plugin update — lockfile-commit validation, failure → `RECOVERED(rolledBack=true)`.
3. batch update — two items succeed; concurrency guard returns one 200 and one `409 update-busy`.
4. local modifications — plan blocks, explicit overwrite succeeds after backup.
5. interrupted install — kill the Host mid-`INSTALL`, restart → rollback to the previous version.
6. skill update — stale remote tree + local modification → explicit overwrite, tree hash verified, then up-to-date.
7. Windows file lock — exclusive lock during replace → safe failure and rollback, Host stays alive.

## 3. Dialog layout regression — `scripts/dev/verify-dialog-layout.mjs`

Headless-Chrome CDP check for the dialog spacing contract (24px above the title, 24px below the action buttons). It opens the diagnostics, details and update-plan dialogs (complete/loading/error), scrolls long content to the end, repeats across six viewport sizes (covering 100%–200% zoom layouts) and a dark-scheme pass, and fails non-zero if any measurement is outside tolerance.

```bash
node scripts/dev/verify-dialog-layout.mjs --url "http://127.0.0.1:3080/?token=..." \
  --cookie scripts/dev/cookie.json --sizes "1920x1080,1536x864,1366x768,1093x614,911x512,683x384"
```

Contract and design rationale: [dialog-layout.md](dialog-layout.md).

## Verification summary (v0.1.1)

- Unit tests: **98/98 passing**; typecheck clean; production build succeeds (`lib/index.js` Host ESM bundle, `lib/client.js` Web client bundle).
- Isolated acceptance: **7/7 scenarios passing**, including npm update, git update with rollback, batch + concurrency, local-modification overwrite, interrupted-install recovery, skill update and Windows file-lock rollback.
- Dialog layout: **19/19 checks passing** at 1920×1080, 1536×864, 1366×768, 1093×614, 911×512 and 683×384, plus dark mode and last-line visibility.
- Real-environment smoke: installed from the release tarball into a DSH `web` profile, Host health endpoint returns ok, Plugins/Skills inventories, details, diagnostics and update-plan dialogs verified in the DSH Web GUI (light and dark themes).

Numbers depend on the profile and upstream releases; they are a snapshot, not a fixed promise.
