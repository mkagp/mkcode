// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Synthetic process-host events exercise runtime races.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { afterEach, describe, it } from "@effect/vitest";
import type { ProcessExit, ProcessHost, ProcessStatus } from "@mkcode/command-runner";

import type { BuilderTaskEnvelope, StartAgentInput } from "./contracts.ts";
import { AgentRuntimeError } from "./contracts.ts";
import { CodexAgentRuntime } from "./codexRuntime.ts";

const roots: Array<string> = [];
let executableCounter = 0;

const makeRoot = async (): Promise<string> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-agent-runtime-"));
  roots.push(root);
  await NodeFSP.mkdir(NodePath.join(root, "worktree"));
  return root;
};

const makeExecutable = async (root: string, source: string): Promise<string> => {
  executableCounter += 1;
  const path = NodePath.join(root, `fake-codex-${executableCounter}`);
  await NodeFSP.writeFile(path, `#!/usr/bin/env node\n${source}\n`, { mode: 0o700 });
  await NodeFSP.chmod(path, 0o700);
  return path;
};

const task = (root: string, maximumRuntimeSeconds = 30): BuilderTaskEnvelope => ({
  version: 1,
  role: "single-builder",
  workItemId: "work-1",
  workflowRunId: "run-1",
  agentRunId: "agent-1",
  projectId: "fixture-project",
  objective: "Edit the fixture",
  task: { title: "Edit fixture", description: "Create src/status.txt." },
  acceptanceCriteria: ["Status is ready"],
  scope: { allowedPaths: ["src/**"], forbiddenPaths: [".git/**", ".mkcode/**"] },
  worktreePathReference: NodePath.join(root, "worktree"),
  contextFileReferences: [],
  validationCheckId: "verify",
  maximumRuntimeSeconds,
  cancellationPolicy: "interrupt_then_kill",
  completionOutput: { structuredResultRequired: true },
});

