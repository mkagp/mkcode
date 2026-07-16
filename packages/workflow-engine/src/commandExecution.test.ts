// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- Tests use explicit durable timestamps.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, it } from "@effect/vitest";

import type { CommandExecutionCompletion } from "@mkcode/factory-contracts";

import { makeCreateRequest, makeProjectSnapshot } from "./testFixtures.ts";
import { WorkflowEngine } from "./workflowEngine.ts";

const roots: Array<string> = [];
const makeRoot = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-command-engine-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

const createCommandWorkflow = (engine: WorkflowEngine, root: string) => {
  const request = makeCreateRequest(root);
  return engine.createWorkflow({
    ...request,
    projectSnapshot: {
      ...makeProjectSnapshot(root),
      checks: [
        {
          id: "lint",
          executable: process.execPath,
          args: ["-e", "console.log('lint passed')"],
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

const claimValidation = (engine: WorkflowEngine, owner = "worker-a") => {
  for (let index = 0; index < 2; index += 1) {
    const claimed = engine.claimNextJob(owner);
    NodeAssert.ok(claimed);
    engine.completeJob(claimed.job.id, owner, { simulated: true }, claimed.stageVersion);
  }
  const claimed = engine.claimNextJob(owner);
  NodeAssert.ok(claimed);
  NodeAssert.equal(claimed.job.jobType, "command.execute");
  return claimed;
};

const completion = (
  outcome: CommandExecutionCompletion["outcome"] = "passed",
  workingDirectory = "/tmp/project",
): CommandExecutionCompletion => ({
  outcome,
  executionId: "execution-1",
  workingDirectory,
  processHostType: "local",
  nativePid: 1234,
  startedAt: "2026-07-16T00:00:00.000Z",
  completedAt: "2026-07-16T00:00:01.000Z",
  timeoutDeadline: "2026-07-16T00:00:30.000Z",
  exitCode: outcome === "passed" ? 0 : 2,
  signal: null,
  timedOut: outcome === "timed_out",
  cancelled: outcome === "cancelled",
  stdout: {
    locationReference: "command-output/execution-1/stdout.log",
    digest: "stdout-digest",
    observedBytes: 12,
    persistedBytes: 12,
    truncated: false,
  },
  stderr: {
    locationReference: "command-output/execution-1/stderr.log",
    digest: "stderr-digest",
    observedBytes: outcome === "passed" ? 0 : 12,
    persistedBytes: outcome === "passed" ? 0 : 12,
    truncated: false,
  },
  resolvedEnvironmentNames: [],
  redactionCount: 1,
});

describe("durable command execution", () => {
  it("schedules a snapshotted check and advances a passing command to human review", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const created = createCommandWorkflow(engine, root);
    const claimed = claimValidation(engine);
    const pending = engine.readWorkflow(created.workflowRun.id).commands[0];
    NodeAssert.ok(pending);
    NodeAssert.equal(pending.commandId, "lint");
    NodeAssert.equal(pending.executable, process.execPath);
    const otherAttempt = engine
      .readWorkflow(created.workflowRun.id)
      .attempts.find((attempt) => attempt.stageRunId !== pending.stageRunId);
    NodeAssert.ok(otherAttempt);

    const startInput = {
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      expectedStageVersion: claimed.stageVersion,
      processHostExecutionId: "execution-1",
      processHostType: "local",
      stdoutArtifactReference: "command-output/execution-1/stdout.log",
      stderrArtifactReference: "command-output/execution-1/stderr.log",
    } as const;
    NodeAssert.throws(() => engine.startCommand({ ...startInput, attemptId: otherAttempt.id }));
    const starting = engine.startCommand({ ...startInput, attemptId: claimed.attempt.id });
    const running = engine.markCommandRunning({
      commandRunId: pending.id,
      expectedVersion: starting.version,
      processHostExecutionId: "execution-1",
      processHostType: "local",
      nativePid: 1234,
      startedAt: "2026-07-16T00:00:00.000Z",
      timeoutDeadline: "2026-07-16T00:00:30.000Z",
      workingDirectory: root,
    });
    NodeAssert.throws(() =>
      engine.completeCommand({
        commandRunId: pending.id,
        jobId: claimed.job.id,
        leaseOwner: "worker-a",
        expectedCommandVersion: running.version,
        expectedStageVersion: claimed.stageVersion,
        result: { ...completion("passed", root), executionId: "different-execution" },
      }),
    );
    const detail = engine.completeCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      expectedCommandVersion: running.version,
      expectedStageVersion: claimed.stageVersion,
      result: completion("passed", root),
    });

    NodeAssert.equal(detail.workflowRun.status, "human_review");
    NodeAssert.equal(detail.commands[0]?.outcome, "passed");
    NodeAssert.equal(detail.approvals[0]?.status, "pending");
    NodeAssert.ok(
      engine
        .listEvents({ workflowRunId: created.workflowRun.id })
        .events.some((event) => event.eventType === "command.completed"),
    );
    engine.close();
  });

  it("records a nonzero result as deterministic workflow failure", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const created = createCommandWorkflow(engine, root);
    const claimed = claimValidation(engine);
    const pending = engine.readWorkflow(created.workflowRun.id).commands[0];
    NodeAssert.ok(pending);
    const starting = engine.startCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      processHostExecutionId: "execution-1",
      processHostType: "local",
      stdoutArtifactReference: "command-output/execution-1/stdout.log",
      stderrArtifactReference: "command-output/execution-1/stderr.log",
    });
    const detail = engine.completeCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      expectedCommandVersion: starting.version,
      expectedStageVersion: claimed.stageVersion,
      result: completion("failed", root),
    });
    NodeAssert.equal(detail.workflowRun.status, "failed");
    NodeAssert.equal(detail.commands[0]?.failureClassification, "nonzero_exit");
    engine.close();
  });

  it("replays identical completion and rejects conflicting completion", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const created = createCommandWorkflow(engine, root);
    const claimed = claimValidation(engine);
    const pending = engine.readWorkflow(created.workflowRun.id).commands[0];
    NodeAssert.ok(pending);
    const starting = engine.startCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      processHostExecutionId: "execution-1",
      processHostType: "local",
      stdoutArtifactReference: "command-output/execution-1/stdout.log",
      stderrArtifactReference: "command-output/execution-1/stderr.log",
    });
    const input = {
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      expectedCommandVersion: starting.version,
      expectedStageVersion: claimed.stageVersion,
      result: completion("passed", root),
    } as const;
    engine.completeCommand(input);
    NodeAssert.equal(engine.completeCommand(input).workflowRun.status, "human_review");
    NodeAssert.throws(() =>
      engine.completeCommand({ ...input, result: completion("failed", root) }),
    );
    engine.close();
  });

  it("replays an identical operator-attention completion", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const created = createCommandWorkflow(engine, root);
    const claimed = claimValidation(engine);
    const pending = engine.readWorkflow(created.workflowRun.id).commands[0];
    NodeAssert.ok(pending);
    const starting = engine.startCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      processHostExecutionId: "execution-1",
      processHostType: "local",
      stdoutArtifactReference: "command-output/execution-1/stdout.log",
      stderrArtifactReference: "command-output/execution-1/stderr.log",
    });
    const input = {
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      expectedCommandVersion: starting.version,
      expectedStageVersion: claimed.stageVersion,
      result: completion("operator_attention", root),
    } as const;
    const completed = engine.completeCommand(input);
    NodeAssert.equal(completed.workflowRun.status, "operator_attention");
    NodeAssert.equal(completed.stages.at(-1)?.status, "operator_attention");
    NodeAssert.equal(engine.completeCommand(input).commands[0]?.status, "operator_attention");
    const events = engine.listEvents({ workflowRunId: created.workflowRun.id }).events;
    NodeAssert.ok(
      events.some((event) => event.eventType === "command.operator_attention_required"),
    );
    NodeAssert.ok(events.some((event) => event.eventType === "workflow.operator_attention"));
    engine.close();
  });

  it("does not let a late process exit overwrite workflow cancellation", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const created = createCommandWorkflow(engine, root);
    const claimed = claimValidation(engine);
    const pending = engine.readWorkflow(created.workflowRun.id).commands[0];
    NodeAssert.ok(pending);
    const starting = engine.startCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      processHostExecutionId: "execution-1",
      processHostType: "local",
      stdoutArtifactReference: "command-output/execution-1/stdout.log",
      stderrArtifactReference: "command-output/execution-1/stderr.log",
    });
    engine.cancelWorkflow(created.workflowRun.id, { requestedBy: "operator" });
    const detail = engine.completeCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      expectedCommandVersion: starting.version,
      expectedStageVersion: claimed.stageVersion,
      result: completion("passed", root),
    });
    NodeAssert.equal(detail.workflowRun.status, "cancelled");
    NodeAssert.equal(detail.commands[0]?.status, "cancelled");
    const cancelledResult = completion("cancelled", root);
    engine.recordCancelledCommandResult(pending.id, cancelledResult);
    NodeAssert.equal(
      engine.recordCancelledCommandResult(pending.id, cancelledResult).status,
      "cancelled",
    );
    NodeAssert.throws(() =>
      engine.recordCancelledCommandResult(pending.id, {
        ...cancelledResult,
        nativePid: 4321,
      }),
    );
    engine.close();
  });

  it("marks an unconfirmed local process as operator attention on restart", async () => {
    const root = await makeRoot();
    const stateDirectory = NodePath.join(root, "state");
    let engine = await WorkflowEngine.open({ stateDirectory });
    const created = createCommandWorkflow(engine, root);
    const claimed = claimValidation(engine);
    const pending = engine.readWorkflow(created.workflowRun.id).commands[0];
    NodeAssert.ok(pending);
    engine.startCommand({
      commandRunId: pending.id,
      jobId: claimed.job.id,
      leaseOwner: "worker-a",
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      processHostExecutionId: "execution-1",
      processHostType: "local",
      stdoutArtifactReference: "command-output/execution-1/stdout.log",
      stderrArtifactReference: "command-output/execution-1/stderr.log",
    });
    engine.close();

    engine = await WorkflowEngine.open({ stateDirectory });
    engine.reconcile();
    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.workflowRun.status, "operator_attention");
    NodeAssert.equal(detail.commands[0]?.status, "operator_attention");
    NodeAssert.equal(
      detail.attempts.find((attempt) => attempt.stageRunId === pending.stageRunId)?.status,
      "failed",
    );
    engine.close();
  });

  it("rejects a validation ID that is absent from the immutable snapshot", async () => {
    const root = await makeRoot();
    const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
    const request = makeCreateRequest(root);
    NodeAssert.throws(
      () => engine.createWorkflow({ ...request, validationCheckId: "missing" }),
      /not declared/u,
    );
    engine.close();
  });
});
