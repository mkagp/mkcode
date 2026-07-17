// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics cryptoRandomUUID:off -- Ownership nonces are persisted before Git side effects.
// @effect-diagnostics globalTimers:off -- Workspace operations renew durable leases while Git runs.
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";

import type { Workspace } from "@mkcode/factory-contracts";
import type { ClaimedJob, WorkflowEngine } from "@mkcode/workflow-engine";
import {
  GitWorktreeWorkspaceManager,
  type InspectWorkspaceInput,
  type WorkspaceAllocationPlan,
  type WorkspaceInspection,
  type WorkspaceManager,
  WorkspaceManagerError,
} from "@mkcode/workspace-manager";

const inspectionInput = (workspace: Workspace): InspectWorkspaceInput | undefined => {
  if (
    !workspace.canonicalSourceRepositoryPath ||
    !workspace.gitCommonDirectory ||
    !workspace.worktreePath ||
    !workspace.generatedBranchName ||
    !workspace.resolvedBaseCommit ||
    !workspace.ownershipMarkerDigest
  ) {
    return undefined;
  }
  return {
    workspaceId: workspace.id,
    workflowRunId: workspace.workflowRunId,
    projectId: workspace.projectId,
    canonicalSourceRepositoryPath: workspace.canonicalSourceRepositoryPath,
    gitCommonDirectory: workspace.gitCommonDirectory,
    canonicalWorktreePath: workspace.canonicalWorktreePath ?? workspace.worktreePath,
    branchName: workspace.generatedBranchName,
    resolvedBaseCommit: workspace.resolvedBaseCommit,
    ...(workspace.ownershipClaimPath ? { ownershipClaimPath: workspace.ownershipClaimPath } : {}),
    ...(workspace.ownershipMarkerPath
      ? { ownershipMarkerPath: workspace.ownershipMarkerPath }
      : {}),
    ownershipMarkerDigest: workspace.ownershipMarkerDigest,
  };
};

const readyEvidence = (allocated: Awaited<ReturnType<WorkspaceManager["allocate"]>>) => ({
  canonicalWorktreePath: allocated.canonicalWorktreePath,
  ownershipMarkerPath: allocated.ownershipMarkerPath,
  ownershipMarkerDigest: allocated.ownershipMarkerDigest,
  gitMetadataState: allocated.gitMetadataState,
  currentObservedHead: allocated.head,
  currentObservedBranch: allocated.branchName,
  dirty: allocated.dirty,
});

const inspectionEvidence = (inspection: WorkspaceInspection) => ({
  matching: inspection.state === "matching",
  state: inspection.state,
  ...(inspection.reason ? { reason: inspection.reason } : {}),
  gitMetadataState: inspection.gitMetadataState,
  ...(inspection.observedHead ? { currentObservedHead: inspection.observedHead } : {}),
  ...(inspection.observedBranch ? { currentObservedBranch: inspection.observedBranch } : {}),
  ...(inspection.dirty === undefined ? {} : { dirty: inspection.dirty }),
});

const requiresOperatorAttention = (cause: unknown, sideEffectStarted: boolean): boolean => {
  if (!sideEffectStarted) return false;
  if (!(cause instanceof WorkspaceManagerError)) return true;
  return !["path_collision", "branch_collision", "base_ref_missing"].includes(cause.code);
};

export class WorkspaceExecutionWorker {
  readonly #engine: WorkflowEngine;
  readonly #manager: WorkspaceManager;
  readonly #workerInstanceId: string;
  readonly #factoryStateRoot: string;
  readonly #leaseMilliseconds: number;
  #stopping = false;

  constructor(input: {
    readonly engine: WorkflowEngine;
    readonly workerInstanceId: string;
    readonly factoryStateRoot: string;
    readonly leaseMilliseconds: number;
    readonly manager?: WorkspaceManager;
  }) {
    this.#engine = input.engine;
    this.#workerInstanceId = input.workerInstanceId;
    this.#factoryStateRoot = input.factoryStateRoot;
    this.#leaseMilliseconds = input.leaseMilliseconds;
    this.#manager = input.manager ?? new GitWorktreeWorkspaceManager();
  }

  stop(): void {
    this.#stopping = true;
  }

