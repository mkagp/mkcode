// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- Polling assertions use bounded wall-clock deadlines.
// @effect-diagnostics globalFetch:off -- This is an end-to-end test of the real HTTP listener.
// @effect-diagnostics globalTimers:off -- Bounded polling verifies asynchronous worker progress.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, it } from "@effect/vitest";
import type {
  CommandOutputPage,
  CommandRun,
  WorkflowCreateRequest,
  WorkflowCreateResult,
  WorkflowDetail,
} from "@mkcode/factory-contracts";

import { configFromEnvironment, resolveFactoryWorkerConfig } from "./config.ts";
import { startFactoryWorker, type RunningFactoryWorker } from "./runtime.ts";

const credential = "factory-test-credential-0123456789abcdef";

const makeRoot = async () =>
  NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-factory-worker-"));

const makeRequest = (root: string, key = "factory-http-create"): WorkflowCreateRequest => ({
  idempotencyKey: key,
  workItem: {
    projectId: "factory-http-project",
    title: "Exercise the worker API",
    description: "Advance a simulation through the authenticated process boundary.",
    source: "manual",
  },
  workflowType: "feature",
  requestedBy: "server-test",
  projectSnapshot: {
    version: 1,
    project: { id: "factory-http-project", name: "Factory HTTP Project" },
    repository: {
      baseBranch: "main",
      root,
      worktreeRoot: NodePath.join(root, ".worktrees"),
      contextFiles: [],
    },
    setup: [],
    checks: [],
    workflows: { allowed: ["feature"] },
    execution: { defaultProfile: "test-profile" },
    sourcePath: NodePath.join(root, ".mkcode", "project.yaml"),
    contentDigest: "fixture-digest",
  },
});

const makeCommandRequest = (
  root: string,
  key: string,
  args: ReadonlyArray<string>,
  options: {
    readonly timeoutSeconds?: number;
    readonly environment?: ReadonlyArray<{ readonly name: string; readonly source: string }>;
  } = {},
): WorkflowCreateRequest => {
  const request = makeRequest(root, key);
  return {
    ...request,
    validationCheckId: "lint",
    projectSnapshot: {
      ...request.projectSnapshot,
      checks: [
        {
          id: "lint",
          executable: process.execPath,
          args,
          workingDirectory: ".",
          resolvedWorkingDirectory: root,
          timeoutSeconds: options.timeoutSeconds ?? 10,
          environment: options.environment ?? [],
          artifacts: [],
          failureBehavior: "fail",
        },
      ],
    },
  };
};

const api = async <A>(
  worker: RunningFactoryWorker,
  path: string,
  options: { readonly method?: string; readonly body?: unknown; readonly token?: string } = {},
): Promise<{ readonly status: number; readonly body: A }> => {
  const response = await fetch(`${worker.origin}${path}`, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${options.token ?? credential}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as A,
  };
};

const waitForStatus = async (
  worker: RunningFactoryWorker,
  runId: string,
  status: WorkflowDetail["workflowRun"]["status"],
): Promise<WorkflowDetail> => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const response = await api<WorkflowDetail>(worker, `/v1/workflows/${runId}`);
    if (response.body.workflowRun.status === status) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow ${runId} did not reach ${status}.`);
};

const waitForCommandStatus = async (
  worker: RunningFactoryWorker,
  runId: string,
  status: CommandRun["status"],
): Promise<WorkflowDetail> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await api<WorkflowDetail>(worker, `/v1/workflows/${runId}`);
    if (response.body.commands.some((command) => command.status === status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Workflow ${runId} did not reach command status ${status}.`);
};

const waitForCommandOutput = async (
  worker: RunningFactoryWorker,
  commandRunId: string,
): Promise<CommandRun> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await api<CommandRun>(worker, `/v1/commands/${commandRunId}`);
    if (response.body.stdoutArtifactReference && response.body.stdoutObservedBytes > 0) {
      return response.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Command ${commandRunId} did not persist output.`);
};

const waitForLiveOutput = async (
  worker: RunningFactoryWorker,
  commandRunId: string,
): Promise<CommandOutputPage> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await api<CommandOutputPage>(
      worker,
      `/v1/commands/${commandRunId}/output?stream=stdout`,
    );
    if (response.status === 200 && response.body.data.length > 0) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Command ${commandRunId} did not expose live output.`);
};

