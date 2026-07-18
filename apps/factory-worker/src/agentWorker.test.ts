// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

import { afterEach, describe, it } from "@effect/vitest";
import type {
  AgentRuntime,
  AgentRuntimeCompletion,
  AgentSessionReference,
  StartAgentInput,
} from "@mkcode/agent-runtime";
import type { WorkspaceGitEvidence, WorkspaceManager } from "@mkcode/workspace-manager";
import { WorkflowEngine } from "@mkcode/workflow-engine";

import { AgentExecutionWorker } from "./agentWorker.ts";

const roots: Array<string> = [];
const makeRoot = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-agent-worker-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

const evidence = (root: string, changed: ReadonlyArray<string> = []): WorkspaceGitEvidence => ({
  head: "a".repeat(40),
  branch: "mkcode/run-test",
  baseCommit: "a".repeat(40),
  trackedChangedPaths: [],
  untrackedPaths: changed,
  dirty: changed.length > 0,
  diffSummary: changed.join("\n"),
  localConfigurationDigest: "config",
  ownershipMarkerDigest: "marker",
});

class FakeRuntime implements AgentRuntime {
  readonly kind = "codex" as const;
  readonly capabilities = {
    structuredEvents: true,
    structuredResult: true,
    cancellation: true,
    timeout: true,
    nativeSessionIdentity: true,
    liveResumeObservation: false,
  };
  readonly #root: string;
  readonly #onStarted: (() => void) | undefined;
  readonly #onSessionRead: (() => void) | undefined;
  startedInput?: StartAgentInput;
  constructor(root: string, onStarted?: () => void, onSessionRead?: () => void) {
    this.#root = root;
    this.#onStarted = onStarted;
    this.#onSessionRead = onSessionRead;
  }
  outputReferences(id: string) {
    return { stdout: `agent-output/${id}/stdout.log`, stderr: `agent-output/${id}/stderr.log` };
  }
  async start(input: StartAgentInput) {
    this.startedInput = input;
    await NodeFSP.mkdir(NodePath.join(this.#root, "src"), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(this.#root, "src", "result.txt"), "done\n", "utf8");
    this.#onStarted?.();
    return {
      session: this.#session(input),
      startedAt: "2026-07-17T00:00:00.000Z",
      timeoutDeadline: "2026-07-17T00:01:00.000Z",
    };
  }
  status() {
    return Promise.resolve({ state: "completed" as const, result: this.#completion() });
  }
  wait() {
    return Promise.resolve(this.#completion());
  }
  cancel() {
    return Promise.resolve();
  }
  reconcile() {
    return Promise.resolve({ state: "ambiguous" as const, reason: "fake" });
  }
  events(_session: AgentSessionReference, cursor = 0) {
    return Promise.resolve({ events: [], nextCursor: cursor });
  }
  result() {
    return Promise.resolve(this.#completion());
  }
  #session(input: StartAgentInput): AgentSessionReference {
    const onSessionRead = this.#onSessionRead;
    let sessionRead = false;
    return {
      runtimeKind: "codex",
      executionId: input.executionId,
      get nativeSessionId() {
        if (!sessionRead) {
          sessionRead = true;
          onSessionRead?.();
        }
        return "session";
      },
      workingDirectory: input.workingDirectory,
      stdoutArtifactReference: `agent-output/${input.executionId}/stdout.log`,
      stderrArtifactReference: `agent-output/${input.executionId}/stderr.log`,
      nativePid: 123,
    };
  }
  #completion(): AgentRuntimeCompletion {
    const input = this.startedInput;
    if (!input) throw new Error("Fake runtime did not start.");
    return {
      outcome: "completed",
      exitCode: 0,
      signal: null,
      result: {
        version: 1,
        agentRunId: input.task.agentRunId,
        runtimeSessionReference: "session",
        status: "completed",
        summary: "done",
        claimedChangedPaths: ["src/result.txt"],
        claimedTestsChanged: [],
        unresolvedIssues: [],
        questionsOrBlockers: [],
        runtimeCompletionReason: "turn_completed",
        nativeSessionMetadata: { runtime: "codex" },
        startedAt: "2026-07-17T00:00:00.000Z",
        completedAt: "2026-07-17T00:00:01.000Z",
      },
      stdout: {
        locationReference: `agent-output/${input.executionId}/stdout.log`,
        digest: "out",
        observedBytes: 1,
        persistedBytes: 1,
        truncated: false,
      },
      stderr: {
        locationReference: `agent-output/${input.executionId}/stderr.log`,
        digest: "err",
        observedBytes: 0,
        persistedBytes: 0,
        truncated: false,
      },
    };
  }
}

const createAllocated = async (root: string) => {
  const source = NodePath.join(root, "source");
  const worktree = NodePath.join(root, "worktree");
  await NodeFSP.mkdir(worktree, { recursive: true });
  const engine = await WorkflowEngine.open({ stateDirectory: NodePath.join(root, "state") });
  const created = engine.createWorkflow({
    idempotencyKey: "builder",
    workItem: {
      projectId: "fixture",
      title: "Create result",
      description: "Write done",
      source: "manual",
    },
    workflowType: "feature",
    requestedBy: "operator",
    projectSnapshot: {
      version: 1,
      project: { id: "fixture", name: "Fixture" },
      repository: {
        baseBranch: "main",
        root: source,
        worktreeRoot: NodePath.join(root, "worktrees"),
        contextFiles: [],
      },
      setup: [],
      checks: [
        {
          id: "verify",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          workingDirectory: ".",
          resolvedWorkingDirectory: source,
          timeoutSeconds: 30,
          environment: [],
          artifacts: [],
          failureBehavior: "fail",
        },
      ],
      workflows: { allowed: ["feature"] },
      execution: { defaultProfile: "builtin-codex" },
      sourcePath: NodePath.join(source, ".mkcode/project.yaml"),
      contentDigest: "digest",
    },
    validationCheckId: "verify",
    builder: {
      objective: "Write the fixture result",
      acceptanceCriteria: ["result exists"],
      allowedPaths: ["src/**"],
      runtime: { kind: "codex", maximumRuntimeSeconds: 60 },
    },
  });
  const allocation = engine.claimNextJob("worker")!;
  const workspace = engine.readWorkflow(created.workflowRun.id).workspaces[0]!;
  engine.beginWorkspaceAllocation({
    workspaceId: workspace.id,
    jobId: allocation.job.id,
    leaseOwner: "worker",
    expectedStageVersion: allocation.stageVersion,
    evidence: {
      canonicalSourceRepositoryPath: source,
      gitCommonDirectory: NodePath.join(source, ".git"),
      resolvedBaseCommit: "a".repeat(40),
      baseResolvedAt: "2026-07-17T00:00:00.000Z",
      generatedBranchName: "mkcode/run-test",
      worktreePath: worktree,
      effectiveWorktreeRoot: NodePath.join(root, "worktrees"),
      ownershipClaimPath: NodePath.join(root, "claim"),
      ownershipMarkerDigest: "marker",
    },
  });
  engine.confirmWorkspaceAllocation({
    workspaceId: workspace.id,
    jobId: allocation.job.id,
    leaseOwner: "worker",
    expectedStageVersion: allocation.stageVersion,
    evidence: {
      canonicalWorktreePath: worktree,
      ownershipMarkerPath: NodePath.join(root, "marker"),
      ownershipMarkerDigest: "marker",
      gitMetadataState: "registered",
      currentObservedHead: "a".repeat(40),
      currentObservedBranch: "mkcode/run-test",
      dirty: false,
    },
  });
  return { engine, created, worktree };
};

describe("AgentExecutionWorker", () => {
  it("runs one bounded builder in the owned worktree and schedules deterministic validation", async () => {
    const root = await makeRoot();
    const { engine, created, worktree } = await createAllocated(root);
    let calls = 0;
    const manager = {
      captureGitEvidence: () =>
        Promise.resolve(evidence(worktree, calls++ === 0 ? [] : ["src/result.txt"])),
    } as unknown as WorkspaceManager;
    const runtime = new FakeRuntime(worktree);
    const worker = new AgentExecutionWorker({
      engine,
      runtime,
      workspaceManager: manager,
      workerInstanceId: "worker",
      leaseMilliseconds: 30_000,
      redactionValues: ["secret"],
    });
    const claimed = engine.claimNextJob("worker")!;
    await worker.runClaimed(claimed);
    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.agentRuns[0]?.status, "completed");
    NodeAssert.equal(detail.workflowRun.status, "validating");
    NodeAssert.equal(detail.commands[0]?.executionRoot, worktree);
    NodeAssert.equal(runtime.startedInput?.workingDirectory, worktree);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(worktree, "src/result.txt"), "utf8"),
      "done\n",
    );
    engine.close();
  });

  it("does not schedule validation when post-run evidence reports a forbidden path", async () => {
    const root = await makeRoot();
    const { engine, created, worktree } = await createAllocated(root);
    let calls = 0;
    const manager = {
      captureGitEvidence: () =>
        Promise.resolve(evidence(worktree, calls++ === 0 ? [] : [".mkcode/project.yaml"])),
    } as unknown as WorkspaceManager;
    const worker = new AgentExecutionWorker({
      engine,
      runtime: new FakeRuntime(worktree),
      workspaceManager: manager,
      workerInstanceId: "worker",
      leaseMilliseconds: 30_000,
      redactionValues: [],
    });
    await worker.runClaimed(engine.claimNextJob("worker")!);
    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.workflowRun.status, "operator_attention");
    NodeAssert.equal(detail.commands.length, 0);
    NodeAssert.deepEqual(detail.agentRuns[0]?.policyViolations, [
      "forbidden_path:.mkcode/project.yaml",
    ]);
    engine.close();
  });

  it("cancels a session that starts concurrently with durable workflow cancellation", async () => {
    const root = await makeRoot();
    const { engine, created, worktree } = await createAllocated(root);
    let calls = 0;
    const manager = {
      captureGitEvidence: () =>
        Promise.resolve(evidence(worktree, calls++ === 0 ? [] : ["src/result.txt"])),
    } as unknown as WorkspaceManager;
    const runtime = new FakeRuntime(worktree, () => {
      engine.cancelWorkflow(created.workflowRun.id, { requestedBy: "operator" });
    });
    const worker = new AgentExecutionWorker({
      engine,
      runtime,
      workspaceManager: manager,
      workerInstanceId: "worker",
      leaseMilliseconds: 30_000,
      redactionValues: [],
    });
    await worker.runClaimed(engine.claimNextJob("worker")!);
    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.workflowRun.status, "cancelled");
    NodeAssert.equal(detail.agentRuns[0]?.status, "cancelled");
    NodeAssert.equal(detail.commands.length, 0);
    NodeAssert.equal(detail.workspaces[0]?.status, "retained");
    engine.close();
  });

