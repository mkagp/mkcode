export type AgentRuntimeKind = "codex";

export interface AgentRuntimeCapabilities {
  readonly structuredEvents: boolean;
  readonly structuredResult: boolean;
  readonly cancellation: boolean;
  readonly timeout: boolean;
  readonly nativeSessionIdentity: boolean;
  readonly liveResumeObservation: boolean;
}

export interface BuilderTaskEnvelope {
  readonly version: 1;
  readonly role: "single-builder";
  readonly workItemId: string;
  readonly workflowRunId: string;
  readonly agentRunId: string;
  readonly projectId: string;
  readonly objective: string;
  readonly task: {
    readonly title: string;
    readonly description: string;
  };
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly scope: {
    readonly allowedPaths: ReadonlyArray<string>;
    readonly forbiddenPaths: ReadonlyArray<string>;
  };
  readonly worktreePathReference: string;
  readonly contextFileReferences: ReadonlyArray<string>;
  readonly implementationPlanArtifactReference?: string;
  readonly validationCheckId: string;
  readonly maximumRuntimeSeconds: number;
  readonly cancellationPolicy: "interrupt_then_kill";
  readonly completionOutput: {
    readonly structuredResultRequired: true;
  };
}

export interface AgentResultEnvelope {
  readonly version: 1;
  readonly agentRunId: string;
  readonly runtimeSessionReference: string;
  readonly status: "completed" | "failed" | "blocked" | "cancelled" | "timed_out";
  readonly summary: string;
  readonly claimedChangedPaths: ReadonlyArray<string>;
  readonly claimedTestsChanged: ReadonlyArray<string>;
  readonly unresolvedIssues: ReadonlyArray<string>;
  readonly questionsOrBlockers: ReadonlyArray<string>;
  readonly runtimeCompletionReason: string;
  readonly nativeSessionMetadata: Readonly<Record<string, string>>;
  readonly startedAt: string;
  readonly completedAt: string;
}

export interface AgentRuntimeConfiguration {
  readonly kind: "codex";
  readonly model?: string;
  readonly sandbox: "workspace-write";
  readonly executable: "codex";
}

export interface AgentSessionReference {
  readonly runtimeKind: AgentRuntimeKind;
  readonly executionId: string;
  readonly nativeSessionId: string;
  readonly workingDirectory: string;
  readonly stdoutArtifactReference: string;
  readonly stderrArtifactReference: string;
  readonly nativePid?: number;
}

export interface AgentRuntimeEvent {
  readonly cursor: number;
  readonly type: string;
  readonly timestamp: string;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
}

export interface AgentRuntimeEventPage {
  readonly events: ReadonlyArray<AgentRuntimeEvent>;
  readonly nextCursor: number;
}

export type AgentRuntimeStatus =
  | { readonly state: "running" }
  | { readonly state: "completed"; readonly result: AgentRuntimeCompletion }
  | { readonly state: "unknown" };

export interface AgentRuntimeCompletion {
  readonly outcome: "completed" | "failed" | "cancelled" | "timed_out" | "blocked";
  readonly result: AgentResultEnvelope;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: AgentOutputArtifact;
  readonly stderr: AgentOutputArtifact;
}

export interface AgentOutputArtifact {
  readonly locationReference: string;
  readonly digest: string;
  readonly observedBytes: number;
  readonly persistedBytes: number;
  readonly truncated: boolean;
}

export type AgentReconciliationResult =
  | { readonly state: "completed"; readonly completion: AgentRuntimeCompletion }
  | { readonly state: "running" }
  | { readonly state: "ambiguous"; readonly reason: string };

export interface StartAgentInput {
  readonly task: BuilderTaskEnvelope;
  readonly prompt: string;
  readonly runtimeConfiguration: AgentRuntimeConfiguration;
  readonly executionId: string;
  readonly workingDirectory: string;
  readonly redactionValues: ReadonlyArray<string>;
}

export interface StartedAgentSession {
  readonly session: AgentSessionReference;
  readonly startedAt: string;
  readonly timeoutDeadline: string;
}

export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  readonly capabilities: AgentRuntimeCapabilities;
  outputReferences(executionId: string): {
    readonly stdout: string;
    readonly stderr: string;
  };
  start(input: StartAgentInput): Promise<StartedAgentSession>;
  status(session: AgentSessionReference): Promise<AgentRuntimeStatus>;
  wait(session: AgentSessionReference): Promise<AgentRuntimeCompletion>;
  cancel(session: AgentSessionReference, reason: string): Promise<void>;
  reconcile(session: AgentSessionReference): Promise<AgentReconciliationResult>;
  events(session: AgentSessionReference, cursor?: number): Promise<AgentRuntimeEventPage>;
  result(session: AgentSessionReference): Promise<AgentRuntimeCompletion | null>;
}

export type AgentRuntimeErrorCode =
  | "invalid_configuration"
  | "runtime_unavailable"
  | "runtime_start_failed"
  | "runtime_protocol_error"
  | "runtime_session_not_found"
  | "runtime_ambiguous";

export class AgentRuntimeError extends Error {
  readonly code: AgentRuntimeErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: AgentRuntimeErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "AgentRuntimeError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
