// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics cryptoRandomUUID:off -- Execution IDs are durable launch fences.
// @effect-diagnostics globalTimers:off -- Lease renewal is scoped to one runtime execution.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeTimers from "node:timers";

import {
  AgentRuntimeError,
  type AgentRuntime,
  type AgentRuntimeCompletion,
  type AgentRuntimeConfiguration,
  type AgentSessionReference,
  type BuilderTaskEnvelope,
  assertWorkspaceSymlinkContainment,
  composeBuilderPrompt,
  evaluateAgentWorkspacePolicy,
  validateBuilderTaskEnvelope,
} from "@mkcode/agent-runtime";
import type { AgentRun, Workspace } from "@mkcode/factory-contracts";
import type { ClaimedJob, WorkflowEngine } from "@mkcode/workflow-engine";
import type {
  InspectWorkspaceInput,
  WorkspaceGitEvidence,
  WorkspaceManager,
} from "@mkcode/workspace-manager";

const MAX_CONTEXT_FILE_BYTES = 262_144;
const MAX_CONTEXT_TOTAL_BYTES = 1_048_576;

const inspectionInput = (workspace: Workspace): InspectWorkspaceInput | undefined => {
  if (
    !workspace.canonicalSourceRepositoryPath ||
    !workspace.gitCommonDirectory ||
    !workspace.canonicalWorktreePath ||
    !workspace.generatedBranchName ||
    !workspace.resolvedBaseCommit ||
    !workspace.ownershipMarkerDigest
  )
    return undefined;
  return {
    workspaceId: workspace.id,
    workflowRunId: workspace.workflowRunId,
    projectId: workspace.projectId,
    canonicalSourceRepositoryPath: workspace.canonicalSourceRepositoryPath,
    gitCommonDirectory: workspace.gitCommonDirectory,
    canonicalWorktreePath: workspace.canonicalWorktreePath,
    branchName: workspace.generatedBranchName,
    resolvedBaseCommit: workspace.resolvedBaseCommit,
    ...(workspace.ownershipClaimPath ? { ownershipClaimPath: workspace.ownershipClaimPath } : {}),
    ...(workspace.ownershipMarkerPath
      ? { ownershipMarkerPath: workspace.ownershipMarkerPath }
      : {}),
    ownershipMarkerDigest: workspace.ownershipMarkerDigest,
  };
};

const runtimeConfiguration = (
  value: Readonly<Record<string, unknown>>,
): AgentRuntimeConfiguration => {
  if (
    value.kind !== "codex" ||
    value.executable !== "codex" ||
    value.sandbox !== "workspace-write" ||
    (value.model !== undefined && typeof value.model !== "string")
  )
    throw new AgentRuntimeError(
      "invalid_configuration",
      "Snapshotted runtime configuration is invalid.",
    );
  return {
    kind: "codex",
    executable: "codex",
    sandbox: "workspace-write",
    ...(typeof value.model === "string" ? { model: value.model } : {}),
  };
};

const toRecord = (value: WorkspaceGitEvidence): Readonly<Record<string, unknown>> => ({ ...value });

const completionEvidence = (
  completion: AgentRuntimeCompletion,
  postGitEvidence: Readonly<Record<string, unknown>>,
  policyViolations: ReadonlyArray<string>,
) => ({
  outcome: completion.outcome,
  resultEnvelope: { ...completion.result },
  completionReason: completion.result.runtimeCompletionReason,
  stdout: completion.stdout,
  stderr: completion.stderr,
  postGitEvidence,
  policyViolations,
});

const sessionFromAgent = (
  agent: AgentRun,
  task: BuilderTaskEnvelope,
): AgentSessionReference | undefined => {
  if (
    !agent.processHostExecutionId ||
    !agent.runtimeSessionId ||
    !agent.stdoutArtifactReference ||
    !agent.stderrArtifactReference
  )
    return undefined;
  return {
    runtimeKind: "codex",
    executionId: agent.processHostExecutionId,
    nativeSessionId: agent.runtimeSessionId,
    workingDirectory: task.worktreePathReference,
    stdoutArtifactReference: agent.stdoutArtifactReference,
    stderrArtifactReference: agent.stderrArtifactReference,
    ...(agent.nativePid === undefined ? {} : { nativePid: agent.nativePid }),
  };
};

