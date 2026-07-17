# Runtime and process-host model

## Separate concepts

| Concept          | Responsibility                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| AgentDefinition  | Semantic job, capabilities, constraints, and permissions.                                       |
| Runtime          | Harness protocol used to conduct an agent session, such as Claude Code, Codex, OpenCode, or Pi. |
| Provider         | Model/vendor account or configured provider instance used by a runtime.                         |
| Model            | Concrete model selection and model-specific settings.                                           |
| ExecutionProfile | Binds runtime, provider, model, ProcessHost, sandbox, approval policy, secrets, and limits.     |
| AgentRun         | One resolved execution of an AgentDefinition.                                                   |
| ProcessHost      | Starts, controls, observes, and reconciles the operating-system process.                        |

The current repository already has a useful provider-adapter seam in
`apps/server/src/provider/Services/ProviderAdapter.ts:45` and configured
provider-instance identities in `packages/contracts/src/providerInstance.ts:1`.
It also contains five built-in drivers in
`apps/server/src/provider/builtInDrivers.ts:47`. The target factory contract is
smaller: it retains session execution and canonical events while excluding UI
settings, updater behavior, discovery presentation, and other server concerns.

## AgentRuntime contract

The conceptual interface is:

```ts
interface AgentRuntime {
  start(input: RuntimeStartInput): Promise<RuntimeSession>;
  resume(input: RuntimeResumeInput): Promise<RuntimeSession>;
  send(sessionId: string, input: RuntimeInput): Promise<void>;
  respondToApproval(
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  respondToInput(sessionId: string, requestId: string, response: StructuredInput): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  events(sessionId: string, cursor?: string): AsyncIterable<RuntimeEvent>;
  health(): Promise<RuntimeHealth>;
}
```

This task documents the interface only. Future implementation should bridge one
existing adapter before generalizing all providers.

## Native and flexible runtimes

Claude Code and Codex are native harness runtimes with distinct protocols and
session behavior. OpenCode may attach to or spawn its own server. Cursor and Grok
currently share ACP infrastructure. Pi or a future flexible runtime should use
the same capability contract rather than changing AgentDefinition.

Capability resolution occurs before a run starts. An ExecutionProfile declares
required runtime features such as resume, structured approvals, structured user
input, tool events, attachments, rollback, or MCP support. A missing capability
is a validation error or an explicit fallback decision; it is never silently
ignored.

## Session lifecycle

- `start` creates a runtime session for an immutable AgentRun envelope.
- `resume` uses persisted runtime/session identity and a known event cursor.
- `send` supplies a bounded task or repair input.
- approval and structured-input responses reference durable factory records.
- `interrupt` requests graceful interruption; `stop` terminates the session.
- `events` is cursor-based so reconnection can deduplicate and identify gaps.
- `health` reports adapter/runtime readiness, not workflow success.

Runtime sessions may be lost even while their processes remain. Reconciliation
compares factory AgentRun state, saved runtime identity, ProcessHost status, and
event cursors. Controller policy decides resume, reattach, retry, or fail.

## ProcessHost contract

```ts
interface ProcessHost {
  start(input: ProcessStartInput): Promise<HostedProcess>;
  sendInput(processId: string, input: string): Promise<void>;
  interrupt(processId: string): Promise<void>;
  stop(processId: string): Promise<void>;
  status(processId: string): Promise<ProcessStatus>;
  readOutput(processId: string, cursor?: string): Promise<ProcessOutput>;
}
```

The first implementation now uses a local child-process host. It captures
process group identity, exit status or signal, output cursors, timestamps, and
reconciliation metadata. A later `HerdrProcessHost` must fit behind the same
contract.

`packages/command-runner/src/processHost.ts` is the implemented narrow port:
`start`, `status`, `interrupt`, and `terminate`. `LocalProcessHost` uses
`shell:false` and a separate Linux process group; output storage/paging is a
separate command-runner concern. Generated execution IDs are durable identity,
while native PIDs are host metadata. After a full worker restart the local host
cannot prove ownership from PID alone, so active CommandRuns become
`operator_attention` rather than being reattached or relaunched.

ProcessHost output is observational. It can prove that a process exited with a
code; it cannot decide that an agent satisfied a workflow stage. Deterministic
CommandRuns and controller policy make that decision.

## Workspace boundary

`WorkspaceManager` is separate from `ProcessHost`: it allocates and verifies the
filesystem execution root, while `ProcessHost` starts and controls a process in
that supplied root. `packages/workspace-manager` currently implements local Git
worktrees; `packages/command-runner` receives only the canonical execution root
and cannot allocate or remove it. Future container, VM, remote-host, or
Herdr-backed options must preserve this separation and the durable Workspace
identity.

The local worktree implementation snapshots the base commit before Git side
effects and reconciles path, common repository, branch, HEAD, worktree metadata,
and administrative ownership evidence after restart. Missing or ambiguous
evidence becomes operator attention rather than silent recreation. This is
durable orchestration evidence, not process or filesystem sandboxing.

## Herdr relationship

Herdr may provide persistent PTYs, terminal panes, raw output, remote attachment,
manual intervention, process status, and restoration metadata. It does not own
workflow stages, retries, approvals, validation, WorkItems, pull requests, agent
hierarchy, or workflow history.

If Herdr is unavailable, the workflow engine keeps its durable truth. Depending
on policy, new AgentRuns may wait or fall back to the local ProcessHost; existing
runs reconcile from recorded process metadata when Herdr recovers.

## Fallback and failure policy

- Runtime fallback is allowed only when the snapshotted ExecutionProfile names
  an ordered fallback and capability validation succeeds.
- Provider or model fallback creates explicit AgentRun metadata; it is not a
  transparent mutation.
- Start/resume calls use idempotency keys.
- Duplicate runtime events are ignored by stable event identity or cursor.
- Cursor gaps pause advancement and trigger reconciliation.
- An unhealthy runtime prevents new claims but does not rewrite running state.
- Interrupt/stop timeout escalates to ProcessHost termination and process-tree
  cleanup according to the profile policy.
