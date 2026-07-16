# Verified baseline report

## Scope and conclusion

The local repository is buildable before MK Code transformation for dependency
installation, repository check, TypeScript checking, the default workspace test
suite, root production build, release-smoke mechanics, and bounded server
startup. Authenticated real-provider sessions, browser E2E, full native/mobile
tooling, signed installers, EAS artifacts, and relay deployment remain partial or
unverified.

No full command logs were persisted. This report records commands, exit codes,
relevant output, and classifications observed during the audit.

## Source state

- Branch: `main`
- Commit: `ecb35f75839925dd1ac6f854efeef5c9e291d11b`
- Remote tracking: `origin/main`
- Initial and post-baseline `git status --short`: empty
- Fork GitHub Actions baseline at audit time: none
- Phase 1 local state: one validation-only workflow is defined; a remote Actions
  run and branch-protection enforcement have not yet been observed

## Environment

| Component   | Observed value           |
| ----------- | ------------------------ |
| OS          | Ubuntu 26.04 LTS x86_64  |
| Kernel      | Linux 7.0.0-27           |
| Node        | `v24.16.0`               |
| npm         | `12.0.0`                 |
| corepack    | `0.35.0`                 |
| pnpm        | `11.10.0`                |
| Git         | `2.53.0`                 |
| Vite+       | repository-local `0.2.2` |
| Bun         | absent                   |
| Global `vp` | absent                   |

Root engines require Node `^24.13.1` and pnpm `11.10.0`
(`package.json:48-51`), so the observed Node and pnpm versions satisfy the
repository requirements.

## Phase 1 fork-safety verification

The exact validation sequence now encoded in `.github/workflows/ci.yml` was run
locally after the fork-safety changes:

| Command                                                      | Exit | Phase 1 result                                                                                                                                          |
| ------------------------------------------------------------ | ---: | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                             |    0 | All 16 workspace projects resolved from the unchanged lockfile; root prepare completed.                                                                 |
| `pnpm exec vp check`                                         |    0 | 2,100 files correctly formatted; 0 errors and 9 pre-existing React warnings.                                                                            |
| `pnpm exec vp run typecheck`                                 |    0 | All 15 workspace tasks passed; three non-failing Effect suggestions remain.                                                                             |
| `pnpm exec vp run --filter @t3tools/desktop ensure:electron` |    0 | Electron 41.5.0 runtime present.                                                                                                                        |
| `pnpm exec vp run test`                                      |    0 | All 14 workspace tasks passed: 586 test files passed, 2 skipped; 4,621 tests passed, 7 skipped.                                                         |
| `pnpm run build`                                             |    0 | All 5 root build tasks passed; existing bundle-size, sourcemap, timing, and dependency-bundling warnings remain non-failing.                            |
| `pnpm exec node scripts/release-smoke.ts`                    |    0 | Temporary-fixture release mechanics passed; no publishing occurred. Six deprecated transitive-dependency and peer-dependency warnings were non-failing. |

The first full test attempt after moving inherited workflows exited `1` because
`infra/relay/scripts/deploy.test.ts` directly consumed
`.github/workflows/release.yml`. The reference consumer was migrated to
`.github/workflows-disabled/release.yml`, its focused 12-test suite passed, and
the complete workspace test command then passed. This was a Phase 1
workflow-isolation defect, not a pre-existing baseline failure.

Telemetry verification used
`pnpm exec vp test run apps/server/src/telemetry/AnalyticsService.test.ts`.
Before the policy change, the new default-off regression failed because one
request was observed when zero were expected. After implementation, the focused
suite passes three cases: absent opt-in is a no-op, incomplete opt-in fails
closed to a no-op, and explicit opt-in with a test key delivers buffered events.
The default and incomplete paths do not create the anonymous-identity file.

No full command logs were persisted. Counts above are summaries of the terminal
output from this verification run.

## Commands and results

### Dependency installation

```text
pnpm install --frozen-lockfile
```

- Exit code: `0`
- Result: lockfile current; 1,744 packages installed; 1,994 lockfile entries
  passed the package-manager supply-chain policy.
- Native postinstalls included Electron, node-pty, esbuild, and msgpackr.
- Root prepare ran `effect-tsgo patch && vp config --no-agent` as declared in
  `package.json:6`.
