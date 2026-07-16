# MK Code transformation plan

## Strategy

Transform the fixed T3 Code fork through small, reversible changes. Preserve the
verified browser/server baseline while isolating upstream product surfaces.
Prove one durable factory workflow before generalizing registries, teams, or a
workflow language.

Every phase must keep the previous supported path usable, identify rollback
before mutation, preserve MIT/third-party notices, and pass repository-required
checks. No phase authorizes commit, push, PR creation, merge, or publication
without separate explicit direction.

## Current phase status

- **Phase 0:** implemented in the working tree; architecture documentation and
  repository guardrails are present.
- **Phase 1:** implemented and published. Validation-only CI, telemetry opt-in policy,
  disabled inherited automation references, toolchain documentation, licensing
  note, and compatibility inventory are present. A remote `main` Actions run
  passed; branch protection remains owner-configured.
- **Phase 4:** implemented as a deliberately minimal,
  non-executing project configuration and server registration slice.
- **Phase 5:** implemented as a separate simulation-only worker, SQLite engine,
  loopback API, and server HTTP client.
- **Deterministic command foundation:** implemented as the first bounded part of
  Phase 6: LocalProcessHost, CommandRun migration, declared-check resolution,
  redacted output, timeout/cancellation, and human-review advancement.
- **Phases 2–3, the worktree/agent remainder of Phase 6, and 7–13:** not started.

## Phase 0: Land the audit documentation

- **Goal:** establish shared, evidence-backed current and target architecture.
- **Prerequisites:** verified local baseline at `ecb35f...`.
- **Affected:** `docs/mkcode/**`, additive `AGENTS.md` guidance only.
- **Deliverables:** documentation index, vision, architecture, inventory,
  baseline, domain/runtime/team/project/security models, plan, open questions,
  and five ADRs.
- **Verification:** `git diff --check`; repository-local Vite+ check/typecheck;
  path, Mermaid, inventory-consumer, change-scope, and license checks.
- **Risks:** presenting planned components as implemented or overstating
  unverified provider/release behavior.
- **Exclusions:** product behavior, CI changes, telemetry changes, deletion,
  rebrand, new service/database/integrations.
- **Rollback:** remove the new documentation directory and revert only the
  appended AGENTS section; no runtime state is affected.

## Phase 1: Protect the fork baseline

- **Goal:** make the fork's known-good state authoritative and stop accidental
  upstream publication or telemetry.
- **Prerequisites:** Phase 0 and owner confirmation of fork CI/release policy.
- **Affected:** `.github/workflows/ci.yml`, release/deploy workflow triggers,
  analytics composition/config, operational docs, compatibility registry.
- **Deliverables:** observed fork CI run; Electron/local-Vite+ prerequisites;
  upstream PostHog default-off; T3 production release/relay jobs disabled;
  attribution checks; inventory of persisted identifiers (`T3CODE_*`, `.t3`,
  schemes, storage keys, databases, CLI/package names).
- **Verification:** clean install, check, typecheck, tests, build, release smoke,
  bounded startup, CI success, analytics no-op assertion, no production deploy.
- **Risks:** disabling generic observability with analytics, or breaking CI by
  removing unsupported surfaces before their checks are understood.
- **Exclusions:** visible rebrand, package rename, relay deletion, provider or
  workflow implementation.
- **Rollback:** restore workflow triggers/config and analytics composition from a
  small isolated change; no data migration.

## Phase 2: Stage MK Code branding

- **Goal:** establish MK Code's user-visible identity and documentation while
  preserving compatibility.
- **Prerequisites:** persisted-identifier inventory and protected CI.
- **Affected:** browser/server display copy, repository metadata, new assets,
  internal deployment names; compatibility documentation.
- **Deliverables:** MK Code display brand, fixed-fork attribution, independent
  release naming proposal, compatibility aliases for legacy identifiers.
- **Verification:** existing home/database/settings/connection behavior survives;
  build assets resolve; legacy env/storage/scheme fixtures still work.
- **Risks:** data loss or connection failure from blind renames; trademark
  confusion; desktop/mobile asset breakage.
- **Exclusions:** renaming every package, `.t3`, all `T3CODE_*`, published CLI,
  deep-link schemes, or database paths.
- **Rollback:** revert display/metadata assets while retaining the compatibility
  inventory.

## Phase 3: Freeze unsupported product surfaces

