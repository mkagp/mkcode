# Open questions

Defaults below allow documentation and the next fork-safety phase to proceed.
“Blocks next phase” refers specifically to Phase 1 of the transformation plan.

## Product

### What exact user action accepts a specification and creates a WorkItem?

- **Why it matters:** defines the human boundary between exploratory discussion
  and durable automated work.
- **Recommended default:** explicit “Create WorkItem” action that selects an
  immutable specification artifact; never infer acceptance from the last turn.
- **Cost of delay:** later UI/API naming may change, but the domain separation can
  still be implemented.
- **Blocks next phase:** No.

## Branding

### What are the final CLI/package, service, domain, and application identifiers?

- **Why it matters:** current `t3`, T3 domains, bundle IDs, schemes, and paths are
  both product identity and compatibility state.
- **Recommended default:** change visible MK Code branding first; retain legacy
  persisted and published identifiers until migrations are designed.
- **Cost of delay:** temporary mixed naming and additional compatibility docs.
- **Blocks next phase:** No; Phase 1 should inventory identifiers.

## Compatibility

### Must existing T3 Code local data and pairing links migrate into MK Code?

- **Why it matters:** determines alias/migration support for `.t3`, environment
  variables, storage keys, databases, schemes, and desktop paths.
- **Recommended default:** preserve read compatibility through the first MK Code
  releases; write new identifiers only after reversible migrations exist.
- **Cost of delay:** new features must avoid hard-coding either identity.
- **Blocks next phase:** No.

### How long must inherited identifier aliases remain supported?

- **Why it matters:** `COMPATIBILITY_INVENTORY.md` identifies environment,
  filesystem, database, browser, cookie, URL-scheme, package, and application
  identities with different migration costs.
- **Recommended default:** define compatibility per identifier; keep security and
  persisted-state fallback reads for at least one verified MK Code release and
  retain package/metric identifiers indefinitely unless migration has concrete
  value.
- **Cost of delay:** Phase 2 can change display text but cannot remove any legacy
  reader, path, scheme, cookie, or package identity.
- **Blocks next phase:** No, provided Phase 2 remains display-only.

## Architecture

### Should registry files live in this repository or an operator data directory?

- **Why it matters:** affects review/versioning, deployment updates, and local
  customization.
- **Recommended default:** ship repository-controlled defaults and allow a
  version-controlled operator registry directory with explicit precedence.
- **Cost of delay:** initial examples may move; snapshot semantics remain the
  same.
- **Blocks next phase:** No.

## Persistence

### What scale signal triggers migration from factory SQLite?

- **Why it matters:** avoids both premature distributed infrastructure and an
  unsafe late migration.
- **Recommended default:** revisit when multiple active workers, multiple
  operators, or HA becomes a committed requirement.
- **Cost of delay:** none for the single-worker design if API/data ownership stays
  clean.
- **Blocks next phase:** No.

### Is an event-sourced aggregate required for every factory record?

- **Why it matters:** event history is required, but full event sourcing adds
  projection and migration complexity.
- **Recommended default:** append durable domain events and transactional current
  state/outbox records; use full aggregate replay only where it pays for recovery
  or audit.
- **Cost of delay:** Phase 5 schema design cannot finish without choosing.
- **Blocks next phase:** No; blocks Phase 5.

## Runtime adapters

### Which existing runtime should bridge the first workflow?

- **Why it matters:** the first adapter tests whether the narrow runtime contract
  is sufficient.
- **Recommended default:** Codex, because typed app-server bindings and current
  adapter/session behavior already exist; use the operator's strongest
  authenticated runtime if operational constraints differ.
- **Cost of delay:** blocks the vertical workflow, not the worker skeleton.
- **Blocks next phase:** No.

### Should Pi be integrated through ACP or a dedicated adapter?

- **Why it matters:** determines protocol reuse and capability fidelity.
- **Recommended default:** perform a small ACP compatibility probe after the
  runtime port exists; write a dedicated adapter only for missing required
  capabilities.
- **Cost of delay:** Pi support waits without affecting core schemas.
- **Blocks next phase:** No.

## Agent definitions

### Which capabilities are required in the first stable AgentDefinition schema?

- **Why it matters:** overly broad capabilities ossify speculative design;
  underspecified capabilities allow invalid profile selection.
- **Recommended default:** derive the first set from the vertical workflow:
  repository read/write scope, structured result, repair input, review, and
  approval/input support.
- **Cost of delay:** general registry work waits; the vertical slice can use a
  minimal internal envelope.
- **Blocks next phase:** No.

## Teams

### What are the default maximum delegation depth and concurrency?

