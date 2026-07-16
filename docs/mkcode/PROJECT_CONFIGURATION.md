# Project configuration

## Status and ownership

Minimal project configuration and local project registration are implemented.
The schema, parser, validation, default resolution, path containment, and
snapshot types live in `packages/project-config`. Browser-safe transport schemas
live in `packages/contracts/src/projectRegistry.ts`. The server-owned registry
and its WebSocket handlers live in `apps/server/src/projectRegistry.ts` and
`apps/server/src/ws.ts`.

This phase only describes future setup and validation. No code in
`packages/project-config` or the registry service starts processes, executes a
command, creates a worktree, launches an agent, or advances a workflow.

## Configuration hierarchy

Only the checked-in project layer is implemented today:

```text
Global MK Code defaults                         planned
    ↓
Global agent/team/workflow definitions          planned
    ↓
Project .mkcode/project.yaml                    implemented
    ↓
Project context and overrides                   context references implemented;
                                                overrides planned
    ↓
Workflow-specific overrides                    planned
    ↓
Permitted per-run user overrides               planned
```

The planned central `registry/agents`, `registry/teams`,
`registry/workflows`, and `registry/execution-profiles` directories do not yet
exist. A project may refer to workflow and execution-profile identifiers, but
this phase treats them as opaque strings and does not resolve a registry.

## Version 1 file

The fixed discovery location is `.mkcode/project.yaml`. The absolute repository
path is deliberately absent: it comes from a trusted local registration request.
The complete implemented shape is:

```yaml
version: 1
project:
  id: example-typescript-project
  name: Example TypeScript Project
  description: Optional human-readable description
repository:
  baseBranch: main
  worktreeRoot: .mkcode/worktrees # optional, repository-relative
  contextFiles: # optional
    - .mkcode/context.md
setup: # optional, ordered
  - id: install
    executable: pnpm
    args:
      - install
      - --frozen-lockfile
    workingDirectory: . # optional; default "."
    timeoutSeconds: 900 # optional; default 300
    environment: # optional references, never values
      - name: NPM_TOKEN
        source: NPM_TOKEN
    artifacts: # optional, paths may not exist yet
      - path: reports/setup.json
        optional: true
checks: # optional, ordered
  - id: lint
    executable: pnpm
    args:
      - exec
      - biome
      - check
      - .
    workingDirectory: .
    timeoutSeconds: 300
    failureBehavior: fail # optional: fail | continue; default fail
    environment: []
    artifacts:
      - path: reports/biome.json
        optional: true
workflows: # optional
  allowed:
    - feature
    - bug
    - chore
execution:
  defaultProfile: coding-workhorse
```

The repository fixture at
`packages/project-config/fixtures/example-typescript-project.yaml` contains the
requested TypeScript example.

### Field rules and defaults

| Field                      | Rule or default                                                                                                                                |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                  | Required; exactly integer-compatible value `1`. Other values fail as `unsupported_version`.                                                    |
| `project.id`               | Required stable lowercase kebab-case ID, at most 64 characters. It cannot change during revalidation.                                          |
| `project.name`             | Required non-empty display name.                                                                                                               |
| `project.description`      | Optional text.                                                                                                                                 |
| `repository.baseBranch`    | Required Git-valid branch reference; invalid separators, `..`, `@{`, `.lock` components, and other Git-invalid forms are rejected.             |
| `repository.worktreeRoot`  | Optional repository-relative path; defaults to `.mkcode/worktrees`. This phase resolves but never creates it.                                  |
| `repository.contextFiles`  | Optional ordered repository-relative file references; each must exist and remain inside the repository after symlink resolution.               |
| `setup`                    | Optional ordered command array; defaults to `[]`.                                                                                              |
| `checks`                   | Optional ordered validation array; defaults to `[]`.                                                                                           |
| command/check `id`         | Required non-empty ID. IDs are unique across both setup and checks.                                                                            |
| `executable`               | Required non-empty string without NUL. It is data only; no shell parsing or execution occurs.                                                  |
| `args`                     | Required array of strings. A scalar command string is rejected.                                                                                |
| `workingDirectory`         | Optional repository-relative existing directory; defaults to `.`.                                                                              |
| `timeoutSeconds`           | Optional safe integer from 1 through 86,400; defaults to 300.                                                                                  |
| `environment`              | Optional array of `{name, source}` environment-variable-name references. Values are neither accepted nor resolved.                             |
| `artifacts`                | Optional array of repository-relative `{path, optional}` declarations; `optional` defaults to false. Outputs need not exist during validation. |
| `failureBehavior`          | Checks only; `fail` or `continue`, default `fail`. The runner semantics are deferred.                                                          |
| `workflows.allowed`        | Optional ordered, unique opaque identifiers; defaults to `[]`.                                                                                 |
| `execution.defaultProfile` | Required opaque identifier. Its existence is not checked until an execution-profile registry exists.                                           |