- **Goal:** define browser/server as the supported MK Code release path without
  deleting code whose consumers remain.
- **Prerequisites:** authoritative CI and browser-only product decision.
- **Affected:** support matrix, root build/release selection, desktop/mobile/
  marketing/relay workflows, browser platform seams, local-vs-cloud auth seams.
- **Deliverables:** frozen desktop/mobile/public distribution; marketing removal
  plan after legal-link migration; T3 Connect/Clerk/relay isolation boundary;
  internal Linux/browser deployment build.
- **Verification:** browser/server start and tests pass without upstream cloud
  config; consumer searches show no supported path depends on frozen release
  jobs; license notices remain.
- **Risks:** Electron bridge cross-coupling, mobile legal URL consumers, server
  cloud layers that are composed even when UI is gated, SSH dependence on `t3`.
- **Exclusions:** immediate directory/package deletion or weakening checks before
  a surface is formally retired.
- **Rollback:** re-enable the previous build/release selection; retain source and
  manifests until removal evidence is complete.

## Phase 4: Add minimal project configuration — implemented

- **Goal:** register one local repository and describe setup/validation safely.
- **Prerequisites:** stable browser/server baseline and accepted version 1 schema.
- **Affected:** `packages/project-config`, project-registry contracts, isolated
  server registration service/store, WebSocket RPC, example fixture, docs.
- **Deliverables:** repository path registration; base branch; worktree root;
  structured setup/validation command descriptions; opaque default
  ExecutionProfile reference; validation and snapshot hashing.
- **Verification:** package and server tests cover valid, missing, malformed,
  unknown-key, unsupported-version, duplicate ID, invalid type/timeout,
  path/symlink escape, repository/Git checks, revalidation, disable/enable,
  persistence reload, safe serialization, and an authenticated WebSocket flow.
- **Risks:** arbitrary shell execution, secrets in snapshots, mutable config
  affecting active work, duplicated current interactive project semantics.
- **Exclusions:** running workflows, browser CRUD, database migration, broad
  registry design.
- **Rollback:** remove the `projectRegistry.*` RPC methods, service layer, and
  package consumers; preserve or archive `project-registrations.json` for
  operator recovery. Checked-in project configuration remains inert.

## Phase 5: Add a minimal durable factory-worker skeleton — implemented

- **Goal:** prove process and persistence ownership before executing agents.
- **Prerequisites:** project/config schemas and internal API authentication design.
- **Affected:** new `apps/factory-worker`, factory contracts/workflow-engine,
  separate SQLite location/migrations, server worker client/event relay.
- **Deliverables:** separate service; separate DB; WorkItem, WorkflowRun,
  StageRun, JobIntent, Lease, IdempotencyRecord, event history; authenticated
  loopback command/query API; cursor event feed; startup reconciliation.
- **Verification:** server cannot open factory DB; atomic transition/outbox test;
  duplicate command receipt; lease expiry/reclaim; kill/restart recovery; event
  replay/gap handling; unauthorized API rejection.
- **Risks:** shared database ownership, in-memory queues masquerading as durable,
  migration ordering, duplicate irreversible effects.
- **Exclusions:** agent launch, deterministic commands, distributed workers,
  external DB/queue, Herdr/Linear/GitHub.
- **Rollback:** stop/disable the worker and remove the feature-gated server client;
  preserve its DB for diagnosis rather than destructive rollback.
- **Implemented evidence:** `packages/workflow-engine/src/workflowEngine.test.ts`
  exercises migrations, atomic creation, idempotency, leases/reclaim, retries,
  approvals, cancellation, recovery, and replay. The real HTTP/restart flow is
  covered by `apps/factory-worker/src/runtime.test.ts`; server ownership is
  limited to `apps/server/src/factoryWorkerClient.ts`.

## Phase 6: Prove the first vertical workflow — command foundation implemented

- **Goal:** exercise the smallest valuable durable path end to end.
- **Prerequisites:** worker skeleton and one project config/profile are complete.
  LocalProcessHost and deterministic command execution are now complete;
  worker-owned worktree allocation and one bridged AgentRuntime remain.
- **Affected:** worker stage handlers, runtime/process ports, VCS/worktree bridge,
  minimal server API/view.