- Repository effect: no tracked or untracked source changes; dependencies and
  caches were ignored artifacts.

### Literal repository check

```text
vp check
```

- Exit code: `127`
- Relevant output: `/bin/bash: vp: command not found`
- Category: **missing local/global tool on PATH**, not a repository defect.
- Resolution: invoke the repository-local binary through pnpm.

### Repository-local check

```text
pnpm exec vp check
```

- Exit code: `0`
- Result: 2,078 files formatted/checked; 0 lint errors.
- Warnings: 9 `react(no-unstable-nested-components)` warnings in
  `apps/web/src/components/CommandPalette.tsx` at lines 658 and 676, and
  `apps/web/src/components/ChatMarkdown.tsx` at lines 1331, 1334, 1344, 1373,
  1487, 1490, and 1493.
- Existing root configuration makes several lint groups warnings and disables
  type-aware linting (`vite.config.ts`, notably lines 56-76 and 120-124). No configuration was
  weakened during the audit.

### Typecheck

```text
pnpm exec vp run typecheck
```

- Exit code: `0`
- Result: all 15 workspace tasks passed.
- Non-failing Effect suggestions:
  - `packages/client-runtime/src/relay/discovery.ts:243`
  - `apps/desktop/src/backend/DesktopBackendPool.test.ts:116`
  - `apps/desktop/src/wsl/DesktopWslEnvironment.ts:814`

### Initial test attempt

```text
pnpm exec vp run test
```

- Exit code: `1`
- Desktop result: 17 failed suites.
- Relevant cause: `Error: Electron failed to install correctly, please delete
node_modules/electron and try installing again`.
- Web/mobile/relay task exits included `137` because the parallel run was
  aborted/cancelled after the desktop failure.
- Category: **missing or incomplete local dependency artifact**. The repository
  CI explicitly repairs Electron before checks/tests
  (`.github/workflows/ci.yml`, lines 25-26 and 58-59).

### Electron runtime prerequisite

```text
pnpm exec vp run --filter @t3tools/desktop ensure:electron
```

- Exit code: `0`
- Result: downloaded/provisioned the platform Electron runtime through
  `apps/desktop/scripts/ensure-electron-runtime.mjs:118-159`.

### Successful repeated tests

```text
pnpm exec vp run test
```

- Exit code: `0`
- Workspace tasks: all 14 passed.
- Test files: 580 passed, 2 skipped.
- Tests: 4,577 passed, 7 skipped.
- Coverage includes server, web, desktop, mobile, relay, contracts,
  client-runtime, shared, ACP, Codex app-server, SSH, Tailscale, scripts, and the
  lint plugin.
- Server integration coverage includes real SQLite/Git orchestration in
  `apps/server/integration/orchestrationEngine.integration.test.ts:185-267` and
  provider-service integration against a controlled adapter in
  `apps/server/integration/providerService.integration.test.ts:41-249`.

### Production build

```text
pnpm run build
```

- Exit code: `0`
- Tasks: 5 passed—marketing Astro static build, web Vite build, server CLI/web
  bundle, desktop preview annotation CSS, and desktop main/preload bundles.
- Non-failing warnings: web chunks over 500 KB (main index approximately 3.43 MB
  minified), Vite plugin timing, generated declaration sourcemaps, and desktop
  dependency-bundling hints.
- Full signed installers were not part of this root build.

### Release smoke: literal Node invocation

```text
node scripts/release-smoke.ts
```

- Exit code: `1`
- Relevant output: `spawnSync vp ENOENT` at `scripts/release-smoke.ts:209`.
- Category: **missing global Vite+ binary on PATH**.

### Release smoke: repository-local PATH

```text
pnpm exec node scripts/release-smoke.ts
```

- Exit code: `0`
- Output: `Release smoke checks passed.`
- Scope: a temporary fixture validates version, lockfile, and updater-manifest
  mechanics; it does not produce or execute a real installer.

### Development startup: incorrect pass-through form

```text
timeout ... pnpm run dev:server -- --home-dir /tmp/... --no-browser --port 14999
```

