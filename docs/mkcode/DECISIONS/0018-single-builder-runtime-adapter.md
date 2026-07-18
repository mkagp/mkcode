# ADR 0018: Codex CLI as the first single-builder adapter

- **Status:** Accepted

## Context

The repository contains typed Codex app-server bindings and interactive Codex
adapter code. The installed Codex CLI 0.144.5 also provides `exec --json`, native
thread receipts, output schemas, model/sandbox controls, and a future resume
command. Reusing interactive orchestration would cross the factory boundary.

## Decision

Implement `CodexAgentRuntime` with direct `codex exec --json` invocation through
`LocalProcessHost`. Send the composed prompt over stdin; use workspace-write,
ignore mutable user/repository instruction layers, request a structured result,
and retain the native thread ID. Do not create an interactive thread. Do not
silently fall back to another runtime or model.

## Consequences

The first runtime needs local Codex authentication through HOME/CODEX_HOME and
is Linux-first. Structured JSONL is normalized and redacted before bounded
storage. A completion receipt supports one safe crash window, while still-active
local sessions cannot yet be reattached and become operator attention. Future
same-session repair can use the retained native identity but is not implemented.

## Alternatives considered

- Interactive CodexAdapter/app-server: rejected for this slice because its
  ownership is coupled to provider services and interactive task records.
- Claude first: rejected because the inspected structured Codex CLI supplied the
  narrower standalone seam needed here.
- Raw terminal prompting: rejected because it lacks structured receipts/results.