Unknown keys fail with `unknown_key`; they are never silently discarded. YAML
aliases are not expanded. Duplicate YAML mapping keys are malformed YAML.
Malformed structure fails with a safe `schema_invalid` issue that does not echo
configuration values.

## Path and command security

Resolution canonicalizes the operator-supplied repository root with `realPath`.
Working directories and existing context files are checked both lexically and
after `realPath`, so `..`, absolute paths, and symlinks that resolve outside the
repository fail. The configuration file itself must also resolve inside the
registered repository before its contents are read. Artifact and worktree paths
may not exist yet. Resolution checks them lexically, canonicalizes their deepest
existing ancestor, and rejects symlink escapes or a non-directory ancestor. An
existing worktree root must itself be a directory. A future creator/runner must
still re-check parents and final paths at use time because the filesystem can
change after the snapshot. Filesystem validation for configuration-controlled
arrays is capped at eight concurrent operations.

The parser preserves executable and argument boundaries. It does not expand
variables, interpolate shell syntax, resolve secrets, inspect an executable on
`PATH`, or determine that an executable is safe. Naming a shell explicitly is
still possible data and must be governed by the future command runner's policy.
Consequently, this parser is a containment and data-validation boundary, not a
security sandbox.

## Deterministic resolved snapshot

`ResolvedProjectConfiguration` contains:

- schema version and stable project identity;
- canonical absolute repository root and resolved worktree root;
- base branch and canonical context-file locations;
- ordered setup commands and checks with all defaults materialized;
- normalized repository-relative and canonical working directories;
- workflow allowlist and opaque default execution-profile reference;
- canonical configuration source path; and
- a lowercase SHA-256 digest of the exact configuration bytes.

Resolution time is registration metadata, not part of the configuration
snapshot. Identical file bytes and registration inputs therefore produce
semantically identical snapshots and digests. Environment references remain
references; no environment or secret value enters the snapshot.

## Local project registration

The server stores registrations in the derived state location
`project-registrations.json` (`ServerConfig.projectRegistrationsPath`). This is a
versioned, atomically replaced JSON file owned only by
`apps/server/src/projectRegistry.ts`. It is intentionally separate from:

- interactive `state.sqlite` and the thread aggregate;
- browser-editable `settings.json`; and
- the future worker-owned factory database.

On the currently verified Linux deployment, server-owned state directories are
created or narrowed to mode `0700`. The registration store and its atomic-write
temporary file are created or narrowed to `0600`; replacement writes restore
that final mode. Permission enforcement traverses Linux paths component by
component through pinned directory descriptors, rejects symbolic links before
creating or changing descendants, and does not recursively change parent
directories, registered repositories, or unrelated paths. This requires the
normal Linux `/proc/self/fd` interface. Non-Linux permission and symlink
semantics remain unverified.

A registration records project ID, canonical absolute repository path,
enabled/disabled state, optional display override, added/last-validated times,
validation status, configuration location and digest, the last resolved
snapshot, and structured validation errors. Registration requires an existing
directory with a `.git` directory or worktree `.git` file and a valid
`.mkcode/project.yaml`. It never initializes Git or writes into the repository.

Revalidation replaces the snapshot only after complete validation. If a file
becomes invalid, the registration retains its last valid snapshot and digest,
records current validation errors, and becomes `invalid` (or remains `disabled`).
Enabling a project performs revalidation. Changing `project.id` is rejected as
an identity change rather than silently re-keying the record.

Before configuration discovery, revalidation checks the stored repository path
in order: present, directory, and Git repository. It reports
`repository_not_found`, `repository_not_directory`, or `repository_not_git` as a
structured current validation issue. Only a valid Git repository can proceed to
the existing configuration `file_missing` result. `list` and `read` remain safe
and continue to expose the historical snapshot while the current status is
invalid; restoring the path permits normal revalidation. Revalidation also
rejects a stored canonical repository path that has been replaced by a symlink.

Authenticated WebSocket methods are:

- `projectRegistry.register`, `validate`, `disable`, and `enable` with the
  existing orchestration-operate scope;
- `projectRegistry.list` and `read` with the existing orchestration-read scope.

Responses expose configuration metadata and references but not file contents,
environment values, or secrets. No project-management UI was added: the typed
RPC seam and integration tests prove the contract without adding a premature
browser CRUD surface.

## Deliberately deferred

- command execution and executable allow/deny policy;
- worktree creation or external worktree roots;
- global/project override precedence and schema migrations beyond rejecting
  unsupported versions;
- secret resolution and redaction at execution time;
- execution-profile, agent, team, and workflow registries;
- factory persistence and active-run snapshots;
- automatic discovery, browser CRUD, and remote registration; and
- repository revision capture (the future workflow run must add the source
  revision alongside this configuration snapshot).