const startInput = (root: string, maximumRuntimeSeconds = 30): StartAgentInput => ({
  task: task(root, maximumRuntimeSeconds),
  prompt: "bounded prompt",
  runtimeConfiguration: { kind: "codex", executable: "codex", sandbox: "workspace-write" },
  executionId: "execution-1",
  workingDirectory: NodePath.join(root, "worktree"),
  redactionValues: ["secret-marker"],
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

describe("CodexAgentRuntime", () => {
  it("captures a structured result and redacts normalized output before persistence", async () => {
    const root = await makeRoot();
    const executable = await makeExecutable(
      root,
      `
const result = {
  status: "completed",
  summary: "implemented secret-marker",
  claimedChangedPaths: ["src/status.txt"],
  claimedTestsChanged: [],
  unresolvedIssues: [],
  questionsOrBlockers: []
};
if (process.argv[process.argv.indexOf("--sandbox") + 1] !== "workspace-write") process.exit(9);
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-1" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
console.error("stderr secret-marker");
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }));
`,
    );
    const runtime = new CodexAgentRuntime({
      stateRoot: NodePath.join(root, "state"),
      executable,
      environment: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        MKCODE_FACTORY_TOKEN: "never-pass",
      },
    });
    const started = await runtime.start(startInput(root));
    const completion = await runtime.wait(started.session);
    const completedEvents = await runtime.events(started.session);

    NodeAssert.equal(started.session.nativeSessionId, "thread-1");
    NodeAssert.equal(completion.outcome, "completed");
    NodeAssert.equal(completion.result.summary, "implemented [REDACTED]");
    const stdout = await runtime.outputStore.readPage({
      locationReference: completion.stdout.locationReference,
    });
    const stderr = await runtime.outputStore.readPage({
      locationReference: completion.stderr.locationReference,
    });
    NodeAssert.doesNotMatch(stdout.data, /secret-marker/u);
    NodeAssert.doesNotMatch(stderr.data, /secret-marker/u);
    NodeAssert.doesNotMatch(stdout.data, /implemented secret-marker/u);
    NodeAssert.match(stderr.data, /\[REDACTED\]/u);
    NodeAssert.equal(completedEvents.events.at(-1)?.type, "agent.completed");

    const restarted = new CodexAgentRuntime({ stateRoot: NodePath.join(root, "state") });
    const recovered = await restarted.reconcile(started.session);
    NodeAssert.equal(recovered.state, "completed");
    NodeAssert.deepEqual(await restarted.events(started.session), completedEvents);
    await NodeAssert.rejects(
      () =>
        restarted.result({
          ...started.session,
          nativeSessionId: "different-session",
        }),
      (cause) => cause instanceof AgentRuntimeError && cause.code === "runtime_session_not_found",
    );
    const completionPath = NodePath.join(
      root,
      "state",
      "agent-control",
      started.session.executionId,
      "completion.json",
    );
    const malformed = JSON.parse(await NodeFSP.readFile(completionPath, "utf8")) as {
      result: Record<string, unknown>;
    };
    delete malformed.result.claimedChangedPaths;
    await NodeFSP.writeFile(completionPath, `${JSON.stringify(malformed)}\n`, "utf8");
    const rejectingRuntime = new CodexAgentRuntime({ stateRoot: NodePath.join(root, "state") });
    NodeAssert.equal((await rejectingRuntime.reconcile(started.session)).state, "ambiguous");
  });

  it("uses the canonical working directory for subsequent session operations", async () => {
    const root = await makeRoot();
    const executable = await makeExecutable(
      root,
      `
const result = {
  status: "completed",
  summary: "done",
  claimedChangedPaths: [],
  claimedTestsChanged: [],
  unresolvedIssues: [],
  questionsOrBlockers: []
};
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-canonical" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
console.log(JSON.stringify({ type: "turn.completed" }));
`,
    );
    const runtime = new CodexAgentRuntime({
      stateRoot: NodePath.join(root, "state"),
      executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const input = startInput(root);
    const started = await runtime.start({
      ...input,
      workingDirectory: NodePath.join(root, "worktree", "..", "worktree"),
    });
    NodeAssert.equal(started.session.workingDirectory, NodePath.join(root, "worktree"));
    NodeAssert.equal((await runtime.wait(started.session)).outcome, "completed");
  });

  it("rejects unavailable binaries and invalid model configuration", async () => {
    const root = await makeRoot();
    const missing = new CodexAgentRuntime({
      stateRoot: NodePath.join(root, "missing-state"),
      executable: NodePath.join(root, "missing-codex"),
    });
    await NodeAssert.rejects(
      () => missing.start(startInput(root)),
      (cause) => cause instanceof AgentRuntimeError && cause.code === "runtime_unavailable",
    );

    const invalid = new CodexAgentRuntime({ stateRoot: NodePath.join(root, "invalid-state") });
    await NodeAssert.rejects(
      () =>
        invalid.start({
          ...startInput(root),
          runtimeConfiguration: {
            ...startInput(root).runtimeConfiguration,
            model: "invalid model",
          },
        }),
      (cause) => cause instanceof AgentRuntimeError && cause.code === "invalid_configuration",
    );
  });

  it("cancels a running process and preserves the cancelled outcome", async () => {
    const root = await makeRoot();
    const executable = await makeExecutable(
      root,
      `
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-cancel" }));
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    const runtime = new CodexAgentRuntime({
      stateRoot: NodePath.join(root, "state"),
      executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const started = await runtime.start(startInput(root));
    await runtime.cancel(started.session, "test cancellation");
    const completion = await runtime.wait(started.session);
    NodeAssert.equal(completion.outcome, "cancelled");
    NodeAssert.equal(completion.result.status, "cancelled");
  });

  it("preserves a structured blocked result without treating it as completion", async () => {
    const root = await makeRoot();
    const executable = await makeExecutable(
      root,
      `
const result = {
  status: "blocked",
  summary: "operator input required",
  claimedChangedPaths: [],
  claimedTestsChanged: [],
  unresolvedIssues: ["decision required"],
  questionsOrBlockers: ["choose behavior"]
};
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-blocked" }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }));
console.log(JSON.stringify({ type: "turn.completed" }));
setTimeout(() => {}, 25);
`,
    );
    const runtime = new CodexAgentRuntime({
      stateRoot: NodePath.join(root, "state"),
      executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const started = await runtime.start(startInput(root));
    const completion = await runtime.wait(started.session);
    NodeAssert.equal(completion.outcome, "blocked");
    NodeAssert.equal(completion.result.status, "blocked");
  });

  it("times out a running process", async () => {
    const root = await makeRoot();
    const executable = await makeExecutable(
      root,
      `
console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-timeout" }));
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 1000);
`,
    );
    const runtime = new CodexAgentRuntime({
      stateRoot: NodePath.join(root, "state"),
      executable,
      environment: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    const started = await runtime.start(startInput(root, 1));
    const completion = await runtime.wait(started.session);
    NodeAssert.equal(completion.outcome, "timed_out");
  });

  it("routes an unprovable post-restart local session to ambiguous reconciliation", async () => {
    const root = await makeRoot();
    const runtime = new CodexAgentRuntime({ stateRoot: NodePath.join(root, "state") });
    const result = await runtime.reconcile({
      runtimeKind: "codex",
      executionId: "unknown-execution",
      nativeSessionId: "unknown-session",
      workingDirectory: root,
      stdoutArtifactReference: "agent-output/unknown-execution/stdout.log",
      stderrArtifactReference: "agent-output/unknown-execution/stderr.log",
    });
    NodeAssert.deepEqual(result, {
      state: "ambiguous",
      reason: "Local Codex process ownership cannot be proven after worker restart.",
    });
  });

  it("persists a failed completion and releases the session when output monitoring fails", async () => {
    const root = await makeRoot();
    const stdout = new NodeStream.PassThrough();
    const stderr = new NodeStream.PassThrough();
    let running = true;
    let resolveCompletion!: (exit: ProcessExit) => void;
    const completion = new Promise<ProcessExit>((resolve) => {
      resolveCompletion = resolve;
    });
    const stop = () => {
      if (!running) return;
      running = false;
      stdout.destroy();
      stderr.end();
      resolveCompletion({ exitCode: null, signal: "SIGKILL" });
    };
    const host: ProcessHost = {
      type: "test",
      start: async (input) => {
        setTimeout(() => {
          stdout.write(
            `${JSON.stringify({ type: "thread.started", thread_id: "thread-stream" })}\n`,
          );
          setTimeout(() => stdout.destroy(new Error("synthetic stream failure")), 25);
        }, 0);
        return {
          executionId: input.executionId ?? "execution-1",
          stdout,
          stderr,
          completion,
        };
      },
      status: async (): Promise<ProcessStatus> =>
        running ? { state: "running" } : { state: "exited", exitCode: null, signal: "SIGKILL" },
      interrupt: async () => stop(),
      terminate: async () => stop(),
    };
    const stateRoot = NodePath.join(root, "state");
    const runtime = new CodexAgentRuntime({ stateRoot, processHost: host });
    const started = await runtime.start(startInput(root));
    const result = await runtime.wait(started.session);
    NodeAssert.equal(result.outcome, "failed");
    NodeAssert.equal(result.result.runtimeCompletionReason, "output_monitor_failed");
    NodeAssert.equal((await runtime.status(started.session)).state, "completed");

    const restarted = new CodexAgentRuntime({ stateRoot });
    NodeAssert.equal((await restarted.reconcile(started.session)).state, "completed");
  });

  it("bounds process-host startup by the task runtime deadline", async () => {
    const root = await makeRoot();
    let interruptCount = 0;
    let terminateCount = 0;
    const host: ProcessHost = {
      type: "test",
      start: () => new Promise(() => undefined),
      status: async () => ({ state: "unknown" }),
      interrupt: async () => {
        interruptCount += 1;
      },
      terminate: async () => {
        terminateCount += 1;
      },
    };
    const runtime = new CodexAgentRuntime({
      stateRoot: NodePath.join(root, "state"),
      processHost: host,
    });
    await NodeAssert.rejects(
      () => runtime.start(startInput(root, 1)),
      (cause) =>
        cause instanceof AgentRuntimeError &&
        cause.code === "runtime_start_failed" &&
        /launch deadline/u.test(cause.message),
    );
    NodeAssert.equal(interruptCount, 1);
    NodeAssert.equal(terminateCount, 1);
  });
});
