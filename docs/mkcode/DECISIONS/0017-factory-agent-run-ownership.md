# ADR 0017: Factory ownership of AgentRun lifecycle

- **Status:** Accepted

## Context

A native agent session may finish, fail, disappear, or remain ambiguous while a
workflow and its evidence must survive process restarts. Runtime statements
cannot determine validation or lifecycle truth.

## Decision

Add migration 4 with `agent_runs` owned exclusively by the workflow engine.
Persist the semantic role, runtime/task snapshots and digests, workspace/stage/
attempt links, launch receipt, bounded output metadata, result, Git evidence,
policy violations, completion fence, and optimistic version. Lifecycle events
and subsequent validation scheduling are transactional with durable state.

## Consequences

Exactly one current single-builder AgentRun exists per workflow. Runtime
completion schedules validation only after policy inspection. Cancellation is
durable and late completion cannot overwrite it. Unprovable recovery retains the
workspace and becomes operator attention rather than relaunching.

## Alternatives considered

- Store only provider session IDs: rejected because they are insufficient for
  workflow recovery and policy evidence.
- Use interactive event storage: rejected because the factory worker exclusively
  owns factory state.
- Retry ambiguous launches: rejected because it can duplicate edits and cost.
