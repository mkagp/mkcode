// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- Tests inject deterministic wall-clock values.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeSqlite from "node:sqlite";

import { describe, it } from "@effect/vitest";

import { WorkflowEngineError } from "./errors.ts";
import {
  FACTORY_SCHEMA_VERSION,
  WorkflowEngine,
  type WorkflowEngineOptions,
} from "./workflowEngine.ts";
import { makeCreateRequest } from "./testFixtures.ts";

const permissionBits = (mode: number): number => mode & 0o777;
const NodeFS = NodeFSP;

const makeRoot = async (): Promise<string> =>
  NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-workflow-engine-"));

const openEngine = async (
  root: string,
  overrides: Partial<WorkflowEngineOptions> = {},
): Promise<WorkflowEngine> =>
  WorkflowEngine.open({
    stateDirectory: NodePath.join(root, "factory-state"),
    ...overrides,
  });

const advanceToHumanReview = (engine: WorkflowEngine, owner = "worker-a") => {
  for (let index = 0; index < 3; index += 1) {
    const claimed = engine.claimNextJob(owner);
    NodeAssert.ok(claimed);
    engine.completeJob(claimed.job.id, owner, { simulated: true }, claimed.stageVersion);
  }
};

describe("WorkflowEngine persistence", () => {
  it("rejects a blank state directory without touching the current working directory", async () => {
    const modeBefore = permissionBits((await NodeFS.stat(NodeProcess.cwd())).mode);
    await NodeAssert.rejects(() => WorkflowEngine.open({ stateDirectory: " " }));
    NodeAssert.equal(permissionBits((await NodeFS.stat(NodeProcess.cwd())).mode), modeBefore);
  });

  it("creates a private standalone database and reopens it without rerunning migrations", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const databasePath = engine.databasePath;
      const stateDirectory = engine.stateDirectory;
      engine.close();

      NodeAssert.equal(permissionBits((await NodeFS.stat(stateDirectory)).mode), 0o700);
      NodeAssert.equal(permissionBits((await NodeFS.stat(databasePath)).mode), 0o600);

      await NodeFS.chmod(databasePath, 0o666);
      const reopened = await openEngine(root);
      NodeAssert.equal(reopened.schemaVersion, FACTORY_SCHEMA_VERSION);
      NodeAssert.deepEqual(reopened.listWorkflows(), []);
      reopened.close();
      NodeAssert.equal(permissionBits((await NodeFS.stat(databasePath)).mode), 0o600);
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a database schema newer than the worker supports", async () => {
    const root = await makeRoot();
    try {
      const stateDirectory = NodePath.join(root, "factory-state");
      await NodeFS.mkdir(stateDirectory, { recursive: true });
      const databasePath = NodePath.join(stateDirectory, "factory.sqlite");
      const database = new NodeSqlite.DatabaseSync(databasePath);
      database.exec("PRAGMA user_version = 999;");
      database.close();

      await NodeAssert.rejects(
        () => openEngine(root),
        (cause: unknown) =>
          cause instanceof WorkflowEngineError && cause.code === "unsupported_schema",
      );
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlink as factory state instead of chmodding its target", async () => {
    const root = await makeRoot();
    const target = NodePath.join(root, "target");
    const stateDirectory = NodePath.join(root, "factory-state");
    try {
      await NodeFS.mkdir(target, { mode: 0o755 });
      await NodeFS.symlink(target, stateDirectory);
      await NodeAssert.rejects(() => WorkflowEngine.open({ stateDirectory }));
      NodeAssert.equal(permissionBits((await NodeFS.stat(target)).mode), 0o755);
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a factory database path outside its owned state directory", async () => {
    const root = await makeRoot();
    try {
      await NodeAssert.rejects(() =>
        WorkflowEngine.open({
          stateDirectory: NodePath.join(root, "factory-state"),
          databasePath: NodePath.join(root, "outside.sqlite"),
        }),
      );
      await NodeAssert.rejects(() => NodeFS.stat(NodePath.join(root, "outside.sqlite")));
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked factory database without modifying its target", async () => {
    const root = await makeRoot();
    const stateDirectory = NodePath.join(root, "factory-state");
    const externalDatabasePath = NodePath.join(root, "external.sqlite");
    try {
      await NodeFS.mkdir(stateDirectory, { mode: 0o700 });
      const externalDatabase = new NodeSqlite.DatabaseSync(externalDatabasePath);
      externalDatabase.close();
      await NodeFS.chmod(externalDatabasePath, 0o644);
      await NodeFS.symlink(externalDatabasePath, NodePath.join(stateDirectory, "factory.sqlite"));

      await NodeAssert.rejects(() => WorkflowEngine.open({ stateDirectory }));
      NodeAssert.equal(permissionBits((await NodeFS.stat(externalDatabasePath)).mode), 0o644);
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked database parent without modifying its target", async () => {
    const root = await makeRoot();
    const stateDirectory = NodePath.join(root, "factory-state");
    const externalDirectory = NodePath.join(root, "external");
    try {
      await NodeFS.mkdir(stateDirectory, { mode: 0o700 });
      await NodeFS.mkdir(externalDirectory, { mode: 0o755 });
      await NodeFS.symlink(externalDirectory, NodePath.join(stateDirectory, "nested"));
      await NodeAssert.rejects(() =>
        WorkflowEngine.open({
          stateDirectory,
          databasePath: NodePath.join(stateDirectory, "nested", "factory.sqlite"),
        }),
      );
      NodeAssert.equal(permissionBits((await NodeFS.stat(externalDirectory)).mode), 0o755);
      await NodeAssert.rejects(() =>
        NodeFS.stat(NodePath.join(externalDirectory, "factory.sqlite")),
      );
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });
});

describe("WorkflowEngine transactions and idempotency", () => {
  it("atomically creates the work item, run, first stage, first job, and initial events", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const created = engine.createWorkflow(makeCreateRequest(root));
      const detail = engine.readWorkflow(created.workflowRun.id);

      NodeAssert.equal(created.replayed, false);
      NodeAssert.equal(detail.workflowRun.status, "queued");
      NodeAssert.equal(detail.stages.length, 1);
      NodeAssert.equal(detail.stages[0]?.stageKey, "planning");
      NodeAssert.equal(detail.jobs.length, 1);
      NodeAssert.equal(detail.jobs[0]?.status, "pending");
      NodeAssert.deepEqual(
        engine
          .listEvents({ workflowRunId: created.workflowRun.id })
          .events.map((event) => event.eventType),
        ["workflow.created", "stage.queued", "job.pending"],
      );
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back every initial record when a later insert in creation fails", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root, { idGenerator: () => "forced-duplicate-id" });
      NodeAssert.throws(() => engine.createWorkflow(makeCreateRequest(root)));
      NodeAssert.deepEqual(engine.listWorkflows(), []);
      NodeAssert.deepEqual(engine.listEvents({}).events, []);
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("returns the original result for identical idempotent creation and conflicts on changed input", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const request = makeCreateRequest(root);
      const first = engine.createWorkflow(request);
      const repeated = engine.createWorkflow(request);

      NodeAssert.equal(repeated.replayed, true);
      NodeAssert.equal(repeated.workflowRun.id, first.workflowRun.id);
      NodeAssert.equal(engine.listWorkflows().length, 1);
      NodeAssert.throws(
        () =>
          engine.createWorkflow({
            ...request,
            workItem: { ...request.workItem, title: "Different request" },
          }),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("can create multiple runs that reference the same unchanged WorkItem", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const workItemId = "shared-work-item";
      const firstRequest = makeCreateRequest(root, "first-shared-run");
      const first = engine.createWorkflow({
        ...firstRequest,
        workItem: { ...firstRequest.workItem, id: workItemId },
      });
      const secondRequest = makeCreateRequest(root, "second-shared-run");
      const second = engine.createWorkflow({
        ...secondRequest,
        workItem: { ...secondRequest.workItem, id: workItemId },
      });
      NodeAssert.notEqual(first.workflowRun.id, second.workflowRun.id);
      NodeAssert.equal(first.workItem.id, workItemId);
      NodeAssert.equal(second.workItem.id, workItemId);
      NodeAssert.equal(engine.listWorkflows().length, 2);
      const firstPage = engine.listWorkflowPage({ limit: 1 });
      const firstPageCursor = firstPage.nextCursor;
      NodeAssert.ok(firstPageCursor);
      const secondPage = engine.listWorkflowPage({
        cursor: firstPageCursor,
        limit: 1,
      });
      NodeAssert.equal(firstPage.runs.length, 1);
      NodeAssert.equal(firstPage.hasMore, true);
      NodeAssert.equal(secondPage.runs.length, 1);
      NodeAssert.equal(secondPage.hasMore, false);
      NodeAssert.equal(secondPage.nextCursor, undefined);
      NodeAssert.notEqual(firstPage.runs[0]?.id, secondPage.runs[0]?.id);
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps workflow pagination stable when a newer run is inserted between pages", async () => {
    const root = await makeRoot();
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    let engine: WorkflowEngine | undefined;
    try {
      engine = await openEngine(root, { clock: () => new Date(now) });
      const oldest = engine.createWorkflow(makeCreateRequest(root, "oldest-run"));
      now += 1_000;
      const middle = engine.createWorkflow(makeCreateRequest(root, "middle-run"));
      const firstPage = engine.listWorkflowPage({ limit: 1 });
      NodeAssert.equal(firstPage.runs[0]?.id, middle.workflowRun.id);
      const firstPageCursor = firstPage.nextCursor;
      NodeAssert.ok(firstPageCursor);

      now += 1_000;
      engine.createWorkflow(makeCreateRequest(root, "newest-run"));
      const secondPage = engine.listWorkflowPage({
        cursor: firstPageCursor,
        limit: 1,
      });
      NodeAssert.equal(secondPage.runs[0]?.id, oldest.workflowRun.id);
    } finally {
      try {
        engine?.close();
      } finally {
        await NodeFS.rm(root, { recursive: true, force: true });
      }
    }
  });

  it("rejects invalid resolved project snapshots before opening a transaction", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const request = makeCreateRequest(root);
      NodeAssert.throws(
        () =>
          engine.createWorkflow({
            ...request,
            projectSnapshot: {
              ...request.projectSnapshot,
              project: { ...request.projectSnapshot.project, id: "other-project" },
            },
          }),
        (cause: unknown) =>
          cause instanceof WorkflowEngineError && cause.code === "invalid_request",
      );
      NodeAssert.throws(
        () =>
          engine.createWorkflow({
            ...request,
            workflowType: "not-allowed",
          }),
        (cause: unknown) =>
          cause instanceof WorkflowEngineError && cause.code === "invalid_request",
      );
      NodeAssert.deepEqual(engine.listWorkflows(), []);
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });
});

describe("WorkflowEngine claims, leases, and retries", () => {
  it("claims once, renews only for the owner, and rejects wrong-owner completion", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      engine.createWorkflow(makeCreateRequest(root));
      const claimed = engine.claimNextJob("worker-a", 60_000);
      NodeAssert.ok(claimed);
      const competingEngine = await openEngine(root);
      NodeAssert.equal(competingEngine.claimNextJob("worker-b", 60_000), undefined);
      NodeAssert.throws(
        () => competingEngine.renewLease(claimed.job.id, "worker-b", 120_000),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      competingEngine.close();
      const renewed = engine.renewLease(claimed.job.id, "worker-a", 120_000);
      NodeAssert.equal(renewed.leaseOwner, "worker-a");
      NodeAssert.throws(
        () => engine.completeJob(claimed.job.id, "worker-a", {}, claimed.stageVersion - 1),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "stale_version",
      );
      NodeAssert.throws(
        () => engine.completeJob(claimed.job.id, "worker-b", {}, claimed.stageVersion),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      for (const invalidLease of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        NodeAssert.throws(
          () => engine.claimNextJob("worker-a", invalidLease),
          (cause: unknown) =>
            cause instanceof WorkflowEngineError && cause.code === "invalid_request",
        );
        NodeAssert.throws(
          () => engine.renewLease(claimed.job.id, "worker-a", invalidLease),
          (cause: unknown) =>
            cause instanceof WorkflowEngineError && cause.code === "invalid_request",
        );
      }
      NodeAssert.throws(
        () => engine.claimNextJob("worker-a", Number.MAX_SAFE_INTEGER),
        (cause: unknown) =>
          cause instanceof WorkflowEngineError && cause.code === "invalid_request",
      );
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("reclaims an expired lease after restart and records the expired attempt", async () => {
    const root = await makeRoot();
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const clockInput = { clock: () => new Date(clock) };
    try {
      const engine = await openEngine(root, clockInput);
      engine.createWorkflow(makeCreateRequest(root));
      const first = engine.claimNextJob("dead-worker", 1_000);
      NodeAssert.ok(first);
      engine.close();

      clock += 2_000;
      const restarted = await openEngine(root, clockInput);
      const reconciliation = restarted.reconcile();
      NodeAssert.equal(reconciliation.reclaimedJobs, 1);
      NodeAssert.equal(restarted.readWorkflow(first.job.workflowRunId).stages[0]?.status, "queued");
      const reclaimed = restarted.claimNextJob("replacement-worker", 1_000);
      NodeAssert.ok(reclaimed);
      NodeAssert.equal(reclaimed.attempt.attemptNumber, 2);
      NodeAssert.equal(
        restarted.readWorkflow(reclaimed.job.workflowRunId).attempts[0]?.status,
        "expired",
      );
      restarted.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects stale completion and failure, then expires the prior attempt on direct reclaim", async () => {
    const root = await makeRoot();
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const engine = await openEngine(root, { clock: () => new Date(clock) });
      const created = engine.createWorkflow(makeCreateRequest(root));
      const claimed = engine.claimNextJob("stale-worker", 1_000);
      NodeAssert.ok(claimed);

      clock += 1_000;
      NodeAssert.throws(
        () => engine.completeJob(claimed.job.id, "stale-worker", {}, claimed.stageVersion),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      NodeAssert.throws(
        () =>
          engine.failJob({
            jobId: claimed.job.id,
            leaseOwner: "stale-worker",
            retryable: true,
            failureSummary: "must not commit",
            expectedStageVersion: claimed.stageVersion,
          }),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );

      const reclaimed = engine.claimNextJob("stale-worker", 1_000);
      NodeAssert.ok(reclaimed);
      NodeAssert.throws(
        () => engine.completeJob(claimed.job.id, "stale-worker", {}, claimed.stageVersion),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "stale_version",
      );
      const detail = engine.readWorkflow(created.workflowRun.id);
      NodeAssert.equal(detail.attempts[0]?.status, "expired");
      NodeAssert.equal(detail.attempts[1]?.status, "running");
      NodeAssert.equal(
        engine
          .listEvents({ workflowRunId: created.workflowRun.id })
          .events.filter((event) => event.eventType === "job.lease_expired").length,
        1,
      );
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("delays retryable failure and marks exhaustion terminal", async () => {
    const root = await makeRoot();
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    try {
      const engine = await openEngine(root, { clock: () => new Date(clock) });
      const created = engine.createWorkflow(makeCreateRequest(root));
      const first = engine.claimNextJob("worker-a");
      NodeAssert.ok(first);
      for (const invalidFailure of [
        { maximumAttempts: 0 },
        { maximumAttempts: 1.5 },
        { retryDelayMilliseconds: -1 },
        { retryDelayMilliseconds: Number.POSITIVE_INFINITY },
      ]) {
        NodeAssert.throws(
          () =>
            engine.failJob({
              jobId: first.job.id,
              leaseOwner: "worker-a",
              retryable: true,
              failureSummary: "invalid retry controls",
              expectedStageVersion: first.stageVersion,
              ...invalidFailure,
            }),
          (cause: unknown) =>
            cause instanceof WorkflowEngineError && cause.code === "invalid_request",
        );
      }
      engine.failJob({
        jobId: first.job.id,
        leaseOwner: "worker-a",
        retryable: true,
        failureSummary: "controlled retry",
        retryDelayMilliseconds: 5_000,
        maximumAttempts: 2,
        expectedStageVersion: first.stageVersion,
      });
      NodeAssert.equal(engine.claimNextJob("worker-a"), undefined);
      clock += 5_000;
      const second = engine.claimNextJob("worker-a");
      NodeAssert.ok(second);
      engine.failJob({
        jobId: second.job.id,
        leaseOwner: "worker-a",
        retryable: true,
        failureSummary: "controlled exhaustion",
        maximumAttempts: 2,
        expectedStageVersion: second.stageVersion,
      });
      NodeAssert.equal(engine.readWorkflow(created.workflowRun.id).workflowRun.status, "failed");
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });
});

describe("WorkflowEngine approvals, cancellation, and replay", () => {
  it("waits durably at human review, survives restart, and resolves decisions idempotently", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const created = engine.createWorkflow(makeCreateRequest(root));
      advanceToHumanReview(engine);
      const waiting = engine.readWorkflow(created.workflowRun.id);
      NodeAssert.equal(waiting.workflowRun.status, "human_review");
      NodeAssert.equal(waiting.approvals[0]?.status, "pending");
      const approvalId = waiting.approvals[0]?.id;
      NodeAssert.ok(approvalId);
      engine.close();

      const restarted = await openEngine(root);
      NodeAssert.equal(
        restarted.readWorkflow(created.workflowRun.id).workflowRun.status,
        "human_review",
      );
      const approved = restarted.resolveApproval(approvalId, {
        decision: "approved",
        resolvedBy: "reviewer",
      });
      NodeAssert.equal(approved.workflowRun.status, "completed");
      NodeAssert.equal(
        restarted.resolveApproval(approvalId, {
          decision: "approved",
          resolvedBy: "reviewer",
        }).workflowRun.status,
        "completed",
      );
      NodeAssert.throws(
        () =>
          restarted.resolveApproval(approvalId, {
            decision: "rejected",
            resolvedBy: "reviewer",
          }),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      restarted.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("treats duplicate job completion as idempotent and does not create duplicate stages", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const created = engine.createWorkflow(makeCreateRequest(root));
      const claimed = engine.claimNextJob("worker-a");
      NodeAssert.ok(claimed);
      const first = engine.completeJob(
        claimed.job.id,
        "worker-a",
        { simulated: true },
        claimed.stageVersion,
      );
      const repeated = engine.completeJob(
        claimed.job.id,
        "worker-a",
        { simulated: true },
        claimed.stageVersion,
      );
      NodeAssert.equal(first.stages.length, 2);
      NodeAssert.equal(repeated.stages.length, 2);
      NodeAssert.equal(engine.readWorkflow(created.workflowRun.id).jobs.length, 2);
      NodeAssert.throws(
        () =>
          engine.completeJob(
            claimed.job.id,
            "worker-a",
            { simulated: false },
            claimed.stageVersion,
          ),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      NodeAssert.throws(
        () =>
          engine.completeJob(
            claimed.job.id,
            "different-worker",
            { simulated: true },
            claimed.stageVersion,
          ),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects human review as a deterministic terminal outcome", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const created = engine.createWorkflow(makeCreateRequest(root));
      advanceToHumanReview(engine);
      const approval = engine.readWorkflow(created.workflowRun.id).approvals[0];
      NodeAssert.ok(approval);
      const rejected = engine.resolveApproval(approval.id, {
        decision: "rejected",
        resolvedBy: "reviewer",
        rationale: "Acceptance criteria not met.",
      });
      NodeAssert.equal(rejected.workflowRun.status, "rejected");
      NodeAssert.equal(rejected.workflowRun.terminalOutcome, "rejected");
      engine.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("cancels queued and claimed work durably without scheduling another stage", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const queued = engine.createWorkflow(makeCreateRequest(root, "queued-cancel"));
      const firstCancellation = engine.cancelWorkflow(queued.workflowRun.id, {
        requestedBy: "operator",
      });
      const repeated = engine.cancelWorkflow(queued.workflowRun.id, {
        requestedBy: "operator",
      });
      NodeAssert.equal(firstCancellation.workflowRun.status, "cancelled");
      NodeAssert.equal(repeated.workflowRun.version, firstCancellation.workflowRun.version);
      NodeAssert.equal(firstCancellation.jobs[0]?.status, "cancelled");

      const active = engine.createWorkflow(makeCreateRequest(root, "active-cancel"));
      const claimed = engine.claimNextJob("worker-a");
      NodeAssert.ok(claimed);
      const cancelled = engine.cancelWorkflow(active.workflowRun.id, {
        requestedBy: "operator",
      });
      NodeAssert.equal(cancelled.workflowRun.status, "cancelled");
      NodeAssert.equal(cancelled.stages.length, 1);
      engine.close();

      const restarted = await openEngine(root);
      NodeAssert.equal(
        restarted.readWorkflow(queued.workflowRun.id).workflowRun.status,
        "cancelled",
      );
      const restartedActive = restarted.readWorkflow(active.workflowRun.id);
      NodeAssert.equal(restartedActive.workflowRun.status, "cancelled");
      NodeAssert.equal(restartedActive.workflowRun.version, cancelled.workflowRun.version);
      NodeAssert.equal(restartedActive.jobs[0]?.status, "cancelled");
      NodeAssert.throws(
        () =>
          restarted.completeJob(
            claimed.job.id,
            "worker-a",
            { simulated: true },
            claimed.stageVersion,
          ),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "conflict",
      );
      NodeAssert.equal(restarted.claimNextJob("worker-a"), undefined);
      restarted.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("paginates ordered events, resumes by cursor, validates cursors, and replays after restart", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const created = engine.createWorkflow(makeCreateRequest(root));
      const first = engine.listEvents({ limit: 2 });
      NodeAssert.equal(first.events.length, 2);
      const second = engine.listEvents({ afterCursor: first.nextCursor, limit: 2 });
      NodeAssert.equal(second.events.length, 1);
      NodeAssert.ok((second.events[0]?.cursor ?? 0) > first.nextCursor);
      NodeAssert.deepEqual(engine.listEvents({ afterCursor: second.nextCursor }).events, []);
      NodeAssert.throws(
        () => engine.listEvents({ afterCursor: -1 }),
        (cause: unknown) => cause instanceof WorkflowEngineError && cause.code === "invalid_cursor",
      );
      engine.close();

      const restarted = await openEngine(root);
      NodeAssert.equal(
        restarted.listEvents({ workflowRunId: created.workflowRun.id }).events.length,
        3,
      );
      restarted.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a queued stage missing its job and a review stage missing its approval idempotently", async () => {
    const root = await makeRoot();
    try {
      const engine = await openEngine(root);
      const queued = engine.createWorkflow(makeCreateRequest(root, "recover-job"));
      const databasePath = engine.databasePath;
      engine.close();

      let database = new NodeSqlite.DatabaseSync(databasePath);
      database
        .prepare("DELETE FROM job_intents WHERE workflow_run_id = ?")
        .run(queued.workflowRun.id);
      database.close();

      let restarted = await openEngine(root);
      NodeAssert.equal(restarted.reconcile().repairedJobs, 1);
      NodeAssert.equal(restarted.reconcile().repairedJobs, 0);
      NodeAssert.equal(restarted.readWorkflow(queued.workflowRun.id).jobs.length, 1);
      restarted.cancelWorkflow(queued.workflowRun.id, { requestedBy: "test" });

      const review = restarted.createWorkflow(makeCreateRequest(root, "recover-approval"));
      advanceToHumanReview(restarted);
      const approvalId = restarted.readWorkflow(review.workflowRun.id).approvals[0]?.id;
      NodeAssert.ok(approvalId);
      restarted.close();

      database = new NodeSqlite.DatabaseSync(databasePath);
      database.prepare("DELETE FROM approvals WHERE id = ?").run(approvalId);
      database.close();

      restarted = await openEngine(root);
      NodeAssert.equal(restarted.reconcile().repairedApprovals, 1);
      NodeAssert.equal(restarted.reconcile().repairedApprovals, 0);
      NodeAssert.equal(restarted.readWorkflow(review.workflowRun.id).approvals.length, 1);
      restarted.close();
    } finally {
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });
});
