# MK Code architecture documentation

MK Code is a hard fork of T3 Code that is becoming an independently maintained,
browser-based control plane for interactive coding sessions and durable agentic
development workflows. The current repository is a working T3-derived product;
its Phase 5 worker, workflow engine, factory database, and deterministic
project-command execution path are operational. The broader registry and integration architecture
described here remains a target.

## Current status

The fixed upstream-derived starting baseline is
`ecb35f75839925dd1ac6f854efeef5c9e291d11b`. The existing browser, server,
provider adapters, interactive orchestration, SQLite persistence, local
authentication, and Tailscale support are operational. The factory worker,
workflow engine, factory database, declared-check execution, and factory-owned
Git worktree lifecycle are now operational. Agent/team/workflow/profile
registries and Herdr, Linear, and workflow-oriented GitHub adapters remain
planned components.

Phase 1 fork-safety controls are implemented: one validation-only active
CI workflow, telemetry disabled by default, inherited publishing/deployment/
community workflows retained outside GitHub's active workflow directory, and
explicit toolchain, licensing, and persisted-identifier guidance. A remote
Actions run has passed on `main`; branch-protection enforcement remains an
owner-side repository setting.

Minimal project configuration and local project registration are implemented.
The server can validate a checked-in `.mkcode/project.yaml`, store an isolated
local registration, and expose browser-safe `projectRegistry.*` contracts.

The durable factory-worker, deterministic command/workspace foundation, and
one provider-neutral single-builder path are
implemented in `apps/factory-worker`, `packages/factory-contracts`, and
`packages/workflow-engine`, with process execution isolated in
`packages/command-runner` and Git effects isolated in
`packages/workspace-manager`. It owns a separate factory SQLite database,
transactional stage/job/event state, leases, retries, cancellation, durable
human approval, CommandRuns, redacted file-backed output, recovery, and an
authenticated loopback API. A selected validation check is resolved only from
the immutable run snapshot and invoked without a shell inside a factory-owned
worktree created from a recorded immutable base commit. Worktrees are retained
for human review and require proven ownership for cleanup. A built-in
`single-builder` role now runs through `AgentRuntime` and the first
`CodexAgentRuntime` adapter. Runtime completion is evidence only: post-run Git
policy inspection must pass and the declared check must exit successfully
before human review. Multiple agents, repair loops, Herdr, and external
integrations remain deferred.

MK Code does not seek full T3 Code feature parity. Desktop, mobile, marketing,
T3 Connect, relay infrastructure, and public T3 distribution remain present
while their consumers are isolated and their eventual disposition is proven.

## Recommended reading order

1. [Product vision](PRODUCT_VISION.md)
2. [Current architecture](CURRENT_ARCHITECTURE.md)
3. [Repository inventory](REPOSITORY_INVENTORY.md)
4. [Target architecture](TARGET_ARCHITECTURE.md)
5. [Domain model](DOMAIN_MODEL.md)
6. [Runtime model](RUNTIME_MODEL.md)
7. [Team and agent model](TEAM_AND_AGENT_MODEL.md)
8. [Project configuration](PROJECT_CONFIGURATION.md)
9. [Security model](SECURITY_MODEL.md)
10. [Compatibility inventory](COMPATIBILITY_INVENTORY.md)
11. [Development prerequisites](DEVELOPMENT_PREREQUISITES.md)
12. [Licensing and attribution](LICENSING.md)
13. [Transformation plan](TRANSFORMATION_PLAN.md)
14. [Verified baseline](BASELINE_REPORT.md)
15. [Open questions](OPEN_QUESTIONS.md)

Architecture decisions:

- [0001: Fork strategy](DECISIONS/0001-fork-strategy.md)
- [0002: Interactive and factory domains](DECISIONS/0002-interactive-and-factory-domains.md)
- [0003: Separate factory worker](DECISIONS/0003-separate-factory-worker.md)
- [0004: Provider-neutral agent definitions](DECISIONS/0004-provider-neutral-agent-definitions.md)
- [0005: Herdr as a process host](DECISIONS/0005-herdr-as-process-host.md)
- [0006: Server-owned project registration store](DECISIONS/0006-project-registration-store.md)
- [0007: Factory persistence ownership](DECISIONS/0007-factory-persistence-ownership.md)
- [0008: Transactional job intents](DECISIONS/0008-transactional-job-intents.md)
- [0009: Worker loopback API authentication](DECISIONS/0009-worker-loopback-api-authentication.md)
- [0010: Deterministic command execution](DECISIONS/0010-deterministic-command-execution.md)
- [0011: Local process host](DECISIONS/0011-local-process-host.md)
- [0012: Command output and redaction](DECISIONS/0012-command-output-and-redaction.md)
- [0013: Factory worktree ownership](DECISIONS/0013-factory-worktree-ownership.md)
- [0014: Workspace retention and cleanup](DECISIONS/0014-workspace-retention-and-cleanup.md)
- [0015: Workspace reconciliation](DECISIONS/0015-workspace-reconciliation.md)
- [0016: Provider-neutral agent runtime](DECISIONS/0016-provider-neutral-agent-runtime.md)
- [0017: Factory AgentRun ownership](DECISIONS/0017-factory-agent-run-ownership.md)
- [0018: Single-builder runtime adapter](DECISIONS/0018-single-builder-runtime-adapter.md)
- [0019: Agent worktree policy enforcement](DECISIONS/0019-agent-worktree-policy-enforcement.md)

## Terminology

| Term             | Meaning                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| Conversation     | Human-directed discussion in the interactive domain.                               |
| WorkItem         | Durable factory-domain statement of work, independent of any conversation.         |
| WorkflowRun      | Immutable execution snapshot of a workflow and all resolved definitions.           |
| AgentDefinition  | Provider-neutral responsibility, capabilities, and constraints.                    |
| TeamDefinition   | Composition of orchestrator, team-lead, and worker roles.                          |
| ExecutionProfile | Runtime, provider, model, sandbox, approval, and resource selection.               |
| AgentRun         | One execution of an AgentDefinition under a resolved ExecutionProfile.             |
| ProcessHost      | Replaceable mechanism that starts and observes operating-system processes.         |
| Workspace        | Factory-owned execution root associated one-to-one with a WorkflowRun.             |
| Herdr            | A future ProcessHost and terminal-observability integration, never workflow truth. |

The words **current** and **verified** refer to code or behavior observed in this
repository. **Target**, **proposed**, and **planned** refer to future components.