- Exit code: `124` after the bounded timeout.
- Relevant output: server watcher reported
  `Unrecognized flag: --home-dir in command t3`.
- Category: **invocation/tooling semantics**. The extra `--` passed dev-runner
  flags through to the child server.

### Development startup: missing global local-bin context

```text
timeout ... node scripts/dev-runner.ts dev:server --home-dir /tmp/... --no-browser --port 14999
```

- Exit code: `1`
- Relevant output: `DevRunnerProcessError` / `spawn vp ENOENT`.
- Category: **missing global Vite+ binary on PATH**.

### Successful bounded development startup

```text
timeout --signal=INT --kill-after=5s 20s \
  pnpm exec node scripts/dev-runner.ts dev:server \
  --home-dir /tmp/mkcode-baseline-dev-14999 \
  --no-browser \
  --port 14999
```

- Exit code: `124`, expected from the intentional 20-second timeout.
- Result: all 32 SQLite migrations completed and the server reported
  `Listening on http://127.0.0.1:14999`.
- Startup then reported that pairing authentication was required, which is
  expected behavior rather than a blocker.
- Cleanup: no listener or child process remained after timeout.

### Mobile native lint

```text
pnpm exec vp run lint:mobile
```

- Exit code: `0`
- Result: 9 Swift and 12 Kotlin files discovered, but SwiftLint, ktlint, and
  detekt were absent and all three checks were skipped.
- Classification: **not meaningfully verified locally**. The script explicitly
  warns and skips missing tools; CI installs them on macOS first
  (the inherited CI configuration at the audited commit).

## Repository CI behavior

`.github/workflows/ci.yml` is the only active GitHub Actions definition. It runs
one ordered Ubuntu 24.04 validation job on pull requests targeting `main`, pushes
to `main`, and manual dispatch. It pins Node 24.16.0, activates the root
`packageManager` declaration through Corepack, invokes Vite+ only through
`pnpm exec`, and runs the seven commands in the Phase 1 table. Repository
permissions are read-only and no production credentials, cache uploads,
artifacts, publication, deployment, tagging, signing, or notification steps are
defined.

Inherited release, relay, EAS, and community-mutation definitions are retained
under `.github/workflows-disabled/`, outside GitHub's workflow discovery path.
Their implementation remains available for dependency evidence, but default
pull-request and `main` activity cannot execute them as Actions workflows.

No remote Actions run or branch-protection configuration was available to this
local task. The workflow definition and local equivalent are verified; remote
runner success and requiring `MK Code CI / Validate supported baseline` remain
owner-side checks.

## Verification gaps and blockers

- Real Codex integration is opt-in and needs `CODEX_BINARY_PATH` in the relevant
  integration test.
- Cursor and Grok probes require explicit environment flags; Grok also requires
  API credentials/login.
- Claude Code, Codex, Cursor Agent, or OpenCode CLIs must be installed and
  authenticated for real provider-session testing.
- Web tests do not exercise a real browser/E2E project; no Playwright/Cypress
  suite or coverage threshold was found.
- Marketing has build/typecheck but no tests.
- Desktop smoke exists but is not invoked by main CI; signed installers are
  release-only.
- Main CI does not install macOS native mobile linters or build iOS/Android
  artifacts. Inherited EAS workflows are disabled references.
- Relay, Clerk, Cloudflare, PlanetScale, Axiom, APNs, Expo, Apple, Azure, and
  Discord integration behavior was not exercised.
- Existing `docs/reference/scripts.md` is stale where it describes Bun/Turbo and
  an older default server port; current scripts use Node/Vite+ and
  `scripts/dev-runner.ts:25-26` uses port 13773.

## Final baseline classification

**Verified buildable:** install, repository-local check, typecheck, all default
tests after the documented Electron prerequisite, root production build,
release-smoke mechanics, SQLite migrations, and bounded server startup.

**Phase 1 verified locally:** validation-only CI definition, telemetry
default-off/fail-closed behavior, inactive inherited automation, unchanged
license/notice files, and a compatibility inventory without identifier renames.

**Partial:** native mobile lint, authenticated providers, browser E2E, installers,
mobile artifacts, remote GitHub Actions/branch protection, relay deployment,
signing, and external-service integration.
