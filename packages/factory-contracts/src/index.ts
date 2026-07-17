import { ResolvedProjectConfiguration } from "@mkcode/project-config/schema";
import * as Schema from "effect/Schema";

export const FactoryApiVersion = 1 as const;
export const FactoryApiBasePath = "/v1";
export const WorkflowListDefaultPageSize = 50;
export const WorkflowListMaximumPageSize = 100;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const TrimmedNonEmptyString = Schema.Trimmed.check(Schema.isMinLength(1));

export const WorkItemSource = Schema.Literals(["manual", "conversation", "integration"]);
export type WorkItemSource = typeof WorkItemSource.Type;

export const WorkItem = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  title: Schema.String,
  description: Schema.String,
  source: WorkItemSource,
  createdAt: Schema.String,
  externalReference: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
export type WorkItem = typeof WorkItem.Type;

export const WorkflowRunStatus = Schema.Literals([
  "queued",
  "allocating_workspace",
  "planning",
  "implementing",
  "validating",
  "human_review",
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "operator_attention",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowTerminalOutcome = Schema.Literals([
  "completed",
  "rejected",
  "failed",
  "cancelled",
  "operator_attention",
]);
export type WorkflowTerminalOutcome = typeof WorkflowTerminalOutcome.Type;

export const WorkflowRun = Schema.Struct({
  id: Schema.String,
  workItemId: Schema.String,
  projectId: Schema.String,
  workflowType: Schema.String,
  status: WorkflowRunStatus,
  requestedBy: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  projectSnapshot: ResolvedProjectConfiguration,
  snapshotDigest: Schema.String,
  cancellationRequestedAt: Schema.optional(Schema.String),
  cancellationRequestedBy: Schema.optional(Schema.String),
  terminalOutcome: Schema.optional(WorkflowTerminalOutcome),
  validationCheckId: Schema.optional(Schema.String),
  version: NonNegativeInt,
});
export type WorkflowRun = typeof WorkflowRun.Type;

export const StageKey = Schema.Literals([
  "allocating_workspace",
  "planning",
  "implementing",
  "validating",
  "human_review",
  "workspace_cleanup",
]);
export type StageKey = typeof StageKey.Type;

export const StageRunStatus = Schema.Literals([
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "operator_attention",
]);
export type StageRunStatus = typeof StageRunStatus.Type;

export const StageRun = Schema.Struct({
  id: Schema.String,
  workflowRunId: Schema.String,
  stageKey: StageKey,
  sequence: PositiveInt,
  status: StageRunStatus,
  currentAttempt: NonNegativeInt,
  createdAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  outcome: Schema.optional(Schema.String),
  failureClassification: Schema.optional(Schema.String),
  version: NonNegativeInt,
});
export type StageRun = typeof StageRun.Type;

export const AttemptStatus = Schema.Literals([
  "running",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
export type AttemptStatus = typeof AttemptStatus.Type;

export const Attempt = Schema.Struct({
  id: Schema.String,
  stageRunId: Schema.String,
  attemptNumber: PositiveInt,
  status: AttemptStatus,
  createdAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  failureSummary: Schema.optional(Schema.String),
  retryOfAttemptId: Schema.optional(Schema.String),
});
export type Attempt = typeof Attempt.Type;

export const JobStatus = Schema.Literals([
  "pending",
  "claimed",
  "completed",
  "failed",
  "cancelled",
]);
export type JobStatus = typeof JobStatus.Type;

export const JobType = Schema.Literals([
  "simulation.complete-stage",
  "simulation.request-human-review",
  "command.execute",
  "workspace.allocate",
  "workspace.cleanup",
]);
export type JobType = typeof JobType.Type;
export const SimulationJobType = Schema.Literals([
  "simulation.complete-stage",
  "simulation.request-human-review",
]);
export type SimulationJobType = typeof SimulationJobType.Type;

export const JobIntent = Schema.Struct({
  id: Schema.String,
  workflowRunId: Schema.String,
  stageRunId: Schema.String,
  jobType: JobType,
  payloadVersion: PositiveInt,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  status: JobStatus,
  idempotencyKey: Schema.String,
  availableAfter: Schema.String,
  attemptCount: NonNegativeInt,
  leaseOwner: Schema.optional(Schema.String),
  leaseExpiration: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completionMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  terminalFailure: Schema.optional(Schema.String),
});
export type JobIntent = typeof JobIntent.Type;

export const Lease = Schema.Struct({
  jobId: Schema.String,
  owner: Schema.String,
  expiration: Schema.String,
});
export type Lease = typeof Lease.Type;

export const IdempotencyRecord = Schema.Struct({
  scope: Schema.String,
  key: Schema.String,
  requestDigest: Schema.String,
  storedResultReference: Schema.String,
  createdAt: Schema.String,
});
export type IdempotencyRecord = typeof IdempotencyRecord.Type;

export const ApprovalStatus = Schema.Literals(["pending", "approved", "rejected", "cancelled"]);
export type ApprovalStatus = typeof ApprovalStatus.Type;

export const Approval = Schema.Struct({
  id: Schema.String,
  workflowRunId: Schema.String,
  stageRunId: Schema.String,
  approvalType: Schema.Literal("human_review"),
  status: ApprovalStatus,
  requestedAt: Schema.String,
  resolvedAt: Schema.optional(Schema.String),
  resolvedBy: Schema.optional(Schema.String),
  rationale: Schema.optional(Schema.String),
});
export type Approval = typeof Approval.Type;

export const Artifact = Schema.Struct({
  id: Schema.String,
  workflowRunId: Schema.String,
  stageRunId: Schema.String,
  type: Schema.String,
  name: Schema.String,
  locationReference: Schema.String,
  digest: Schema.String,
  createdAt: Schema.String,
});
export type Artifact = typeof Artifact.Type;

export const CommandCategory = Schema.Literals(["setup", "check"]);
export type CommandCategory = typeof CommandCategory.Type;

export const CommandRunStatus = Schema.Literals([
  "pending",
  "starting",
  "running",
  "cancelling",
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_failed",
  "terminated",
  "operator_attention",
]);
export type CommandRunStatus = typeof CommandRunStatus.Type;

export const CommandOutcome = Schema.Literals([
  "passed",
  "failed",
  "timed_out",
  "cancelled",
  "spawn_failed",
  "terminated",
  "operator_attention",
]);
export type CommandOutcome = typeof CommandOutcome.Type;

export const CommandRun = Schema.Struct({
  id: Schema.String,
  workflowRunId: Schema.String,
  stageRunId: Schema.String,
  attemptId: Schema.optional(Schema.String),
  commandCategory: CommandCategory,
  commandId: Schema.String,
  commandDefinition: Schema.Record(Schema.String, Schema.Unknown),
  executionRoot: Schema.String,
  resolvedWorkingDirectory: Schema.String,
  executable: Schema.String,
  args: Schema.Array(Schema.String),
  environmentReferenceNames: Schema.Array(Schema.String),
  status: CommandRunStatus,
  createdAt: Schema.String,
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
  timeoutDeadline: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Int)),
  terminatingSignal: Schema.optional(Schema.NullOr(Schema.String)),
  timedOut: Schema.Boolean,
  cancelled: Schema.Boolean,
  processHostType: Schema.optional(Schema.String),
  processHostExecutionId: Schema.optional(Schema.String),
  nativePid: Schema.optional(PositiveInt),
  stdoutArtifactReference: Schema.optional(Schema.String),
  stderrArtifactReference: Schema.optional(Schema.String),
  stdoutDigest: Schema.optional(Schema.String),
  stderrDigest: Schema.optional(Schema.String),
  stdoutObservedBytes: NonNegativeInt,
  stderrObservedBytes: NonNegativeInt,
  stdoutPersistedBytes: NonNegativeInt,
  stderrPersistedBytes: NonNegativeInt,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
  redactionMetadata: Schema.Record(Schema.String, Schema.Unknown),
  outcome: Schema.optional(CommandOutcome),
  failureClassification: Schema.optional(Schema.String),
  version: PositiveInt,
});
export type CommandRun = typeof CommandRun.Type;

export const CommandExecutionCompletion = Schema.Struct({
  outcome: CommandOutcome,
  executionId: Schema.String,
  workingDirectory: Schema.String,
  processHostType: Schema.String,
  nativePid: Schema.optional(PositiveInt),
  startedAt: Schema.optional(Schema.String),
  completedAt: Schema.String,
  timeoutDeadline: Schema.optional(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  cancelled: Schema.Boolean,
  stdout: Schema.Struct({
    locationReference: Schema.String,
    digest: Schema.String,
    observedBytes: NonNegativeInt,
    persistedBytes: NonNegativeInt,
    truncated: Schema.Boolean,
  }),
  stderr: Schema.Struct({
    locationReference: Schema.String,
    digest: Schema.String,
    observedBytes: NonNegativeInt,
    persistedBytes: NonNegativeInt,
    truncated: Schema.Boolean,
  }),
  resolvedEnvironmentNames: Schema.Array(Schema.String),
  redactionCount: NonNegativeInt,
  spawnErrorCode: Schema.optional(Schema.String),
});
export type CommandExecutionCompletion = typeof CommandExecutionCompletion.Type;

export const CommandOutputPage = Schema.Struct({
  commandRunId: Schema.String,
  stream: Schema.Literals(["stdout", "stderr"]),
  data: Schema.String,
  nextCursor: NonNegativeInt,
  end: Schema.Boolean,
  truncated: Schema.Boolean,
});
export type CommandOutputPage = typeof CommandOutputPage.Type;

export const WorkspaceStatus = Schema.Literals([
  "pending",
  "allocating",
  "ready",
  "retained",
  "cleanup_pending",
  "removed",
  "allocation_failed",
  "missing",
  "ownership_mismatch",
  "modified",
  "cleanup_failed",
  "operator_attention",
]);
export type WorkspaceStatus = typeof WorkspaceStatus.Type;

export const Workspace = Schema.Struct({
  id: Schema.String,
  workflowRunId: Schema.String,
  projectId: Schema.String,
  type: Schema.Literal("git_worktree"),
  status: WorkspaceStatus,
  sourceRepositoryPath: Schema.String,
  canonicalSourceRepositoryPath: Schema.optional(Schema.String),
  gitCommonDirectory: Schema.optional(Schema.String),
  requestedBaseBranch: Schema.String,
  resolvedBaseReference: Schema.optional(Schema.String),
  resolvedBaseCommit: Schema.optional(Schema.String),
  baseResolvedAt: Schema.optional(Schema.String),
  generatedBranchName: Schema.optional(Schema.String),
  worktreePath: Schema.optional(Schema.String),
  canonicalWorktreePath: Schema.optional(Schema.String),
  configuredWorktreeRoot: Schema.String,
  effectiveWorktreeRoot: Schema.optional(Schema.String),
  ownershipClaimPath: Schema.optional(Schema.String),
  ownershipMarkerPath: Schema.optional(Schema.String),
  ownershipMarkerDigest: Schema.optional(Schema.String),
  creationIntentAt: Schema.String,
  creationStartedAt: Schema.optional(Schema.String),
  readyAt: Schema.optional(Schema.String),
  retainedAt: Schema.optional(Schema.String),
  cleanupRequestedAt: Schema.optional(Schema.String),
  cleanupCompletedAt: Schema.optional(Schema.String),
  failureClassification: Schema.optional(Schema.String),
  operatorAttentionReason: Schema.optional(Schema.String),
  gitMetadataState: Schema.optional(Schema.String),
  currentObservedHead: Schema.optional(Schema.String),
  currentObservedBranch: Schema.optional(Schema.String),
  dirtyState: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  version: PositiveInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type Workspace = typeof Workspace.Type;

export const WorkflowEvent = Schema.Struct({
  cursor: PositiveInt,
  id: Schema.String,
  workflowRunId: Schema.String,
  eventType: Schema.String,
  schemaVersion: PositiveInt,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  timestamp: Schema.String,
});
export type WorkflowEvent = typeof WorkflowEvent.Type;

export const WorkflowCreateRequest = Schema.Struct({
  idempotencyKey: TrimmedNonEmptyString,
  workItem: Schema.Struct({
    id: Schema.optional(Schema.String),
    projectId: TrimmedNonEmptyString,
    title: Schema.String,
    description: Schema.String,
    source: WorkItemSource,
    externalReference: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  workflowType: Schema.String,
  requestedBy: TrimmedNonEmptyString,
  projectSnapshot: ResolvedProjectConfiguration,
  validationCheckId: Schema.optional(TrimmedNonEmptyString),
});
export type WorkflowCreateRequest = typeof WorkflowCreateRequest.Type;

export const WorkflowCreateResult = Schema.Struct({
  workItem: WorkItem,
  workflowRun: WorkflowRun,
  stageRun: StageRun,
  jobIntent: JobIntent,
  replayed: Schema.Boolean,
});
export type WorkflowCreateResult = typeof WorkflowCreateResult.Type;

export const WorkflowDetail = Schema.Struct({
  workItem: WorkItem,
  workflowRun: WorkflowRun,
  stages: Schema.Array(StageRun),
  attempts: Schema.Array(Attempt),
  jobs: Schema.Array(JobIntent),
  approvals: Schema.Array(Approval),
  artifacts: Schema.Array(Artifact),
  commands: Schema.Array(CommandRun),
  workspaces: Schema.Array(Workspace),
});
export type WorkflowDetail = typeof WorkflowDetail.Type;

export const WorkflowListResult = Schema.Struct({
  runs: Schema.Array(WorkflowRun),
  nextCursor: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  hasMore: Schema.Boolean,
});
export type WorkflowListResult = typeof WorkflowListResult.Type;

export const WorkflowCancelRequest = Schema.Struct({
  requestedBy: Schema.String,
});
export type WorkflowCancelRequest = typeof WorkflowCancelRequest.Type;

export const WorkspaceActionRequest = Schema.Struct({
  idempotencyKey: TrimmedNonEmptyString,
  requestedBy: TrimmedNonEmptyString,
});
export type WorkspaceActionRequest = typeof WorkspaceActionRequest.Type;

export const ApprovalResolveRequest = Schema.Struct({
  decision: Schema.Literals(["approved", "rejected"]),
  resolvedBy: Schema.String,
  rationale: Schema.optional(Schema.String),
});
export type ApprovalResolveRequest = typeof ApprovalResolveRequest.Type;

export const EventsListResult = Schema.Struct({
  events: Schema.Array(WorkflowEvent),
  nextCursor: NonNegativeInt,
});
export type EventsListResult = typeof EventsListResult.Type;

export const FactoryHealth = Schema.Struct({
  ok: Schema.Literal(true),
  apiVersion: Schema.Literal(1),
  workerInstanceId: Schema.String,
  schemaVersion: PositiveInt,
});
export type FactoryHealth = typeof FactoryHealth.Type;

export const FactoryErrorCode = Schema.Literals([
  "invalid_request",
  "unauthorized",
  "not_found",
  "conflict",
  "stale_version",
  "invalid_transition",
  "invalid_cursor",
  "unsupported_schema",
  "internal_error",
]);
export type FactoryErrorCode = typeof FactoryErrorCode.Type;

export const FactoryApiError = Schema.Struct({
  code: FactoryErrorCode,
  message: Schema.String,
  details: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type FactoryApiError = typeof FactoryApiError.Type;