- **Target/future flow:** manual task → allocate worktree → launch one builder →
  run one configured lint command → on failure send recorded output to the same
  builder once → rerun lint → stop at durable human review. The currently
  implemented subset is command-only and does not launch a builder or repair
  failures.
- **Deliverables:** restart-safe run with immutable snapshot, owned workspace,
  AgentRun, CommandRuns, artifacts, one capped repair, durable approval.
- **Verification:** happy path; lint failure/repair; retry exhaustion; cancellation;
  duplicate job; worker crash before/after process start; approval across restart;
  cleanup recovery.
- **Risks:** over-generalizing before observing real needs; destructive worktree
  cleanup; process-tree leakage; treating agent output as lint success.
- **Exclusions:** generalized teams/workflows, scout/plan/reviewer, typecheck/test/
  build, Herdr, Linear, GitHub, merge.
- **Rollback:** feature flag workflow creation; drain/cancel runs; preserve run
  database and worktree ownership markers for manual recovery.
- **Implemented command subset:** a run may select one check ID. The validating
  stage resolves it from the stored snapshot, records CommandRun/output/events,
  treats exit zero as pass, fails terminally on a nonzero deterministic result,
  and stops passing work at human review. No agent repair occurs yet.
- **Next exact slice:** allocate and durably own one disposable Git worktree,
  then run this same selected check inside that workspace. Do not add agents,
  repair loops, generalized workflows, Herdr, or publication in that slice.

## Phase 7: Expand the workflow

- **Goal:** add a complete but still opinionated feature-development pipeline.
- **Prerequisites:** vertical-slice recovery evidence and stable run semantics.
- **Affected:** workflow definition, worker stage policies, deterministic command
  sequencing, artifacts, approvals, minimal team roles.
- **Deliverables:** scout, plan, implementation, lint, typecheck, test, build,
  independent review, durable human approval, capped repair attempts routed to
  the responsible builder.
- **Verification:** each command failure routes correctly; reviewer is distinct;
  acceptance criteria persist; failed/cancelled states are terminal; resume works
  at every boundary; artifacts remain attempt-specific.
- **Risks:** uncontrolled retry cost, overlapping writes, reviewer self-approval,
  workflow definition becoming an arbitrary language.
- **Exclusions:** dynamic arbitrary graphs, multiple workers, automatic publish,
  external integrations.
- **Rollback:** retain the Phase 6 workflow version; new runs select the earlier
  version while active expanded runs continue from snapshots.

## Phase 8: Add Herdr

- **Goal:** supply persistent process/PTY visibility and manual intervention
  without changing workflow authority.
- **Prerequisites:** stable AgentRun/ProcessHost contract and reconciliation tests.
- **Affected:** Herdr ProcessHost adapter, worker process metadata, browser raw
  terminal attachment, security/operations docs.
- **Deliverables:** start/attach/input/interrupt/stop/status/output cursor;
  restoration metadata; tailnet-only access; local-host fallback policy.
- **Verification:** Herdr outage does not corrupt runs; lost/restarted process
  reconciliation; duplicate start; output cursor replay; access-control and
  redaction checks.
- **Risks:** Herdr IDs/status becoming workflow truth; raw output exposing secrets;
  manual intervention invalidating deterministic assumptions.
- **Exclusions:** workflow scheduling/state in Herdr or public terminal exposure.
- **Rollback:** switch ExecutionProfile back to LocalProcessHost; keep Herdr
  metadata as non-authoritative observations.

## Phase 9: Generalize agents, teams, workflows, and profiles

- **Goal:** extract reusable file-based definitions from proven vertical-slice
  concepts.
- **Prerequisites:** operational evidence from Phases 6–8.
- **Affected:** `registry/agents`, `teams`, `workflows`, `execution-profiles`;
  schema packages; resolution/snapshot logic; delegation policy.
- **Deliverables:** provider-neutral AgentDefinitions, TeamDefinitions,
  versioned WorkflowDefinitions, ExecutionProfiles, structured task/result
  envelopes, capability checks, max depth/concurrency, project overrides.
- **Verification:** resolution precedence; immutable snapshots; missing/cyclic
  references; incompatible capabilities; delegation rejection; overlapping path
  policy; provider/model changes without role changes.
- **Risks:** premature workflow language, provider leakage into roles, registry
  edits changing active runs, unbounded delegation.
- **Exclusions:** complete browser CRUD and arbitrary user-defined code in
  workflow definitions.