const loadContext = async (
  root: string,
  references: ReadonlyArray<string>,
): Promise<ReadonlyArray<{ readonly path: string; readonly content: string }>> => {
  const canonicalRoot = await NodeFSP.realpath(root);
  let total = 0;
  const result: Array<{ readonly path: string; readonly content: string }> = [];
  for (const reference of references) {
    if (NodePath.isAbsolute(reference) || reference.split(/[\\/]/u).includes(".."))
      throw new AgentRuntimeError("invalid_configuration", "Project context path is unsafe.");
    const candidate = NodePath.resolve(canonicalRoot, reference);
    const canonical = await NodeFSP.realpath(candidate);
    const relative = NodePath.relative(canonicalRoot, canonical);
    if (
      relative === ".." ||
      relative.startsWith(`..${NodePath.sep}`) ||
      NodePath.isAbsolute(relative)
    )
      throw new AgentRuntimeError("invalid_configuration", "Project context escapes the worktree.");
    const stat = await NodeFSP.lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONTEXT_FILE_BYTES)
      throw new AgentRuntimeError(
        "invalid_configuration",
        "Project context file is unavailable or too large.",
      );
    total += stat.size;
    if (total > MAX_CONTEXT_TOTAL_BYTES)
      throw new AgentRuntimeError(
        "invalid_configuration",
        "Project context exceeds the bounded input limit.",
      );
    result.push({ path: reference, content: await NodeFSP.readFile(candidate, "utf8") });
  }
  return result;
};

export class AgentExecutionWorker {
  readonly #engine: WorkflowEngine;
  readonly #runtime: AgentRuntime;
  readonly #workspaceManager: WorkspaceManager;
  readonly #workerInstanceId: string;
  readonly #leaseMilliseconds: number;
  readonly #redactionValues: ReadonlyArray<string>;
  readonly #active = new Map<string, AgentSessionReference>();
  #stopping = false;

