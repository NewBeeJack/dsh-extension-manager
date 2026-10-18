# Contributing

Thanks for your interest in DSH Extension Manager. This project targets **DSH 0.2.1-rc.2** and Node.js `>=22.19.0`.

## Development setup

```bash
git clone https://github.com/NewBeeJack/dsh-extension-manager.git
cd dsh-extension-manager
npm ci
npm run typecheck
npm test
npm run build
```

- Host code lives in `src/host/`, Web client code in `src/client/`, shared contracts in `src/shared/`.
- `scripts/build.mjs` produces `lib/index.js` (Host ESM bundle) and `lib/client.js` (Web client bundle).
- For an end-to-end environment that never touches your real DSH data:

  ```bash
  node scripts/test-env/setup.mjs
  node scripts/test-env/start.mjs --port 3099
  node scripts/test-env/run-all.mjs
  node scripts/test-env/stop.mjs
  ```

## Pull request checklist

- `npm run typecheck` passes.
- `npm test` passes (98 unit tests).
- `npm run build` succeeds.
- Behaviour changes are covered by a unit test or an isolated acceptance scenario when practical.
- UI changes keep the dialog layout contract in [docs/dialog-layout.md](docs/dialog-layout.md) (run `node scripts/dev/verify-dialog-layout.mjs` against a running DSH if you touched a dialog).
- Do not commit `node_modules/`, `lib/`, `dist/`, `_test/`, browser profiles, cookies or local screenshots.
- Keep commit messages in Conventional Commits format (e.g. `fix: correct dialog footer spacing`).

## Reporting bugs

Please include:

- DSH version and profile name (`dsh --version`, `$DSH_HOME/profiles/<name>/package.json`),
- Node.js / pnpm / git versions,
- the failing action, any dialog or console error,
- relevant excerpts from `$DSH_HOME/extension-manager/logs/manager.log` (secrets are masked, but review before posting).

For security issues, do **not** open a public issue — see [SECURITY.md](SECURITY.md).

## Code style

- TypeScript strict mode (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`); no `any` unless unavoidable.
- Host code must not trust client paths: address records by inventory id and resolve paths server-side.
- Network access lives in the Host process; the Web client only renders Host responses through the typed transport.
- CSS uses DSH design tokens (`--dsw-*`) and keeps light/dark themes working.

## License

By submitting a pull request you agree that your contribution is licensed under the repository's [MIT license](LICENSE).
