# Development and CI prerequisites

## Supported toolchain

- Node.js: 24.16.0 for the authoritative Phase 1 baseline. The root engine range
  is `^24.13.1`.
- pnpm: 11.10.0, pinned by the root `packageManager` field.
- Vite+: repository-local version 0.2.2 from `pnpm-workspace.yaml` and the
  lockfile.
- Git: required by tests and normal project/worktree behavior.
- Bun: not required for the verified baseline commands.

Use Corepack to activate the repository-declared pnpm version:

```sh
corepack enable
corepack install
pnpm --version
```

Phase 1 does not introduce another toolchain manager. CI pins the verified Node
version and lets Corepack read pnpm from `package.json`.

## Repository-local Vite+

`vp` and `vpr` are not assumed to be global commands. Run Vite+ through pnpm:

```sh
pnpm exec vp check
pnpm exec vp run typecheck
```

Package scripts may refer to `vp` directly because `pnpm run` automatically puts
the workspace's `node_modules/.bin` on `PATH`. Direct `node` invocations of
scripts that spawn `vp`, such as release smoke or the development runner, also
need `pnpm exec`:

```sh
pnpm exec node scripts/release-smoke.ts
pnpm exec node scripts/dev-runner.ts dev:server
```

## Install and full verification order

```sh
pnpm install --frozen-lockfile
pnpm exec vp check
pnpm exec vp run typecheck
pnpm exec vp run --filter @t3tools/desktop ensure:electron
pnpm exec vp run test
pnpm run build
pnpm exec node scripts/release-smoke.ts
```

Electron setup is required before the complete test suite because desktop tests
import the Electron package runtime. It is not required before format/lint or
typecheck. The current Linux test suite passed headlessly during baseline
verification; no display server or additional Linux packages were required.

The authoritative CI intentionally does not retain build artifacts or add a
dependency cache in Phase 1. Its purpose is a clean, reproducible validation
baseline. Revisit caching only after observed Actions timings justify the added
cache-key and invalidation complexity. Production credentials are not required.

## Development-server baseline probe

The server startup probe uses an isolated home and a bounded timeout:

```sh
timeout --signal=INT --kill-after=5s 20s \
  pnpm exec node scripts/dev-runner.ts dev:server \
  --home-dir /tmp/mkcode-baseline-dev-14999 \
  --no-browser \
  --port 14999
```

A successful probe applies all pending SQLite migrations and reaches the
listening state. Exit code 124 is expected because `timeout` intentionally stops
the long-running development server after observation. Verify that no listener
or child process remains afterward.

Do not add `--` before the dev-runner options: that passes the flags to the child
`t3` command instead of the development runner.