- **Why it matters:** controls cost, conflict risk, and process load.
- **Recommended default:** depth two below orchestrator; concurrency one for the
  first slice, then two only after workspace/path-ownership evidence.
- **Cost of delay:** generalized teams remain unavailable.
- **Blocks next phase:** No.

## Herdr

### What Herdr API and restoration guarantees are actually available?

- **Why it matters:** the ProcessHost adapter must not claim cursor, process, or
  restoration semantics Herdr cannot provide.
- **Recommended default:** retain LocalProcessHost and run a bounded API probe
  before Phase 8 design.
- **Cost of delay:** raw persistent terminals arrive later; workflow truth is
  unaffected.
- **Blocks next phase:** No.

## Linear

### Polling, manual sync, or webhook intake first?

- **Why it matters:** webhooks require stable public ingress, signatures, replay
  defense, and ownership decisions.
- **Recommended default:** manual import followed by polling; add webhooks only
  after the Mini PC ingress model is reviewed.
- **Cost of delay:** slower status updates.
- **Blocks next phase:** No.

## GitHub

### Which branch-protection rule will make MK Code CI authoritative?

- **Why it matters:** the repository now defines one validation-only workflow,
  but local changes cannot prove remote Actions execution or enforce merge
  protection.
- **Recommended default:** after observing both PR and `main` runs, require
  `MK Code CI / Validate supported baseline` on `main`, require the branch to be
  up to date, and remove inherited workflow checks from required status lists.
- **Cost of delay:** regressions can be merged even though the workflow exists.
- **Blocks next phase:** Yes; obtain one successful remote run and protection
  evidence before Phase 2 code changes.

### Use the local `gh` CLI or a GitHub App for initial publication?

- **Why it matters:** affects credentials, attribution, webhooks, and multi-user
  readiness.
- **Recommended default:** scoped local `gh` for one trusted operator; move to a
  GitHub App if multi-user attribution or webhook delivery is required.
- **Cost of delay:** publication automation waits, while local Git remains usable.
- **Blocks next phase:** No.

## Security

### Will product analytics be retained, and who owns its destination?

- **Why it matters:** Phase 1 makes telemetry explicit opt-in and removes the
  inherited key, but the optional implementation can still hash provider account
  identity and send events to a configured PostHog destination.
- **Recommended default:** leave telemetry disabled. Do not enable it until MK
  Code owns the project/key, documents event fields and retention, and decides
  whether provider-derived identity is acceptable.
- **Cost of delay:** no product analytics; local logs and explicitly configured
  operational tracing remain available.
- **Blocks next phase:** No.

### What containment level is required beyond an OS user and worktrees?

- **Why it matters:** model-driven commands can read credentials or access the
  network; worktrees are not sandboxes.
- **Recommended default:** dedicated service identity, approved roots, structured
  commands, secret minimization, network policy, and process-group cleanup first;
  evaluate containers/namespaces before untrusted multi-project use.
- **Cost of delay:** limits which repositories and secrets can safely be exposed.
- **Blocks next phase:** No; blocks unattended factory deployment.

## Deployment

### Where will databases, worktrees, artifacts, logs, and backups live?

- **Why it matters:** determines permissions, capacity monitoring, and recovery.
- **Recommended default:** separate service-owned directories under a documented
  MK Code home; backups outside the active data directory; worktrees on the same
  filesystem as their Git repository unless proven otherwise.
- **Cost of delay:** Phase 5 storage paths remain provisional.
- **Blocks next phase:** No.

## Licensing

### What new MK Code copyright and internal distribution notice is desired?

- **Why it matters:** it must coexist with, not replace, T3 Tools and third-party
  notices.
- **Recommended default:** preserve root MIT verbatim and add a separate MK Code
  notice only after owner/legal review.
- **Cost of delay:** existing MIT terms remain sufficient for source maintenance,
  but final distribution presentation remains unsettled.
- **Blocks next phase:** No.

## Third-party assets

### Are mobile font and iOS Ghostty notices complete for redistribution?

- **Why it matters:** the audit found notices/references but did not confirm every
  distributable asset's complete license bundle.
- **Recommended default:** do not redistribute the mobile application as MK Code
  until a targeted asset/license review is complete.
- **Cost of delay:** no effect on browser-only version one.
- **Blocks next phase:** No.

## Mobile and desktop removal

### Archive in-tree, move to a history branch, or delete after isolation?

- **Why it matters:** source retention affects workspace checks, security
  maintenance, notices, and repository complexity.
- **Recommended default:** freeze in-tree through browser seam/cloud isolation;
  then remove in a dedicated evidence-backed change while Git preserves history.
- **Cost of delay:** continued dependency/install/check overhead.
- **Blocks next phase:** No.
