# Project configuration

## Configuration hierarchy

```text
Global MK Code defaults
    ↓
Global agent/team/workflow definitions
    ↓
Project .mkcode/project.yaml
    ↓
Project context and overrides
    ↓
Workflow-specific overrides
    ↓
Permitted per-run user overrides
```

Reusable, version-controlled definitions live centrally:

```text
registry/
├── agents/
├── teams/
├── workflows/
└── execution-profiles/
```

Each application repository may contain:

```text
.mkcode/
├── project.yaml
├── context.md
├── architecture.md
└── overrides.yaml
```

Version one uses files as the authoritative definition format. A full browser
editor is deferred until schemas have been proven by the first workflow.

## Proposed `.mkcode/project.yaml`

```yaml
apiVersion: mkcode.dev/v1alpha1
kind: Project

metadata:
  id: mkcode
  displayName: MK Code

repository:
  baseBranch: main
  worktreeRoot: ../.mkcode-worktrees

context:
  files:
    - .mkcode/context.md
    - .mkcode/architecture.md

commands:
  setup:
    - id: install
      executable: pnpm
      args: [install, --frozen-lockfile]
      workingDirectory: workspace
      timeoutSeconds: 900
  validate:
    - id: biome
      executable: pnpm
      args:
        - exec
        - biome
        - check
        - .
      workingDirectory: workspace
      timeoutSeconds: 300
      environment:
        CI: "1"
      redactEnvironment:
        - NPM_TOKEN
      artifacts:
        - path: reports/biome.json
          optional: true

workflows:
  allowed:
    - minimal-feature
  default: minimal-feature

team:
  default: feature-team

execution:
  defaultProfile: local-standard
  maxParallelAgentRuns: 1

security:
  allowNetwork: false
  allowedExecutables:
    - pnpm
    - git
  secretReferences:
    NPM_TOKEN: secret://projects/mkcode/npm-token

integrations:
  linear:
    teamKey: MK
  github:
    repository: mkagp/mkcode
```

Commands are executable-plus-argument arrays. Unrestricted shell strings are not
the default representation. If a project truly requires a shell, it must name
the shell executable and arguments explicitly and pass a stricter security
policy.

## Required semantics

- **Project identity:** stable metadata ID; the registration record maps it to a
  local repository directory.
- **Repository path:** operator-supplied and canonicalized by MK Code; it is not
  accepted from an untrusted external issue.
- **Base branch/worktree root:** validated against project policy and constrained
  to approved roots.
- **Setup and validation:** ordered command specifications with explicit timeout,
  environment references, output, artifacts, cancellation, and redaction.
- **Context files:** bounded files loaded as artifacts; missing required context
  fails resolution.
- **Workflow/team/profile:** names resolved against the central registry before a
  run is accepted.
- **Integration mappings:** identifiers only; credentials remain secret
  references outside the repository.

## Validation and migration

- Reject unsupported `apiVersion` and `kind`.
- Reject unknown keys by default so misspelled security or command settings do
  not fail open. A migration tool may explicitly preserve recognized legacy
  fields.
- Resolve and validate all references before creating a WorkflowRun.
- Never expand secret references into persisted configuration snapshots or
  event payloads; snapshot stable secret reference names.
- Record configuration content hash, repository revision, schema version, and
  resolved definitions in the run snapshot.
- Later file changes affect only new runs.
- A malformed configuration disables new factory runs for that project while
  leaving interactive conversations available.
- Schema migrations are explicit transformations that produce a new file or
  version; workers do not silently rewrite project repositories.
- Project overrides may narrow permissions and change permitted fields. Any
  widening of permissions requires policy validation and, where configured,
  human approval.
