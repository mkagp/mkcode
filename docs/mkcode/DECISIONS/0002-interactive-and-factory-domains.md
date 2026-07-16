# ADR 0002: Separate interactive and factory domains

- **Status:** Accepted

## Context

Current orchestration is project/thread based. A thread combines messages,
plans, activities, checkpoints, provider-session state, and pending UI flags in
`packages/contracts/src/orchestration.ts:344-390`. This is appropriate for a
human-directed coding conversation.

Automated workflows require WorkItems, stages, attempts, jobs, leases, durable
approvals, deterministic commands, artifacts, retries, integration state, and
immutable definition snapshots. These lifecycles do not align with turns or
provider sessions.

## Decision

Interactive and factory behavior are separate bounded domains. Interactive
projects, conversations, threads, turns, messages, provider sessions,
interactive approvals, checkpoints, diffs, terminals, and previews remain under
the existing interactive system.

The factory owns ProjectDefinitions, WorkItems, WorkflowRuns, StageRuns,
Attempts, AgentRuns, CommandRuns, durable Approvals, Artifacts, Workspaces,
retries, idempotency, integrations, and event history.

A ConversationLink may associate a WorkItem and conversation, and a conversation
may provide a versioned Specification. The records retain independent
lifecycles. `ThreadId`, `TurnId`, provider-native tasks, terminals, and processes
never become workflow lifecycle authorities.

## Consequences

- Some concepts such as project identity and approvals need explicit mappings
  rather than shared records.
- The UI can present both domains together without conflating persistence.
- Active conversations can continue if factory execution is unavailable.
- Workflow history remains understandable after conversations or provider
  sessions change.

## Alternatives considered

- **Extend thread orchestration with stages:** initially simpler, but couples
  restart, retry, and approval semantics to a human conversation model.
- **Replace interactive orchestration entirely:** unnecessary disruption to a
  working product path.
- **Treat a WorkItem as a special thread:** obscures cardinality because one
  WorkItem may relate to many conversations, specifications, and runs.
