# ADR 0004: Provider-neutral agent definitions

- **Status:** Accepted

## Context

MK Code must support Claude Code, Codex, OpenCode, Pi-like runtimes, and future
compatible runtimes. Semantic responsibilities such as orchestrator, team lead,
builder, and reviewer outlive any provider/model selection. The current provider
system already separates driver kind and configured instance identity, but some
model/default contracts remain provider-specific.

## Decision

AgentDefinition describes responsibility, capabilities, permissions, task/result
contracts, and constraints only. TeamDefinition composes those definitions.
WorkflowDefinition assigns semantic role slots to stages.

ExecutionProfile separately binds runtime adapter, provider instance, model,
ProcessHost, sandbox, approval policy, secrets, and resource limits. Every
AgentRun records the resolved definition and profile snapshots.

## Consequences

- The same agent/team/workflow can move between providers or models without
  changing its semantic identity.
- Capability resolution can reject an incompatible profile before execution.
- Registries contain more references and require strong validation/versioning.
- Provider-specific examples belong in ExecutionProfiles, not role definitions.

## Alternatives considered

- **One agent record containing role and model:** convenient initially but makes
  workflow reuse and runtime replacement expensive.
- **Runtime-specific teams:** exposes operational selection throughout product
  semantics.
- **Resolve providers ad hoc per launch:** prevents reproducible snapshots and
  policy review.