  constructor(input: {
    readonly engine: WorkflowEngine;
    readonly runtime: AgentRuntime;
    readonly workspaceManager: WorkspaceManager;
    readonly workerInstanceId: string;
    readonly leaseMilliseconds: number;
    readonly redactionValues: ReadonlyArray<string>;
  }) {
    this.#engine = input.engine;
    this.#runtime = input.runtime;
    this.#workspaceManager = input.workspaceManager;
    this.#workerInstanceId = input.workerInstanceId;
    this.#leaseMilliseconds = input.leaseMilliseconds;
    this.#redactionValues = input.redactionValues;
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled(
      [...this.#active.values()].map((session) => this.#runtime.cancel(session, "worker_shutdown")),
    );
  }

  async cancelWorkflow(workflowRunId: string): Promise<void> {
    const session = this.#active.get(workflowRunId);
    if (!session) return;
    try {
      await this.#runtime.cancel(session, "workflow_cancelled");
    } catch (cause) {
      const agent = this.#engine
        .readWorkflow(workflowRunId)
        .agentRuns.find((candidate) => candidate.processHostExecutionId === session.executionId);
      if (agent) {
        this.#engine.markAgentOperatorAttention(agent.id, "runtime_cancellation_failed");
      }
      throw cause;
    }
  }

  async runClaimed(claimed: ClaimedJob): Promise<void> {
    if (this.#stopping) return;
    if (claimed.job.jobType !== "agent.execute")
      throw new TypeError("Agent worker received a non-agent job.");
    const detail = this.#engine.readWorkflow(claimed.job.workflowRunId);
    const agent = detail.agentRuns.find(
      (candidate) => candidate.stageRunId === claimed.job.stageRunId,
    );
    const workspace = agent
      ? detail.workspaces.find((candidate) => candidate.id === agent.workspaceId)
      : undefined;
    if (!agent || agent.status !== "pending" || !workspace || workspace.status !== "ready") {
      throw new TypeError("Claimed agent job has no pending AgentRun in a ready workspace.");
    }
    const inspectInput = inspectionInput(workspace);
    if (!inspectInput) {
      this.#engine.markAgentOperatorAttention(agent.id, "workspace_evidence_incomplete");
      return;
    }
    let renewal: ReturnType<typeof NodeTimers.setInterval>;
    let renewalFailed = false;
    let startedSession: AgentSessionReference | undefined;
    renewal = NodeTimers.setInterval(
      () => {
        try {
          this.#engine.renewLease(claimed.job.id, this.#workerInstanceId, this.#leaseMilliseconds);
        } catch {
          renewalFailed = true;
          if (startedSession) {
            void this.#runtime.cancel(startedSession, "lease_lost").catch(() => undefined);
          }
        }
      },
      Math.max(50, Math.floor(this.#leaseMilliseconds / 3)),
    );
    renewal.unref();
    try {
      let task: BuilderTaskEnvelope;
      let before: WorkspaceGitEvidence;
      try {
        task = validateBuilderTaskEnvelope(agent.taskEnvelope as unknown as BuilderTaskEnvelope);
        before = await this.#workspaceManager.captureGitEvidence(inspectInput);
        await assertWorkspaceSymlinkContainment(workspace.canonicalWorktreePath!);
      } catch {
        this.#engine.markAgentOperatorAttention(agent.id, "workspace_preflight_failed");
        return;
      }
      if (renewalFailed) {
        throw new AgentRuntimeError("runtime_ambiguous", "Agent preflight lost its durable lease.");
      }
      const executionId = NodeCrypto.randomUUID();
      const references = this.#runtime.outputReferences(executionId);
      let current = this.#engine.startAgent({
        agentRunId: agent.id,
        jobId: claimed.job.id,
        leaseOwner: this.#workerInstanceId,
        attemptId: claimed.attempt.id,
        expectedStageVersion: claimed.stageVersion,
        evidence: {
          processHostExecutionId: executionId,
          stdoutArtifactReference: references.stdout,
          stderrArtifactReference: references.stderr,
          preGitEvidence: toRecord(before),
        },
      });
      const projectContext = await loadContext(
        workspace.canonicalWorktreePath!,
        task.contextFileReferences,
      );
      if (renewalFailed) {
        throw new AgentRuntimeError("runtime_ambiguous", "Agent startup lost its durable lease.");
      }
      const prompt = composeBuilderPrompt({
        task,
        projectContext,
        repositoryContext: { branch: before.branch, baseCommit: before.baseCommit },
        runtimeAppendix: "Codex must make the bounded edit, then return the requested JSON result.",
      });
      const started = await this.#runtime.start({
        task,
        prompt,
        runtimeConfiguration: runtimeConfiguration(agent.runtimeConfiguration),
        executionId,
        workingDirectory: workspace.canonicalWorktreePath!,
        redactionValues: this.#redactionValues,
      });
      startedSession = started.session;
      this.#active.set(agent.workflowRunId, started.session);
      if (renewalFailed) {
        await this.#runtime.cancel(started.session, "lease_lost");
        throw new AgentRuntimeError("runtime_ambiguous", "Agent startup lost its durable lease.");
      }
      const durableAfterStart = this.#engine.readAgentRun(agent.id);
      if (
        durableAfterStart.status === "cancel_requested" ||
        durableAfterStart.status === "cancelled"
      ) {
        await this.#settleCancelledStart(
          agent,
          workspace,
          inspectInput,
          before,
          started,
          claimed,
          durableAfterStart,
        );
        return;
      }
      try {
        current = this.#engine.markAgentRunning({
          agentRunId: agent.id,
          jobId: claimed.job.id,
          leaseOwner: this.#workerInstanceId,
          expectedStageVersion: claimed.stageVersion,
          expectedVersion: current.version,
          evidence: {
            runtimeSessionId: started.session.nativeSessionId,
            runtimeThreadId: started.session.nativeSessionId,
            processHostExecutionId: started.session.executionId,
            ...(started.session.nativePid === undefined
              ? {}
              : { nativePid: started.session.nativePid }),
            startedAt: started.startedAt,
          },
        });
      } catch (cause) {
        const durableAfterFence = this.#engine.readAgentRun(agent.id);
        if (
          durableAfterFence.status !== "cancel_requested" &&
          durableAfterFence.status !== "cancelled"
        ) {
          throw cause;
        }
        await this.#settleCancelledStart(
          agent,
          workspace,
          inspectInput,
          before,
          started,
          claimed,
          durableAfterFence,
        );
        return;
      }
      if (this.#stopping) {
        await this.#runtime.cancel(started.session, "worker_shutdown");
        return;
      }
      const completion = await this.#runtime.wait(started.session);
      if (this.#stopping || renewalFailed) return;
      await this.#persistCompletion(
        agent,
        workspace,
        inspectInput,
        before,
        completion,
        started.session,
        claimed,
        false,
      );
    } catch (cause) {
      if (this.#stopping) return;
      if (startedSession) {
        await this.#runtime.cancel(startedSession, "launch_fence_lost").catch(() => undefined);
      }
      if (
        cause instanceof AgentRuntimeError &&
        ["runtime_unavailable", "invalid_configuration"].includes(cause.code)
      ) {
        this.#engine.failAgentBeforeLaunch({
          agentRunId: agent.id,
          jobId: claimed.job.id,
          leaseOwner: this.#workerInstanceId,
          expectedStageVersion: claimed.stageVersion,
          failureClassification: cause.code,
        });
      } else {
        this.#engine.markAgentOperatorAttention(agent.id, "runtime_launch_or_monitoring_ambiguous");
      }
    } finally {
      NodeTimers.clearInterval(renewal);
      this.#active.delete(agent.workflowRunId);
    }
  }

  async #settleCancelledStart(
    agent: AgentRun,
    workspace: Workspace,
    inspectInput: InspectWorkspaceInput,
    before: WorkspaceGitEvidence,
    started: Awaited<ReturnType<AgentRuntime["start"]>>,
    claimed: ClaimedJob,
    durable: AgentRun,
  ): Promise<void> {
    if (!this.#stopping && durable.status === "cancel_requested") {
      this.#engine.recordAgentCancellationReceipt({
        agentRunId: agent.id,
        expectedVersion: durable.version,
        evidence: {
          runtimeSessionId: started.session.nativeSessionId,
          runtimeThreadId: started.session.nativeSessionId,
          processHostExecutionId: started.session.executionId,
          ...(started.session.nativePid === undefined
            ? {}
            : { nativePid: started.session.nativePid }),
          startedAt: started.startedAt,
        },
      });
    }
    await this.#runtime.cancel(started.session, "workflow_cancelled");
    if (this.#stopping) return;
    const completion = await this.#runtime.wait(started.session);
    await this.#persistCompletion(
      agent,
      workspace,
      inspectInput,
      before,
      completion,
      started.session,
      claimed,
      false,
    );
  }

  async reconcileAll(): Promise<void> {
    for (const agent of this.#engine.listAgentRunsForReconciliation()) {
      try {
        const task = validateBuilderTaskEnvelope(
          agent.taskEnvelope as unknown as BuilderTaskEnvelope,
        );
        const session = sessionFromAgent(agent, task);
        if (!session) {
          this.#engine.markAgentOperatorAttention(agent.id, "runtime_launch_receipt_missing");
          continue;
        }
        const reconciled = await this.#runtime.reconcile(session);
        if (reconciled.state !== "completed") {
          this.#engine.markAgentOperatorAttention(
            agent.id,
            reconciled.state === "ambiguous"
              ? reconciled.reason
              : "runtime_recovery_requires_live_reattachment",
          );
          continue;
        }
        const detail = this.#engine.readWorkflow(agent.workflowRunId);
        const workspace = detail.workspaces.find((candidate) => candidate.id === agent.workspaceId);
        const stage = detail.stages.find((candidate) => candidate.id === agent.stageRunId);
        const job = detail.jobs.find(
          (candidate) =>
            candidate.stageRunId === agent.stageRunId && candidate.jobType === "agent.execute",
        );
        const attempt = stage
          ? detail.attempts.find((candidate) => candidate.stageRunId === stage.id)
          : undefined;
        const inspectInput = workspace ? inspectionInput(workspace) : undefined;
        if (!workspace || !stage || !job || !attempt || !inspectInput || !agent.preGitEvidence) {
          this.#engine.markAgentOperatorAttention(agent.id, "runtime_recovery_evidence_incomplete");
          continue;
        }
        await this.#persistCompletion(
          agent,
          workspace,
          inspectInput,
          agent.preGitEvidence as unknown as WorkspaceGitEvidence,
          reconciled.completion,
          session,
          { job, attempt, stageVersion: stage.version },
          true,
        );
      } catch {
        try {
          this.#engine.markAgentOperatorAttention(agent.id, "runtime_reconciliation_failed");
        } catch {
          // A concurrent terminal transition already resolved this AgentRun.
        }
      }
    }
  }

  async #persistCompletion(
    agent: AgentRun,
    workspace: Workspace,
    inspectInput: InspectWorkspaceInput,
    before: WorkspaceGitEvidence,
    completion: AgentRuntimeCompletion,
    session: AgentSessionReference,
    claimed: ClaimedJob,
    recovery: boolean,
  ): Promise<void> {
    if (
      completion.result.agentRunId !== agent.id ||
      completion.result.runtimeSessionReference !== session.nativeSessionId ||
      completion.stdout.locationReference !== session.stdoutArtifactReference ||
      completion.stderr.locationReference !== session.stderrArtifactReference
    ) {
      this.#engine.markAgentOperatorAttention(agent.id, "runtime_completion_identity_mismatch");
      return;
    }
    let after: WorkspaceGitEvidence;
    let violations: ReadonlyArray<string>;
    try {
      after = await this.#workspaceManager.captureGitEvidence(inspectInput);
      violations = (
        await evaluateAgentWorkspacePolicy({
          task: validateBuilderTaskEnvelope(agent.taskEnvelope as unknown as BuilderTaskEnvelope),
          worktreeRoot: workspace.canonicalWorktreePath!,
          before,
          after,
        })
      ).violations;
    } catch {
      after = before;
      violations = ["workspace_postflight_failed"];
    }
    this.#engine.completeAgent({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: this.#workerInstanceId,
      expectedStageVersion: claimed.stageVersion,
      evidence: completionEvidence(completion, toRecord(after), violations),
      ...(recovery ? { recovery: true } : {}),
    });
  }
}
