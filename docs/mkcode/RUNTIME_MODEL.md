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

## Implemented AgentRuntime contract

The deliberately narrow first interface is:

```ts
interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly capabilities: AgentRuntimeCapabilities;
  outputReferences(executionId: string): OutputReferences;
  start(input: StartAgentInput): Promise<StartedAgentSession>;
  status(session: AgentSessionReference): Promise<AgentRuntimeStatus>;
  wait(session: AgentSessionReference): Promise<AgentRuntimeCompletion>;
  cancel(session: AgentSessionReference, reason: string): Promise<void>;
  reconcile(session: AgentSessionReference): Promise<AgentReconciliationResult>;
  events(session: AgentSessionReference, cursor?: number): Promise<AgentRuntimeEventPage>;
  result(session: AgentSessionReference): Promise<AgentRuntimeCompletion | null>;
}
```

`packages/agent-runtime/src/contracts.ts` implements this surface. Resume,
repair-send, provider approval, and structured-input methods remain absent
because the first adapter cannot support those workflow behaviors yet.

### First adapter: Codex

Repository inspection found both a typed Codex app-server seam for interactive
sessions and the installed Codex CLI's structured `exec --json` mode. The first
factory adapter selects the latter because it supplies a native session receipt,
JSONL events, an output schema, explicit workspace-write sandbox and model
selection, and a future resume seam without importing browser/thread state.
It invokes direct arguments with `shell: false`, sends the prompt over stdin,
and uses `--ignore-user-config` plus `--ignore-rules` so mutable user/repository
prompting cannot replace factory rules.

The initial child environment contains PATH, HOME/CODEX_HOME, temp, locale, and
certificate variables only. The worker service credential is never inherited.
HOME/CODEX_HOME are currently required for local Codex authentication; this is
a trusted-operator limitation, not a general secret-isolation boundary.

JSONL and stderr are normalized/redacted before bounded `0600` artifact writes.
Agent-message content is retained only as the parsed structured result and
hidden reasoning is not persisted. A durable completion receipt can reconcile a
crash after native completion but before database confirmation. An uncertain
local process cannot be safely reattached and becomes `operator_attention`; it
is never blindly relaunched.

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

- `start` creates one runtime session for an immutable AgentRun envelope.
- `cancel` requests process-group interruption and bounded forced termination.
- `events` and `result` expose normalized, bounded evidence.
- `reconcile` consumes the native receipt and durable completion sidecar.
- Resume/send/approval/structured input and repair messaging remain planned.

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
