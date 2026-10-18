# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report privately via GitHub Security Advisories:

<https://github.com/NewBeeJack/dsh-extension-manager/security/advisories/new>

Include the affected version, a description, reproduction steps and the impact you expect. We aim to acknowledge reports within a few days.

## Scope and design notes

The plugin is local-first and runs inside the DSH Host process:

- HTTP routes are mounted under `/api/dsh-extension-manager` and reuse DSH's signed-cookie admission (`ctx.connection.admit`), so only the authenticated DSH Web session can call them.
- Mutations require both a JSON content type and the `x-dsh-extension-manager: 1` marker header.
- Writable targets are addressed by inventory id; client-supplied paths are never trusted for writes. Paths are resolved server-side and validated (`resolveInside`, symlink rejection, real install directory checks).
- npm operations are delegated to the DSH plugin manager (pnpm); the manager never bypasses pnpm build-script authorization or DSH profile protections.
- Logs and state mask credentials and never persist tokens (GitHub tokens are memory-only, read from `GITHUB_TOKEN` / `GH_TOKEN` or the `gh` CLI keyring).
- Update transactions are backed up and hash-verified before destructive steps; recovery is automatic for interrupted transactions.

Not in scope: vulnerabilities in DSH itself, third-party plugins/skills or their upstream packages; report those to their maintainers.