  async runClaimed(claimed: ClaimedJob): Promise<void> {
    if (this.#stopping) return;
    let renewal: ReturnType<typeof NodeTimers.setInterval> | undefined;
    renewal = NodeTimers.setInterval(
      () => {
        try {
          this.#engine.renewLease(claimed.job.id, this.#workerInstanceId, this.#leaseMilliseconds);
        } catch {
          // The engine transitions below retain the same lease and stage fences;
          // a lost renewal therefore prevents durable confirmation.
        }
      },
      Math.max(50, Math.floor(this.#leaseMilliseconds / 3)),
    );
    renewal.unref();
    try {
      if (claimed.job.jobType === "workspace.allocate") {
        await this.#allocate(claimed);
        return;
      }
      if (claimed.job.jobType === "workspace.cleanup") {
        await this.#cleanup(claimed);
        return;
      }
      throw new TypeError("Workspace worker received a non-workspace job.");
    } finally {
      if (renewal) NodeTimers.clearInterval(renewal);
    }
  }

  async reconcileAll(): Promise<void> {
    for (const workspace of this.#engine.listWorkspacesForReconciliation()) {
      if (workspace.status === "pending") continue;
      const input = inspectionInput(workspace);
      if (!input) {
        this.#engine.recordWorkspaceInspection(workspace.id, {
          matching: false,
          state: "ownership_mismatch",
          reason: "Durable workspace ownership evidence is incomplete.",
          gitMetadataState: "incomplete_record",
        });
        continue;
      }
      let inspection: WorkspaceInspection;
      try {
        inspection = await this.#manager.inspect(input);
      } catch {
        this.#engine.recordWorkspaceInspection(workspace.id, {
          matching: false,
          state: "ownership_ambiguous",
          reason: "Workspace inspection failed without trustworthy ownership evidence.",
          gitMetadataState: "inspection_failed",
        });
        continue;
      }
      if (workspace.status === "allocating") {
        if (inspection.state === "allocation_incomplete") {
          let resumed;
          try {
            resumed = await this.#manager.resume(input);
          } catch {
            this.#engine.recordWorkspaceInspection(workspace.id, {
              matching: false,
              state: "ownership_ambiguous",
              reason: "Incomplete workspace allocation could not be resumed safely.",
              gitMetadataState: "resume_failed",
            });
            continue;
          }
          this.#engine.recoverWorkspaceAllocation(workspace.id, readyEvidence(resumed));
          continue;
        }
        if (inspection.state === "matching") {
          if (!inspection.canonicalPath || !inspection.observedHead || !inspection.observedBranch) {
            this.#engine.recordWorkspaceInspection(workspace.id, inspectionEvidence(inspection));
            continue;
          }
          this.#engine.recoverWorkspaceAllocation(workspace.id, {
            canonicalWorktreePath: inspection.canonicalPath,
            ownershipMarkerPath: inspection.ownershipMarkerPath ?? input.ownershipMarkerPath ?? "",
            ownershipMarkerDigest: input.ownershipMarkerDigest,
            gitMetadataState: inspection.gitMetadataState,
            currentObservedHead: inspection.observedHead,
            currentObservedBranch: inspection.observedBranch,
            dirty: inspection.dirty ?? false,
          });
        } else if (
          inspection.state === "missing" &&
          inspection.gitMetadataState === "absent" &&
          !inspection.gitMetadataPresent
        ) {
          this.#engine.resetInterruptedWorkspaceAllocation(workspace.id);
        } else {
          this.#engine.recordWorkspaceInspection(workspace.id, inspectionEvidence(inspection));
        }
        continue;
      }
      if (
        workspace.status === "cleanup_pending" &&
        inspection.state === "missing" &&
        ["absent", "branch_without_worktree"].includes(inspection.gitMetadataState) &&
        !inspection.gitMetadataPresent
      ) {
        this.#engine.reconcileWorkspaceRemoved(workspace.id);
        continue;
      }
      this.#engine.recordWorkspaceInspection(workspace.id, inspectionEvidence(inspection));
    }
  }

  async #allocate(claimed: ClaimedJob): Promise<void> {
    const detail = this.#engine.readWorkflow(claimed.job.workflowRunId);
    const workspace = detail.workspaces[0];
    if (!workspace || workspace.status !== "pending") {
      throw new TypeError("Claimed allocation job has no pending Workspace.");
    }
    let plan: WorkspaceAllocationPlan;
    try {
      plan = await this.#manager.plan({
        workspaceId: workspace.id,
        workflowRunId: workspace.workflowRunId,
        projectId: workspace.projectId,
        sourceRepositoryPath: workspace.sourceRepositoryPath,
        requestedBaseBranch: workspace.requestedBaseBranch,
        configuredWorktreeRoot: workspace.configuredWorktreeRoot,
        factoryStateRoot: this.#factoryStateRoot,
        createdAt: workspace.createdAt,
        ownershipNonce: NodeCrypto.randomUUID(),
      });
    } catch (cause) {
      const code =
        cause instanceof WorkspaceManagerError ? cause.code : "workspace_allocation_failed";
      this.#engine.failWorkspaceAllocation({
        workspaceId: workspace.id,
        jobId: claimed.job.id,
        leaseOwner: this.#workerInstanceId,
        expectedStageVersion: claimed.stageVersion,
        failureClassification: code,
        operatorAttention: requiresOperatorAttention(cause, false),
      });
      return;
    }
    this.#engine.beginWorkspaceAllocation({
      workspaceId: workspace.id,
      jobId: claimed.job.id,
      leaseOwner: this.#workerInstanceId,
      expectedStageVersion: claimed.stageVersion,
      evidence: {
        canonicalSourceRepositoryPath: plan.canonicalSourceRepositoryPath,
        gitCommonDirectory: plan.gitCommonDirectory,
        ...(plan.resolvedBaseReference
          ? { resolvedBaseReference: plan.resolvedBaseReference }
          : {}),
        resolvedBaseCommit: plan.resolvedBaseCommit,
        baseResolvedAt: plan.baseResolvedAt,
        generatedBranchName: plan.branchName,
        worktreePath: plan.worktreePath,
        effectiveWorktreeRoot: plan.effectiveWorktreeRoot,
        ownershipClaimPath: plan.ownershipClaimPath,
        ownershipMarkerDigest: plan.markerDigest,
      },
    });
    let allocated;
    try {
      allocated = await this.#manager.allocate(plan);
    } catch (cause) {
      const code =
        cause instanceof WorkspaceManagerError ? cause.code : "workspace_allocation_failed";
      this.#engine.failWorkspaceAllocation({
        workspaceId: workspace.id,
        jobId: claimed.job.id,
        leaseOwner: this.#workerInstanceId,
        expectedStageVersion: claimed.stageVersion,
        failureClassification: code,
        operatorAttention: requiresOperatorAttention(cause, true),
      });
      return;
    }
    this.#engine.confirmWorkspaceAllocation({
      workspaceId: workspace.id,
      jobId: claimed.job.id,
      leaseOwner: this.#workerInstanceId,
      expectedStageVersion: claimed.stageVersion,
      evidence: readyEvidence(allocated),
    });
  }

  async #cleanup(claimed: ClaimedJob): Promise<void> {
    const workspace = this.#engine.readWorkflowWorkspace(claimed.job.workflowRunId);
    const input = inspectionInput(workspace);
    if (!input) {
      this.#engine.completeWorkspaceCleanup({
        workspaceId: workspace.id,
        jobId: claimed.job.id,
        leaseOwner: this.#workerInstanceId,
        expectedStageVersion: claimed.stageVersion,
        removed: false,
        reason: "ownership_mismatch",
      });
      return;
    }
    let result;
    try {
      result = await this.#manager.remove(input);
    } catch (cause) {
      result = {
        removed: false,
        branchRetained: true,
        reason: cause instanceof WorkspaceManagerError ? cause.code : "cleanup_failed",
      } as const;
    }
    this.#engine.completeWorkspaceCleanup({
      workspaceId: workspace.id,
      jobId: claimed.job.id,
      leaseOwner: this.#workerInstanceId,
      expectedStageVersion: claimed.stageVersion,
      removed: result.removed,
      ...(result.reason ? { reason: result.reason } : {}),
    });
  }
}
