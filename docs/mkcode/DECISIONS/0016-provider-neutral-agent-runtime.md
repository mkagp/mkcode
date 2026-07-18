# ADR 0016: Provider-neutral factory AgentRuntime

- **Status:** Accepted

## Context

The factory needs one coding-agent execution without making browser chats,
interactive threads, provider tasks, or a specific model authoritative workflow
state. Future Claude Code, OpenCode, Pi, and other adapters will have different
session and process semantics.

## Decision

Define the smallest implemented `AgentRuntime` contract in
`packages/agent-runtime`: capabilities, output references, start, status, wait,
cancel, reconcile, events, and result. Semantic task/result envelopes remain
provider-neutral. The workflow engine persists AgentRuns but imports no runtime
protocol; the factory worker composes the two.

## Consequences

Provider session state is evidence, not truth. Runtime-specific configuration is
snapshotted separately from the semantic role. Unsupported operations such as
repair-send/resume are absent until implemented honestly. Each future adapter
must normalize bounded evidence and preserve cancellation/recovery semantics.

## Alternatives considered

- Reuse interactive threads: rejected because their lifecycle and persistence
  are human-chat oriented.
- Embed Codex protocol in workflow-engine: rejected because it couples durable
  transitions to one provider.
- Generalize every runtime capability first: rejected as speculative.