- **Rollback:** keep earlier workflow/definition versions available for new runs;
  active runs remain self-contained.

## Phase 10: Add browser workflow visualization

- **Goal:** make durable work observable and controllable from the browser.
- **Prerequisites:** stable worker query/event contracts and run projections.
- **Affected:** server event relay/API and new web workflow views.
- **Deliverables:** stage and attempt history, agent tree, commands, artifacts,
  approvals, event cursor/replay, reconnect and gap states.
- **Verification:** disconnect/reconnect; duplicate/out-of-order event delivery;
  stale approval; large output pagination; cancelled/failed/recovered runs;
  accessibility and browser-only behavior.
- **Risks:** UI inferring transitions, direct DB access, coupling workflow packages
  to React, Electron-only behavior entering the supported path.
- **Exclusions:** UI-owned orchestration or full registry editing.
- **Rollback:** hide workflow routes while retaining worker/API; interactive UI is
  unaffected.

## Phase 11: Add Linear integration

- **Goal:** create/link WorkItems and synchronize status idempotently.
- **Prerequisites:** stable WorkItem lifecycle and integration inbox/outbox model.
- **Affected:** Linear port/adapter, mapping configuration, worker integration
  jobs, browser links.
- **Deliverables:** manual or polling intake first; ExternalIssueLink; normalized
  specification artifact; idempotent status sync and retry.
- **Verification:** duplicate intake; stale/out-of-order updates; auth/rate limit;
  deleted/moved issue; malformed content; worker restart; no direct workflow
  mutation from remote status.
- **Risks:** two sources of truth, prompt injection in issue content, token scope,
  sync loops.
- **Exclusions:** public webhooks until ingress/ownership is decided; using Linear
  as workflow persistence.
- **Rollback:** disable polling/adapter; preserve links and queued sync records for
  reconciliation.

## Phase 12: Add GitHub draft pull requests

- **Goal:** publish approved candidate work without automatic merge.
- **Prerequisites:** stable worktree lifecycle, human approval, Git authorization
  policy, integration idempotency.
- **Affected:** GitHub port/adapter, existing Git/source-control bridge, workflow
  publication stage, PullRequestLink.
- **Deliverables:** branch, commit, push, draft PR, review metadata, remote
  reconciliation and explicit approval boundary.
- **Verification:** existing branch/PR; duplicate request; push rejection; token
  failure; changed base; restart between push and PR creation; no merge endpoint
  used.
- **Risks:** local write authority becoming publication authority; duplicate PRs;
  credential leakage; accidental non-draft publication.
- **Exclusions:** automatic merge, release, or deployment.
- **Rollback:** disable new publication jobs; retain remote links and require
  human cleanup rather than destructive automated rollback.

## Phase 13: Harden Mini PC deployment

- **Goal:** operate the single-host system safely and recoverably.
- **Prerequisites:** stable server/worker/process behavior and chosen storage/
  artifact paths.
- **Affected:** systemd units, service identities, filesystem/network policy,
  secrets, backup/restore, Tailscale, monitoring, operational docs.
- **Deliverables:** two services; loopback worker; Tailscale-only server; dedicated
  identity/permissions; SQLite-safe backups; restore/reboot/run reconciliation;
  disk pressure policy; credential rotation; process containment roadmap.
- **Verification:** clean-host install; reboot recovery; backup restore; expired
  lease/process reconciliation; disk-full threshold; Tailscale outage; credential
  rotation; cancellation/process-tree cleanup.
- **Risks:** treating Tailscale as application auth, treating worktrees as
  sandboxes, shared credentials, unbounded artifacts/logs.
- **Exclusions:** multi-tenant access, distributed workers, HA, automatic deploy.
- **Rollback:** stop worker/server units and restore the last verified database/
  configuration snapshots; keep the previous manual start path documented.

## Ordering rule

Phase 5 proved the transaction, lease, restart, approval, cancellation, and
event-replay boundary without execution. The next factory product-code task is
Phase 6's single vertical slice only. It must introduce the smallest explicit
ProcessHost, workspace ownership, one runtime bridge, and one deterministic lint
command, then stop at human review.

Phase 2 display branding and Phase 3 product-surface freezing remain independent
tracks. Do not combine either with Phase 6, and do not generalize teams,
registries, or a workflow language until the vertical slice supplies evidence.
