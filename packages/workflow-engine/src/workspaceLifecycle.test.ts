// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, it } from "@effect/vitest";

import { makeCreateRequest, makeProjectSnapshot } from "./testFixtures.ts";
import { WorkflowEngine } from "./workflowEngine.ts";

const roots: Array<string> = [];
const makeRoot = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-workspace-engine-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

const createWorkspaceWorkflow = (engine: WorkflowEngine, root: string) => {
  const request = makeCreateRequest(root);
  return engine.createWorkflow({
    ...request,
    projectSnapshot: {
      ...makeProjectSnapshot(root),
      checks: [
        {
          id: "lint",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          workingDirectory: ".",
          resolvedWorkingDirectory: root,
          timeoutSeconds: 30,
          environment: [],
          artifacts: [],
          failureBehavior: "fail",
        },
      ],
    },
    validationCheckId: "lint",
  });
};

const planEvidence = (root: string, runId: string) => ({
  canonicalSourceRepositoryPath: root,
  gitCommonDirectory: NodePath.join(root, ".git"),
  resolvedBaseReference: "refs/heads/main",
  resolvedBaseCommit: "a".repeat(40),
  baseResolvedAt: "2026-07-17T00:00:00.000Z",
  generatedBranchName: `mkcode/run-${runId}`,
  worktreePath: NodePath.join(root, "factory-worktree"),
  effectiveWorktreeRoot: NodePath.join(root, "worktrees"),
  ownershipClaimPath: NodePath.join(root, "worktrees", ".claims", "workspace.json"),
  ownershipMarkerDigest: "marker-digest",
});

const readyEvidence = (root: string, runId: string) => ({
  canonicalWorktreePath: NodePath.join(root, "factory-worktree"),
  ownershipMarkerPath: NodePath.join(root, ".git", "worktrees", "factory", "mkcode-workspace.json"),
  ownershipMarkerDigest: "marker-digest",
  gitMetadataState: "registered",
  currentObservedHead: "a".repeat(40),
  currentObservedBranch: `mkcode/run-${runId}`,
  dirty: false,
});

const allocate = (engine: WorkflowEngine, root: string) => {
  const created = createWorkspaceWorkflow(engine, root);
  const workspace = engine.readWorkflow(created.workflowRun.id).workspaces[0];
  NodeAssert.ok(workspace);
  const claimed = engine.claimNextJob("workspace-worker");
  NodeAssert.ok(claimed);
  NodeAssert.equal(claimed.job.jobType, "workspace.allocate");
  engine.beginWorkspaceAllocation({
    workspaceId: workspace.id,
    jobId: claimed.job.id,
    leaseOwner: "workspace-worker",
    expectedStageVersion: claimed.stageVersion,
    evidence: planEvidence(root, created.workflowRun.id),
  });
  const detail = engine.confirmWorkspaceAllocation({
    workspaceId: workspace.id,
    jobId: claimed.job.id,
    leaseOwner: "workspace-worker",
    expectedStageVersion: claimed.stageVersion,
    evidence: readyEvidence(root, created.workflowRun.id),
  });
  return { created, workspace: detail.workspaces[0]!, detail };
};

