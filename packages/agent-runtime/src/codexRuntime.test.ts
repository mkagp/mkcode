// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, it } from "@effect/vitest";

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
});
