// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- Lease-fence tests control durable wall-clock time.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, it } from "@effect/vitest";

import { makeCreateRequest, makeProjectSnapshot } from "./testFixtures.ts";
import { WorkflowEngine } from "./workflowEngine.ts";

const roots: Array<string> = [];
const makeRoot = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-agent-engine-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

const createBuilderWorkflow = (engine: WorkflowEngine, root: string) => {
  const request = makeCreateRequest(root);
  return engine.createWorkflow({
    ...request,
    projectSnapshot: {
      ...makeProjectSnapshot(root),
      checks: [
        {
          id: "verify",
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
    validationCheckId: "verify",
    builder: {
      objective: "Create the bounded fixture file.",
      acceptanceCriteria: ["src/result.txt contains done"],
      allowedPaths: ["src/**"],
      forbiddenPaths: ["verify.mjs"],
      runtime: { kind: "codex", maximumRuntimeSeconds: 60 },
    },
  });
};

const allocate = (engine: WorkflowEngine, root: string) => {
  const created = createBuilderWorkflow(engine, root);
  const allocation = engine.claimNextJob("worker");
  NodeAssert.ok(allocation);
  const workspace = engine.readWorkflow(created.workflowRun.id).workspaces[0]!;
  const worktree = NodePath.join(root, "worktree");
  engine.beginWorkspaceAllocation({
    workspaceId: workspace.id,
    jobId: allocation.job.id,
    leaseOwner: "worker",
    expectedStageVersion: allocation.stageVersion,
    evidence: {
      canonicalSourceRepositoryPath: root,
      gitCommonDirectory: NodePath.join(root, ".git"),
      resolvedBaseCommit: "a".repeat(40),
      baseResolvedAt: "2026-07-17T00:00:00.000Z",
      generatedBranchName: `mkcode/run-${created.workflowRun.id}`,
      worktreePath: worktree,
      effectiveWorktreeRoot: NodePath.join(root, "worktrees"),
      ownershipClaimPath: NodePath.join(root, "claim.json"),
      ownershipMarkerDigest: "marker",
    },
  });
  const detail = engine.confirmWorkspaceAllocation({
    workspaceId: workspace.id,
    jobId: allocation.job.id,
    leaseOwner: "worker",
    expectedStageVersion: allocation.stageVersion,
    evidence: {
      canonicalWorktreePath: worktree,
      ownershipMarkerPath: NodePath.join(root, ".git", "marker.json"),
      ownershipMarkerDigest: "marker",
      gitMetadataState: "registered",
      currentObservedHead: "a".repeat(40),
      currentObservedBranch: `mkcode/run-${created.workflowRun.id}`,
      dirty: false,
    },
  });
  return { created, detail };
};

const completion = (agentRunId: string, violations: ReadonlyArray<string> = []) => ({
  outcome: "completed" as const,
  resultEnvelope: {
    version: 1,
    agentRunId,
    runtimeSessionReference: "session",
    summary: "done",
  },
  completionReason: "turn_completed",
  stdout: {
    locationReference: "stdout",
    digest: "out",
    observedBytes: 1,
    persistedBytes: 1,
    truncated: false,
  },
  stderr: {
    locationReference: "stderr",
    digest: "err",
    observedBytes: 0,
    persistedBytes: 0,
    truncated: false,
  },
  postGitEvidence: { changedPaths: ["src/result.txt"] },
  policyViolations: violations,
});

describe("durable single-builder AgentRun", () => {
  it("rejects malformed builder constraints before persistence", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const request = makeCreateRequest(root);
    const base = {
      ...request,
      projectSnapshot: {
        ...makeProjectSnapshot(root),
        checks: [
          {
            id: "verify",
            executable: process.execPath,
            args: ["-e", "process.exit(0)"],
            workingDirectory: ".",
            resolvedWorkingDirectory: root,
            timeoutSeconds: 30,
            environment: [],
            artifacts: [],
            failureBehavior: "fail" as const,
          },
        ],
      },
      validationCheckId: "verify",
    };
    NodeAssert.throws(
      () =>
        engine.createWorkflow({
          ...base,
          builder: {
            objective: "build",
            acceptanceCriteria: [" "],
            allowedPaths: ["src/**"],
            runtime: { kind: "codex", maximumRuntimeSeconds: 60 },
          },
        }),
      /single-builder request is invalid/u,
    );
    NodeAssert.throws(
      () =>
        engine.createWorkflow({
          ...base,
          builder: {
            objective: "build",
            acceptanceCriteria: ["done"],
            allowedPaths: ["src/**"],
            runtime: { kind: "codex", model: " ", maximumRuntimeSeconds: 60 },
          },
        }),
      /single-builder request is invalid/u,
    );
    engine.close();
  });

  it("schedules exactly one builder, persists completion, then schedules deterministic validation", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { created, detail } = allocate(engine, root);
    NodeAssert.equal(detail.workflowRun.status, "building");
    NodeAssert.equal(detail.agentRuns.length, 1);
    NodeAssert.equal(detail.commands.length, 0);
    const scheduledAgent = detail.agentRuns[0];
    NodeAssert.ok(scheduledAgent);
    NodeAssert.deepEqual((scheduledAgent.taskEnvelope as { readonly scope?: unknown }).scope, {
      allowedPaths: ["src/**"],
      forbiddenPaths: [".git/**", ".mkcode/**", "verify.mjs"],
    });
    const claimed = engine.claimNextJob("worker");
    NodeAssert.ok(claimed);
    NodeAssert.equal(claimed.job.jobType, "agent.execute");
    const previousAttempt = detail.attempts.find((attempt) => attempt.id !== claimed.attempt.id);
    NodeAssert.ok(previousAttempt);
    NodeAssert.throws(
      () =>
        engine.startAgent({
          agentRunId: detail.agentRuns[0]!.id,
          jobId: claimed.job.id,
          leaseOwner: "worker",
          attemptId: previousAttempt.id,
          expectedStageVersion: claimed.stageVersion,
          evidence: {
            processHostExecutionId: "wrong-attempt",
            stdoutArtifactReference: "stdout",
            stderrArtifactReference: "stderr",
            preGitEvidence: {},
          },
        }),
      /lost its workflow or lease fence/u,
    );
    const agent = engine.startAgent({
      agentRunId: detail.agentRuns[0]!.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      evidence: {
        processHostExecutionId: "exec",
        stdoutArtifactReference: "stdout",
        stderrArtifactReference: "stderr",
        preGitEvidence: { head: "a".repeat(40) },
      },
    });
    NodeAssert.throws(
      () =>
        engine.markAgentRunning({
          agentRunId: agent.id,
          jobId: claimed.job.id,
          leaseOwner: "worker",
          expectedStageVersion: claimed.stageVersion,
          expectedVersion: agent.version,
          evidence: {
            runtimeSessionId: "session",
            runtimeThreadId: "session",
            processHostExecutionId: "different-execution",
            startedAt: "2026-07-17T00:00:01.000Z",
          },
        }),
      /lost its fence/u,
    );
    const running = engine.markAgentRunning({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      expectedStageVersion: claimed.stageVersion,
      expectedVersion: agent.version,
      evidence: {
        runtimeSessionId: "session",
        runtimeThreadId: "session",
        processHostExecutionId: "exec",
        nativePid: 123,
        startedAt: "2026-07-17T00:00:01.000Z",
      },
    });
    NodeAssert.equal(running.status, "running");
    NodeAssert.throws(
      () =>
        engine.completeAgent({
          agentRunId: agent.id,
          jobId: claimed.job.id,
          leaseOwner: "worker",
          expectedStageVersion: claimed.stageVersion,
          evidence: {
            ...completion(agent.id),
            stdout: { ...completion(agent.id).stdout, locationReference: "other" },
          },
        }),
      /lost its durable fence/u,
    );
    const completed = engine.completeAgent({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      expectedStageVersion: claimed.stageVersion,
      evidence: completion(agent.id),
    });
    NodeAssert.equal(completed.agentRuns[0]?.status, "completed");
    NodeAssert.equal(completed.workflowRun.status, "validating");
    NodeAssert.equal(completed.commands[0]?.executionRoot, NodePath.join(root, "worktree"));
    NodeAssert.ok(
      engine
        .listEvents({ workflowRunId: created.workflowRun.id })
        .events.some((event) => event.eventType === "agent.completed"),
    );
    engine.close();
  });

  it("rejects launch confirmation after the agent job lease expires", async () => {
    const root = await makeRoot();
    let now = Date.parse("2026-07-17T00:00:00.000Z");
    const engine = await WorkflowEngine.open({
      stateDirectory: NodePath.join(root, "state"),
      clock: () => new Date(now),
    });
    const { detail } = allocate(engine, root);
    const claimed = engine.claimNextJob("worker", 100)!;
    const agent = engine.startAgent({
      agentRunId: detail.agentRuns[0]!.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      evidence: {
        processHostExecutionId: "exec",
        stdoutArtifactReference: "stdout",
        stderrArtifactReference: "stderr",
        preGitEvidence: {},
      },
    });
    now += 101;
    NodeAssert.throws(
      () =>
        engine.markAgentRunning({
          agentRunId: agent.id,
          jobId: claimed.job.id,
          leaseOwner: "worker",
          expectedStageVersion: claimed.stageVersion,
          expectedVersion: agent.version,
          evidence: {
            runtimeSessionId: "session",
            runtimeThreadId: "session",
            processHostExecutionId: "exec",
            startedAt: "2026-07-17T00:00:00.050Z",
          },
        }),
      /lost its fence/u,
    );
    engine.close();
  });

  it("preserves a blocked AgentRun as a durable terminal result", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { detail } = allocate(engine, root);
    const claimed = engine.claimNextJob("worker")!;
    let agent = engine.startAgent({
      agentRunId: detail.agentRuns[0]!.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      evidence: {
        processHostExecutionId: "exec",
        stdoutArtifactReference: "stdout",
        stderrArtifactReference: "stderr",
        preGitEvidence: {},
      },
    });
    agent = engine.markAgentRunning({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      expectedStageVersion: claimed.stageVersion,
      expectedVersion: agent.version,
      evidence: {
        runtimeSessionId: "session",
        runtimeThreadId: "session",
        processHostExecutionId: "exec",
        startedAt: "2026-07-17T00:00:01.000Z",
      },
    });
    const blocked = engine.completeAgent({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      expectedStageVersion: claimed.stageVersion,
      evidence: { ...completion(agent.id), outcome: "blocked" as const },
    });
    NodeAssert.equal(blocked.agentRuns[0]?.status, "blocked");
    NodeAssert.throws(
      () => engine.markAgentOperatorAttention(agent.id, "late reconciliation"),
      /terminal agent run/u,
    );
    engine.close();
  });

  it("routes policy violations to operator attention and retains the worktree", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { detail } = allocate(engine, root);
    const claimed = engine.claimNextJob("worker")!;
    let agent = engine.startAgent({
      agentRunId: detail.agentRuns[0]!.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      evidence: {
        processHostExecutionId: "exec",
        stdoutArtifactReference: "stdout",
        stderrArtifactReference: "stderr",
        preGitEvidence: {},
      },
    });
    agent = engine.markAgentRunning({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      expectedStageVersion: claimed.stageVersion,
      expectedVersion: agent.version,
      evidence: {
        runtimeSessionId: "session",
        runtimeThreadId: "session",
        processHostExecutionId: "exec",
        startedAt: "2026-07-17T00:00:01.000Z",
      },
    });
    const result = engine.completeAgent({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      expectedStageVersion: claimed.stageVersion,
      evidence: completion(agent.id, ["forbidden_path:.mkcode/project.yaml"]),
    });
    NodeAssert.equal(result.workflowRun.status, "operator_attention");
    NodeAssert.equal(result.agentRuns[0]?.status, "operator_attention");
    NodeAssert.equal(result.workspaces[0]?.status, "retained");
    NodeAssert.equal(result.commands.length, 0);
    engine.close();
  });

  it("prevents workspace cleanup from racing a cancelling builder", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const { created, detail } = allocate(engine, root);
    const claimed = engine.claimNextJob("worker")!;
    let agent = engine.startAgent({
      agentRunId: detail.agentRuns[0]!.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      evidence: {
        processHostExecutionId: "exec",
        stdoutArtifactReference: "stdout",
        stderrArtifactReference: "stderr",
        preGitEvidence: {},
      },
    });
    agent = engine.markAgentRunning({
      agentRunId: agent.id,
      jobId: claimed.job.id,
      leaseOwner: "worker",
      expectedStageVersion: claimed.stageVersion,
      expectedVersion: agent.version,
      evidence: {
        runtimeSessionId: "session",
        runtimeThreadId: "session",
        processHostExecutionId: "exec",
        startedAt: "2026-07-17T00:00:01.000Z",
      },
    });
    const cancelled = engine.cancelWorkflow(created.workflowRun.id, { requestedBy: "operator" });
    NodeAssert.equal(cancelled.agentRuns[0]?.status, "cancel_requested");
    NodeAssert.throws(
      () =>
        engine.requestWorkspaceCleanup(cancelled.workspaces[0]!.id, {
          requestedBy: "operator",
          idempotencyKey: "cleanup-while-agent-cancels",
        }),
      /cannot race an active agent/u,
    );
    engine.close();
  });
});