describe("factory worker API", () => {
  it("runs independently, authenticates every endpoint, survives restart, and replays events", async () => {
    const root = await makeRoot();
    const stateDirectory = NodePath.join(root, "state");
    const config = resolveFactoryWorkerConfig({
      host: "127.0.0.1",
      port: 0,
      stateDirectory,
      credential,
      workerInstanceId: "worker-before-restart",
      pollIntervalMilliseconds: 5,
      leaseMilliseconds: 1_000,
    });
    let worker = await startFactoryWorker(config);
    try {
      const unauthorized = await api<{ code: string }>(worker, "/v1/workflows", {
        token: "invalid-credential-that-is-also-long",
      });
      NodeAssert.equal(unauthorized.status, 401);
      NodeAssert.equal(unauthorized.body.code, "unauthorized");

      const health = await api<{ ok: boolean; workerInstanceId: string }>(worker, "/health");
      NodeAssert.equal(health.status, 200);
      NodeAssert.equal(health.body.workerInstanceId, "worker-before-restart");

      const createdResponse = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeRequest(root),
      });
      NodeAssert.equal(createdResponse.status, 201);
      const workflowPage = await api<{
        runs: ReadonlyArray<unknown>;
        nextCursor?: string;
        hasMore: boolean;
      }>(worker, "/v1/workflows?limit=999");
      NodeAssert.equal(workflowPage.status, 200);
      NodeAssert.equal(workflowPage.body.runs.length, 1);
      NodeAssert.equal(workflowPage.body.nextCursor, undefined);
      NodeAssert.equal(workflowPage.body.hasMore, false);
      const invalidCursor = await api<{ code: string }>(worker, "/v1/workflows?cursor=-1");
      NodeAssert.equal(invalidCursor.status, 400);
      NodeAssert.equal(invalidCursor.body.code, "invalid_cursor");
      const runId = createdResponse.body.workflowRun.id;
      const waiting = await waitForStatus(worker, runId, "human_review");
      const approvalId = waiting.approvals[0]?.id;
      NodeAssert.ok(approvalId);
      const beforeRestartEvents = await api<{ events: ReadonlyArray<{ cursor: number }> }>(
        worker,
        `/v1/events?runId=${runId}&limit=100`,
      );
      const lastCursor = beforeRestartEvents.body.events.at(-1)?.cursor;
      NodeAssert.ok(lastCursor);

      await worker.stop();
      worker = await startFactoryWorker({
        ...config,
        workerInstanceId: "worker-after-restart",
      });
      const recovered = await api<WorkflowDetail>(worker, `/v1/workflows/${runId}`);
      NodeAssert.equal(recovered.body.workflowRun.status, "human_review");
      NodeAssert.equal(recovered.body.approvals[0]?.status, "pending");

      const resumedEvents = await api<{ events: ReadonlyArray<unknown>; nextCursor: number }>(
        worker,
        `/v1/events?runId=${runId}&after=${lastCursor}`,
      );
      NodeAssert.deepEqual(resumedEvents.body.events, []);
      NodeAssert.equal(resumedEvents.body.nextCursor, lastCursor);

      const approval = await api<WorkflowDetail>(worker, `/v1/approvals/${approvalId}/resolve`, {
        method: "POST",
        body: { decision: "approved", resolvedBy: "operator" },
      });
      NodeAssert.equal(approval.status, 200);
      NodeAssert.equal(approval.body.workflowRun.status, "completed");
      const repeated = await api<WorkflowDetail>(worker, `/v1/approvals/${approvalId}/resolve`, {
        method: "POST",
        body: { decision: "approved", resolvedBy: "operator" },
      });
      NodeAssert.equal(repeated.body.workflowRun.status, "completed");
    } finally {
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps cancellation durable and rejects malformed authenticated requests", async () => {
    const root = await makeRoot();
    const worker = await startFactoryWorker(
      resolveFactoryWorkerConfig({
        host: "127.0.0.1",
        port: 0,
        stateDirectory: NodePath.join(root, "state"),
        credential,
        pollIntervalMilliseconds: 60_000,
      }),
    );
    try {
      const malformed = await fetch(`${worker.origin}/v1/workflows`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: "{",
      });
      NodeAssert.equal(malformed.status, 400);
      const invalidShape = await api<{ code: string }>(worker, "/v1/workflows", {
        method: "POST",
        body: {},
      });
      NodeAssert.equal(invalidShape.status, 400);
      NodeAssert.equal(invalidShape.body.code, "invalid_request");
      const malformedIdentifier = await fetch(`${worker.origin}/v1/workflows/%E0%A4%A`, {
        headers: { authorization: `Bearer ${credential}` },
      });
      NodeAssert.equal(malformedIdentifier.status, 400);
      NodeAssert.equal(
        ((await malformedIdentifier.json()) as { code: string }).code,
        "invalid_request",
      );

      const created = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeRequest(root, "cancel-over-http"),
      });
      const cancelled = await api<WorkflowDetail>(
        worker,
        `/v1/workflows/${created.body.workflowRun.id}/cancel`,
        {
          method: "POST",
          body: { requestedBy: "operator" },
        },
      );
      NodeAssert.equal(cancelled.body.workflowRun.status, "cancelled");
      NodeAssert.equal(cancelled.body.jobs[0]?.status, "cancelled");
      const repeated = await api<WorkflowDetail>(
        worker,
        `/v1/workflows/${created.body.workflowRun.id}/cancel`,
        {
          method: "POST",
          body: { requestedBy: "operator" },
        },
      );
      NodeAssert.equal(repeated.body.workflowRun.version, cancelled.body.workflowRun.version);
    } finally {
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("executes a declared check, redacts output, and serves it after restart", async () => {
    const root = await makeRoot();
    const stateDirectory = NodePath.join(root, "state");
    const secret = "runtime-acceptance-secret-marker";
    const priorSecret = process.env.MKCODE_COMMAND_TEST_SECRET;
    process.env.MKCODE_COMMAND_TEST_SECRET = secret;
    const config = resolveFactoryWorkerConfig({
      host: "127.0.0.1",
      port: 0,
      stateDirectory,
      credential,
      workerInstanceId: "command-worker-before-restart",
      pollIntervalMilliseconds: 5,
      leaseMilliseconds: 1_000,
    });
    let worker = await startFactoryWorker(config);
    try {
      const created = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeCommandRequest(
          root,
          "command-passing",
          ["-e", "console.log('lint passed ' + process.env.PROJECT_SECRET)"],
          {
            environment: [{ name: "PROJECT_SECRET", source: "MKCODE_COMMAND_TEST_SECRET" }],
          },
        ),
      });
      const waiting = await waitForStatus(worker, created.body.workflowRun.id, "human_review");
      const command = waiting.commands[0];
      NodeAssert.ok(command);
      NodeAssert.equal(command.outcome, "passed");
      const output = await api<CommandOutputPage>(
        worker,
        `/v1/commands/${command.id}/output?stream=stdout`,
      );
      NodeAssert.equal(output.status, 200);
      NodeAssert.match(output.body.data, /lint passed \[REDACTED\]/u);
      NodeAssert.equal(output.body.data.includes(secret), false);

      await worker.stop();
      worker = await startFactoryWorker({
        ...config,
        workerInstanceId: "command-worker-after-restart",
      });
      const recoveredOutput = await api<CommandOutputPage>(
        worker,
        `/v1/commands/${command.id}/output?stream=stdout`,
      );
      NodeAssert.equal(recoveredOutput.body.data, output.body.data);
      const events = await api<{ events: ReadonlyArray<{ eventType: string }> }>(
        worker,
        `/v1/events?runId=${created.body.workflowRun.id}`,
      );
      NodeAssert.ok(events.body.events.some((event) => event.eventType === "command.completed"));

      const injection = await api<{ code: string }>(worker, "/v1/commands", {
        method: "POST",
        body: { executable: "bash", args: ["-c", "touch injected"] },
      });
      NodeAssert.equal(injection.status, 404);
      await NodeAssert.rejects(() => NodeFSP.stat(NodePath.join(root, "injected")));
    } finally {
      if (priorSecret === undefined) delete process.env.MKCODE_COMMAND_TEST_SECRET;
      else process.env.MKCODE_COMMAND_TEST_SECRET = priorSecret;
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("records nonzero declared checks as deterministic failures", async () => {
    const root = await makeRoot();
    const worker = await startFactoryWorker(
      resolveFactoryWorkerConfig({
        host: "127.0.0.1",
        port: 0,
        stateDirectory: NodePath.join(root, "state"),
        credential,
        pollIntervalMilliseconds: 5,
        leaseMilliseconds: 1_000,
      }),
    );
    try {
      const created = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeCommandRequest(root, "command-failing", [
          "-e",
          "console.error('lint failed'); process.exit(2)",
        ]),
      });
      const failed = await waitForStatus(worker, created.body.workflowRun.id, "failed");
      NodeAssert.equal(failed.commands[0]?.outcome, "failed");
      NodeAssert.equal(failed.commands[0]?.exitCode, 2);
      NodeAssert.equal(failed.commands[0]?.failureClassification, "nonzero_exit");
    } finally {
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("times out and durably cancels declared checks", async () => {
    const root = await makeRoot();
    const worker = await startFactoryWorker(
      resolveFactoryWorkerConfig({
        host: "127.0.0.1",
        port: 0,
        stateDirectory: NodePath.join(root, "state"),
        credential,
        pollIntervalMilliseconds: 5,
        leaseMilliseconds: 1_000,
      }),
    );
    try {
      const timed = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeCommandRequest(root, "command-timeout", ["-e", "setInterval(() => {}, 1000)"], {
          timeoutSeconds: 1,
        }),
      });
      const timedOut = await waitForCommandStatus(worker, timed.body.workflowRun.id, "timed_out");
      NodeAssert.equal(timedOut.workflowRun.status, "failed");
      NodeAssert.equal(timedOut.commands[0]?.timedOut, true);

      const cancellable = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeCommandRequest(root, "command-cancel", [
          "-e",
          "setInterval(() => console.log('waiting'), 25)",
        ]),
      });
      const running = await waitForCommandStatus(
        worker,
        cancellable.body.workflowRun.id,
        "running",
      );
      const command = running.commands[0];
      NodeAssert.ok(command);
      await waitForLiveOutput(worker, command.id);
      const cancelled = await api<WorkflowDetail>(worker, `/v1/commands/${command.id}/cancel`, {
        method: "POST",
        body: { requestedBy: "operator" },
      });
      NodeAssert.equal(cancelled.body.workflowRun.status, "cancelled");
      const durable = await waitForCommandStatus(
        worker,
        cancellable.body.workflowRun.id,
        "cancelled",
      );
      NodeAssert.equal(durable.commands[0]?.cancelled, true);
      const withOutput = await waitForCommandOutput(worker, command.id);
      NodeAssert.ok(withOutput.stdoutObservedBytes > 0);
    } finally {
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unsafe non-loopback binding without the explicit escape hatch", () => {
    NodeAssert.throws(() =>
      resolveFactoryWorkerConfig({
        host: "0.0.0.0",
        credential,
      }),
    );
    NodeAssert.equal(
      resolveFactoryWorkerConfig({
        host: "0.0.0.0",
        credential,
        allowNonLoopback: true,
      }).host,
      "0.0.0.0",
    );
    NodeAssert.equal(
      resolveFactoryWorkerConfig({
        credential: `  ${credential}  `,
      }).credential,
      credential,
    );
    for (const invalidDuration of [0, -1, Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      NodeAssert.throws(() =>
        resolveFactoryWorkerConfig({
          credential,
          pollIntervalMilliseconds: invalidDuration,
        }),
      );
      NodeAssert.throws(() =>
        resolveFactoryWorkerConfig({
          credential,
          leaseMilliseconds: invalidDuration,
        }),
      );
    }
    NodeAssert.throws(() =>
      resolveFactoryWorkerConfig({
        credential,
        leaseMilliseconds: 99,
      }),
    );
    NodeAssert.equal(
      configFromEnvironment({
        MKCODE_FACTORY_TOKEN: credential,
        MKCODE_FACTORY_WORKER_ID: "   ",
      }).workerInstanceId.startsWith("factory-"),
      true,
    );
    NodeAssert.equal(
      configFromEnvironment({
        MKCODE_FACTORY_TOKEN: credential,
        MKCODE_FACTORY_WORKER_ID: "  worker-trimmed  ",
      }).workerInstanceId,
      "worker-trimmed",
    );
    for (const invalidValue of ["", "4317junk", "1.5", "1e3", " 4317"]) {
      for (const variable of [
        "MKCODE_FACTORY_PORT",
        "MKCODE_FACTORY_POLL_MS",
        "MKCODE_FACTORY_LEASE_MS",
        "MKCODE_FACTORY_SHUTDOWN_GRACE_MS",
      ] as const) {
        NodeAssert.throws(() =>
          configFromEnvironment({
            MKCODE_FACTORY_TOKEN: credential,
            [variable]: invalidValue,
          }),
        );
      }
    }
  });

  it("resolves an explicit relative database path inside the state directory", () => {
    const stateDirectory = NodePath.join(NodeOS.tmpdir(), "mkcode-relative-database");
    const config = resolveFactoryWorkerConfig({
      credential,
      stateDirectory,
      databasePath: "nested/factory.sqlite",
    });
    NodeAssert.equal(
      config.databasePath,
      NodePath.join(stateDirectory, "nested", "factory.sqlite"),
    );
  });

  it("bounds shutdown when a simulation handler does not settle", async () => {
    const root = await makeRoot();
    let releaseHandler: (() => void) | undefined;
    const handlerStarted = Promise.withResolvers<void>();
    const handlerRelease = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const worker = await startFactoryWorker(
      resolveFactoryWorkerConfig({
        host: "127.0.0.1",
        port: 0,
        stateDirectory: NodePath.join(root, "state"),
        credential,
        pollIntervalMilliseconds: 5,
        leaseMilliseconds: 1_000,
        shutdownGraceMilliseconds: 20,
      }),
      async () => {
        handlerStarted.resolve();
        await handlerRelease;
        return { kind: "success" };
      },
    );
    try {
      await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeRequest(root, "bounded-shutdown"),
      });
      await handlerStarted.promise;
      const result = await Promise.race([
        worker.stop().then(() => "stopped" as const),
        new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
      ]);
      NodeAssert.equal(result, "stopped");
    } finally {
      releaseHandler?.();
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("closes persistence even when the HTTP listener is already closed", async () => {
    const root = await makeRoot();
    const worker = await startFactoryWorker(
      resolveFactoryWorkerConfig({
        host: "127.0.0.1",
        port: 0,
        stateDirectory: NodePath.join(root, "state"),
        credential,
      }),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        worker.server.close((cause) => {
          if (cause) reject(cause);
          else resolve();
        });
      });
      await NodeAssert.rejects(() => worker.stop());
      NodeAssert.throws(() => worker.engine.listWorkflows());
    } finally {
      await worker.stop().catch(() => undefined);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("turns unexpected simulation handler failures into bounded durable retries", async () => {
    const root = await makeRoot();
    const worker = await startFactoryWorker(
      resolveFactoryWorkerConfig({
        host: "127.0.0.1",
        port: 0,
        stateDirectory: NodePath.join(root, "state"),
        credential,
        pollIntervalMilliseconds: 5,
        leaseMilliseconds: 1_000,
      }),
      () => {
        throw new Error("controlled handler rejection");
      },
    );
    try {
      const created = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeRequest(root, "handler-rejection"),
      });
      const failed = await waitForStatus(worker, created.body.workflowRun.id, "failed");
      NodeAssert.equal(failed.jobs[0]?.status, "failed");
      NodeAssert.equal(failed.attempts.length, 3);
      NodeAssert.equal(
        failed.attempts.every((attempt) => attempt.status === "failed"),
        true,
      );
    } finally {
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("aborts simulation handlers before their durable lease can expire", async () => {
    const root = await makeRoot();
    const worker = await startFactoryWorker(
      resolveFactoryWorkerConfig({
        host: "127.0.0.1",
        port: 0,
        stateDirectory: NodePath.join(root, "state"),
        credential,
        pollIntervalMilliseconds: 5,
        leaseMilliseconds: 100,
      }),
      async (_claimed, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("deadline reached")), {
            once: true,
          });
        }),
    );
    try {
      const created = await api<WorkflowCreateResult>(worker, "/v1/workflows", {
        method: "POST",
        body: makeRequest(root, "handler-deadline"),
      });
      const failed = await waitForStatus(worker, created.body.workflowRun.id, "failed");
      NodeAssert.equal(failed.attempts.length, 3);
      NodeAssert.equal(failed.jobs[0]?.status, "failed");
    } finally {
      await worker.stop();
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