describe("durable workspace lifecycle", () => {
  it("atomically creates an allocation stage, workspace, job, and events", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const created = createWorkspaceWorkflow(engine, root);
    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.stages[0]?.stageKey, "allocating_workspace");
    NodeAssert.equal(detail.jobs[0]?.jobType, "workspace.allocate");
    NodeAssert.equal(detail.workspaces[0]?.status, "pending");
    NodeAssert.equal(detail.workspaces[0]?.sourceRepositoryPath, root);
    NodeAssert.ok(
      engine
        .listEvents({ workflowRunId: created.workflowRun.id })
        .events.some((event) => event.eventType === "workspace.requested"),
    );
    engine.close();
  });

  it("persists the immutable base evidence and schedules validation inside the worktree", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { created, detail } = allocate(engine, root);
    NodeAssert.equal(detail.workflowRun.status, "validating");
    NodeAssert.equal(detail.workspaces[0]?.status, "ready");
    NodeAssert.equal(detail.workspaces[0]?.resolvedBaseCommit, "a".repeat(40));
    NodeAssert.equal(detail.commands[0]?.executionRoot, NodePath.join(root, "factory-worktree"));
    NodeAssert.equal(
      detail.commands[0]?.resolvedWorkingDirectory,
      NodePath.join(root, "factory-worktree"),
    );
    NodeAssert.notEqual(
      detail.commands[0]?.executionRoot,
      created.workflowRun.projectSnapshot.repository.root,
    );
    engine.close();
  });

  it("schedules one cleanup on cancellation and leaves the terminal workflow unchanged", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { created, workspace } = allocate(engine, root);
    engine.cancelWorkflow(created.workflowRun.id, { requestedBy: "operator" });
    engine.cancelWorkflow(created.workflowRun.id, { requestedBy: "operator" });
    NodeAssert.equal(engine.readWorkspace(workspace.id).status, "cleanup_pending");
    NodeAssert.equal(
      engine
        .readWorkflow(created.workflowRun.id)
        .jobs.filter((job) => job.jobType === "workspace.cleanup").length,
      1,
    );
    const claimed = engine.claimNextJob("workspace-worker");
    NodeAssert.ok(claimed);
    NodeAssert.equal(claimed.job.jobType, "workspace.cleanup");
    const removed = engine.completeWorkspaceCleanup({
      workspaceId: workspace.id,
      jobId: claimed.job.id,
      leaseOwner: "workspace-worker",
      expectedStageVersion: claimed.stageVersion,
      removed: true,
    });
    NodeAssert.equal(removed.status, "removed");
    NodeAssert.equal(engine.readWorkflow(created.workflowRun.id).workflowRun.status, "cancelled");
    engine.close();
  });

  it("routes missing or mismatched ready workspace evidence to operator attention", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { created, workspace } = allocate(engine, root);
    const updated = engine.recordWorkspaceInspection(workspace.id, {
      matching: false,
      state: "ownership_mismatch",
      reason: "Ownership marker digest changed.",
      gitMetadataState: "marker_mismatch",
    });
    NodeAssert.equal(updated.status, "ownership_mismatch");
    NodeAssert.equal(
      engine.readWorkflow(created.workflowRun.id).workflowRun.status,
      "operator_attention",
    );
    engine.close();
  });

  it("recovers a matching allocating workspace without launching a duplicate allocation", async () => {
    const root = await makeRoot();
    const stateDirectory = NodePath.join(root, "state");
    let engine = await WorkflowEngine.open({ stateDirectory });
    const created = createWorkspaceWorkflow(engine, root);
    const workspace = engine.readWorkflow(created.workflowRun.id).workspaces[0];
    const claimed = engine.claimNextJob("workspace-worker");
    NodeAssert.ok(workspace);
    NodeAssert.ok(claimed);
    engine.beginWorkspaceAllocation({
      workspaceId: workspace.id,
      jobId: claimed.job.id,
      leaseOwner: "workspace-worker",
      expectedStageVersion: claimed.stageVersion,
      evidence: planEvidence(root, created.workflowRun.id),
    });
    engine.close();
    engine = await WorkflowEngine.open({ stateDirectory });
    const recovered = engine.recoverWorkspaceAllocation(
      workspace.id,
      readyEvidence(root, created.workflowRun.id),
    );
    NodeAssert.equal(recovered.workspaces[0]?.status, "ready");
    NodeAssert.equal(
      recovered.jobs.filter((job) => job.jobType === "workspace.allocate").length,
      1,
    );
    NodeAssert.equal(recovered.commands.length, 1);
    NodeAssert.equal(recovered.commands[0]?.executionRoot, NodePath.join(root, "factory-worktree"));
    engine.close();
  });

  it("does not recover an allocating workspace after its workflow is cancelled", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const created = createWorkspaceWorkflow(engine, root);
    const workspace = engine.readWorkflow(created.workflowRun.id).workspaces[0];
    const claimed = engine.claimNextJob("workspace-worker");
    NodeAssert.ok(workspace);
    NodeAssert.ok(claimed);
    engine.beginWorkspaceAllocation({
      workspaceId: workspace.id,
      jobId: claimed.job.id,
      leaseOwner: "workspace-worker",
      expectedStageVersion: claimed.stageVersion,
      evidence: planEvidence(root, created.workflowRun.id),
    });
    engine.cancelWorkflow(created.workflowRun.id, { requestedBy: "operator" });

    NodeAssert.throws(() =>
      engine.recoverWorkspaceAllocation(workspace.id, readyEvidence(root, created.workflowRun.id)),
    );
    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.workflowRun.status, "cancelled");
    NodeAssert.equal(detail.jobs[0]?.status, "cancelled");
    NodeAssert.equal(detail.stages[0]?.status, "cancelled");
    NodeAssert.equal(detail.commands.length, 0);
    engine.close();
  });

  it("terminalizes active validation records when workspace ownership becomes ambiguous", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { created, workspace } = allocate(engine, root);
    const claimed = engine.claimNextJob("command-worker");
    NodeAssert.ok(claimed);
    NodeAssert.equal(claimed.job.jobType, "command.execute");

    engine.recordWorkspaceInspection(workspace.id, {
      matching: false,
      state: "ownership_mismatch",
      reason: "Ownership marker digest changed.",
      gitMetadataState: "marker_mismatch",
    });

    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.workflowRun.status, "operator_attention");
    NodeAssert.equal(detail.jobs.find((job) => job.id === claimed.job.id)?.status, "failed");
    NodeAssert.equal(detail.commands[0]?.status, "operator_attention");
    NodeAssert.equal(detail.commands[0]?.outcome, "operator_attention");
    NodeAssert.equal(
      detail.stages.find((stage) => stage.stageKey === "validating")?.status,
      "operator_attention",
    );
    NodeAssert.equal(
      detail.attempts.find((attempt) => attempt.stageRunId === claimed.job.stageRunId)?.status,
      "failed",
    );
    engine.close();
  });
});