  it("honors cancellation between the post-start read and launch confirmation", async () => {
    const root = await makeRoot();
    const { engine, created, worktree } = await createAllocated(root);
    let calls = 0;
    const manager = {
      captureGitEvidence: () =>
        Promise.resolve(evidence(worktree, calls++ === 0 ? [] : ["src/result.txt"])),
    } as unknown as WorkspaceManager;
    const runtime = new FakeRuntime(worktree, undefined, () => {
      engine.cancelWorkflow(created.workflowRun.id, { requestedBy: "operator" });
    });
    const worker = new AgentExecutionWorker({
      engine,
      runtime,
      workspaceManager: manager,
      workerInstanceId: "worker",
      leaseMilliseconds: 30_000,
      redactionValues: [],
    });
    await worker.runClaimed(engine.claimNextJob("worker")!);
    const detail = engine.readWorkflow(created.workflowRun.id);
    NodeAssert.equal(detail.workflowRun.status, "cancelled");
    NodeAssert.equal(detail.agentRuns[0]?.status, "cancelled");
    NodeAssert.equal(detail.commands.length, 0);
    engine.close();
  });

  it("awaits runtime cancellation during worker shutdown", async () => {
    const root = await makeRoot();
    const { engine, worktree } = await createAllocated(root);
    let calls = 0;
    const manager = {
      captureGitEvidence: () =>
        Promise.resolve(evidence(worktree, calls++ === 0 ? [] : ["src/result.txt"])),
    } as unknown as WorkspaceManager;
    const runtime = new FakeRuntime(worktree);
    const originalWait = runtime.wait.bind(runtime);
    let releaseCompletion!: () => void;
    const completionGate = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    runtime.wait = async () => {
      await completionGate;
      return originalWait();
    };
    let releaseCancellation!: () => void;
    let cancellationStarted!: () => void;
    const cancellationObserved = new Promise<void>((resolve) => {
      cancellationStarted = resolve;
    });
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    runtime.cancel = () => {
      cancellationStarted();
      return cancellationGate;
    };
    const worker = new AgentExecutionWorker({
      engine,
      runtime,
      workspaceManager: manager,
      workerInstanceId: "worker",
      leaseMilliseconds: 30_000,
      redactionValues: [],
    });
    const running = worker.runClaimed(engine.claimNextJob("worker")!);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (engine.listAgentRunsForReconciliation()[0]?.status === "running") break;
      await NodeTimersPromises.setImmediate();
    }
    NodeAssert.equal(engine.listAgentRunsForReconciliation()[0]?.status, "running");
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await cancellationObserved;
    await Promise.resolve();
    NodeAssert.equal(stopped, false);
    releaseCancellation();
    await stopping;
    releaseCompletion();
    await running;
    engine.close();
  });
});
