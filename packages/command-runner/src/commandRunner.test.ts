// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- Tests exercise durable timestamp output.
// @effect-diagnostics globalTimers:off -- Cancellation tests control native process deadlines.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeTimers from "node:timers";

import { afterEach, describe, expect, it } from "@effect/vitest";

import {
  CommandOutputStore,
  DeterministicCommandRunner,
  LocalProcessHost,
  StreamingRedactor,
} from "./index.ts";

const roots: Array<string> = [];
const temporaryRoot = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-command-"));
  roots.push(root);
  return root;
};

const definition = (overrides: Record<string, unknown> = {}) =>
  ({
    id: "lint",
    executable: NodeProcess.execPath,
    args: ["-e", "console.log('passed')"],
    workingDirectory: ".",
    resolvedWorkingDirectory: ".",
    timeoutSeconds: 5,
    environment: [],
    artifacts: [],
    failureBehavior: "fail",
    ...overrides,
  }) as never;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

describe("StreamingRedactor", () => {
  it("redacts secrets split across chunks", () => {
    const redactor = new StreamingRedactor(["split-secret-value"]);
    const output =
      redactor.push(Buffer.from("before split-se")) +
      redactor.push(Buffer.from("cret-value after")) +
      redactor.finish();
    expect(output).toBe("before [REDACTED] after");
  });

  it("redacts token patterns", () => {
    const redactor = new StreamingRedactor([]);
    const output =
      redactor.push(Buffer.from("Authorization: Bearer abcdefghijklmnopqrstuvwxyz")) +
      redactor.finish();
    expect(output).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("suppresses pattern tokens longer than the streaming carry window", () => {
    const token = "a".repeat(2_048);
    const redactor = new StreamingRedactor([]);
    const output =
      redactor.push(Buffer.from(`before Bearer ${token.slice(0, 700)}`)) +
      redactor.push(Buffer.from(token.slice(700))) +
      redactor.push(Buffer.from(" after")) +
      redactor.finish();
    expect(output).toBe("before [REDACTED] after");
    expect(output).not.toContain(token.slice(-600));
  });

  it("redacts a complete pattern that crosses the streaming carry boundary", () => {
    const token = "boundary-token-value-123456789";
    const redactor = new StreamingRedactor([]);
    const output =
      redactor.push(Buffer.from(`${"x".repeat(50)} Bearer ${token}\n${"y".repeat(500)}`)) +
      redactor.finish();
    expect(output).not.toContain(token);
    expect(output).toContain("[REDACTED]");
  });

  it("handles empty, repeated, overlapping, and very long exact values", () => {
    const longSecret = "x".repeat(8_192);
    const redactor = new StreamingRedactor(["", "token", "token-value", longSecret]);
    const output =
      redactor.push(Buffer.from(`token token-value ${longSecret.slice(0, 4_000)}`)) +
      redactor.push(Buffer.from(longSecret.slice(4_000))) +
      redactor.finish();
    expect(output).not.toContain("token-value");
    expect(output).not.toContain(longSecret);
    expect(output.match(/\[REDACTED\]/gu)?.length).toBe(3);
  });
});

describe("DeterministicCommandRunner", () => {
  it("reserves process-host execution IDs before spawn confirmation", async () => {
    const root = await temporaryRoot();
    const host = new LocalProcessHost();
    const input = {
      executionId: "reserved-execution",
      executable: NodeProcess.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      workingDirectory: root,
      environment: { PATH: NodeProcess.env.PATH ?? "" },
    } as const;
    const first = host.start(input);
    await expect(host.start(input)).rejects.toThrow(/already active/u);
    const process = await first;
    await host.terminate(process.executionId);
    await process.completion;
  });

  it("pages persisted output only on UTF-8 character boundaries", async () => {
    const root = await temporaryRoot();
    const store = new CommandOutputStore({ stateRoot: NodePath.join(root, "state") });
    const capture = await store.createCapture("utf8-output", []);
    capture.stdout.write(Buffer.from("abc🙂z"));
    const artifact = await capture.stdout.close();
    await capture.stderr.close();

    const first = await store.readPage({ locationReference: artifact.locationReference, limit: 4 });
    expect(first).toEqual({ data: "abc", nextCursor: 3, end: false });
    const second = await store.readPage({
      locationReference: artifact.locationReference,
      cursor: first.nextCursor,
      limit: 4,
    });
    expect(second).toEqual({ data: "🙂", nextCursor: 7, end: false });
    const third = await store.readPage({
      locationReference: artifact.locationReference,
      cursor: second.nextCursor,
      limit: 4,
    });
    expect(third).toEqual({ data: "z", nextCursor: 8, end: true });
    await expect(
      store.readPage({ locationReference: artifact.locationReference, cursor: 4, limit: 4 }),
    ).rejects.toThrow(/UTF-8 boundary/u);
    await NodeFSP.writeFile(NodePath.join(root, "state", "unrelated.log"), "private");
    await expect(store.readPage({ locationReference: "unrelated.log" })).rejects.toThrow(
      /generated command output/u,
    );
  });

  it("runs arguments directly without shell interpretation", async () => {
    const root = await temporaryRoot();
    const runner = new DeterministicCommandRunner({ stateRoot: NodePath.join(root, "state") });
    const result = await runner.execute({
      definition: definition({
        args: ["-e", "console.log(process.argv[1])", "literal;touch SHOULD_NOT_EXIST"],
      }),
      executionRoot: root,
    });
    expect(result.outcome).toBe("passed");
    const page = await runner.outputStore.readPage({
      locationReference: result.stdout.locationReference,
    });
    expect(page.data).toContain("literal;touch SHOULD_NOT_EXIST");
    await expect(NodeFSP.stat(NodePath.join(root, "SHOULD_NOT_EXIST"))).rejects.toThrow();
  });

  it("redacts resolved environment values before persistence", async () => {
    const root = await temporaryRoot();
    const secret = "command-runner-secret-marker";
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      environment: { PATH: NodeProcess.env.PATH, SOURCE_SECRET: secret },
    });
    const result = await runner.execute({
      definition: definition({
        args: ["-e", "process.stdout.write(process.env.TARGET_SECRET)"],
        environment: [{ name: "TARGET_SECRET", source: "SOURCE_SECRET" }],
      }),
      executionRoot: root,
    });
    const page = await runner.outputStore.readPage({
      locationReference: result.stdout.locationReference,
    });
    expect(page.data).toBe("[REDACTED]");
    expect(page.data).not.toContain(secret);
  });

  it("redacts both output streams and never inherits the worker credential", async () => {
    const root = await temporaryRoot();
    const secret = "worker-credential-secret-marker";
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      environment: { PATH: NodeProcess.env.PATH, MKCODE_FACTORY_TOKEN: secret },
      redactionValues: [secret],
    });
    const result = await runner.execute({
      definition: definition({
        args: [
          "-e",
          "console.log(process.env.MKCODE_FACTORY_TOKEN); console.error('Bearer abcdefghijklmnop')",
        ],
      }),
      executionRoot: root,
    });
    const stdout = await runner.outputStore.readPage({
      locationReference: result.stdout.locationReference,
    });
    const stderr = await runner.outputStore.readPage({
      locationReference: result.stderr.locationReference,
    });
    expect(stdout.data.trim()).toBe("undefined");
    expect(stderr.data).not.toContain("abcdefghijklmnop");
  });

  it("rejects an explicit reference to a protected worker credential", async () => {
    const root = await temporaryRoot();
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      environment: { PATH: NodeProcess.env.PATH, MKCODE_FACTORY_TOKEN: "protected" },
    });
    await expect(
      runner.execute({
        definition: definition({
          environment: [{ name: "PROJECT_TOKEN", source: "MKCODE_FACTORY_TOKEN" }],
        }),
        executionRoot: root,
      }),
    ).rejects.toThrow("protected");
  });

  it("rejects a symlink working-directory escape", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await NodeFSP.symlink(outside, NodePath.join(root, "escape"));
    const runner = new DeterministicCommandRunner({ stateRoot: NodePath.join(root, "state") });
    await expect(
      runner.execute({
        definition: definition({ workingDirectory: "escape" }),
        executionRoot: root,
      }),
    ).rejects.toThrow("outside");
  });

  it("times out and terminates a process", async () => {
    const root = await temporaryRoot();
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      terminationGraceMilliseconds: 25,
    });
    const result = await runner.execute({
      definition: definition({
        args: ["-e", "setInterval(() => {}, 1000)"],
        timeoutSeconds: 1,
      }),
      executionRoot: root,
    });
    expect(result.outcome).toBe("timed_out");
    expect(result.timedOut).toBe(true);
  });

  it("terminates descendants in the command process group on Linux", async () => {
    if (NodeProcess.platform !== "linux") return;
    const root = await temporaryRoot();
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      terminationGraceMilliseconds: 25,
    });
    const childScript = "setInterval(() => {}, 1000)";
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' });`,
      "console.log(child.pid);",
      "setInterval(() => {}, 1000);",
    ].join("");
    const result = await runner.execute({
      definition: definition({
        args: ["-e", parentScript],
        timeoutSeconds: 1,
      }),
      executionRoot: root,
    });
    const page = await runner.outputStore.readPage({
      locationReference: result.stdout.locationReference,
    });
    const childPid = Number(page.data.trim());
    expect(Number.isSafeInteger(childPid)).toBe(true);
    let processState: string | undefined;
    try {
      processState = (await NodeFSP.readFile(`/proc/${childPid}/stat`, "utf8")).split(" ")[2];
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    expect(processState === undefined || processState === "Z").toBe(true);
  });

  it("cancels a running process", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      terminationGraceMilliseconds: 25,
    });
    const pending = runner.execute({
      definition: definition({
        args: ["-e", "setInterval(() => {}, 1000)"],
      }),
      executionRoot: root,
      signal: controller.signal,
      onStarted: () => controller.abort(),
    });
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled", cancelled: true });
  });

  it("enforces cancellation while launch persistence is unresolved", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      terminationGraceMilliseconds: 50,
    });
    const pending = runner.execute({
      definition: definition({ args: ["-e", "setInterval(() => {}, 1000)"] }),
      executionRoot: root,
      signal: controller.signal,
      onStarted: () => new Promise<void>(() => {}),
    });
    const timer = NodeTimers.setTimeout(() => controller.abort(), 50);
    await expect(pending).resolves.toMatchObject({ outcome: "cancelled", cancelled: true });
    NodeTimers.clearTimeout(timer);
  });

  it("bounds output and marks truncation", async () => {
    const root = await temporaryRoot();
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      maximumOutputBytesPerStream: 16,
    });
    const result = await runner.execute({
      definition: definition({
        args: ["-e", "process.stdout.write('abcdefghijklmnopqrstuvwxyz')"],
      }),
      executionRoot: root,
    });
    expect(result.stdout.persistedBytes).toBe(16);
    expect(result.stdout.truncated).toBe(true);
  });

  it("does not persist a secret when truncation falls near its boundary", async () => {
    const root = await temporaryRoot();
    const secret = "boundary-secret-value";
    const runner = new DeterministicCommandRunner({
      stateRoot: NodePath.join(root, "state"),
      environment: { PATH: NodeProcess.env.PATH, SOURCE_SECRET: secret },
      maximumOutputBytesPerStream: 18,
    });
    const result = await runner.execute({
      definition: definition({
        args: ["-e", "process.stdout.write('prefix-' + process.env.SECRET + '-suffix')"],
        environment: [{ name: "SECRET", source: "SOURCE_SECRET" }],
      }),
      executionRoot: root,
    });
    const page = await runner.outputStore.readPage({
      locationReference: result.stdout.locationReference,
    });
    expect(page.data).not.toContain(secret);
    expect(result.stdout.truncated).toBe(true);
  });
});

describe("CommandOutputStore", () => {
  it("creates private output directories and files", async () => {
    if (NodeProcess.platform === "win32") return;
    const root = await temporaryRoot();
    const store = new CommandOutputStore({ stateRoot: NodePath.join(root, "state") });
    const capture = await store.createCapture("execution-1", []);
    capture.stdout.write(Buffer.from("output"));
    const result = await capture.stdout.close();
    await capture.stderr.close();
    const directory = await NodeFSP.stat(
      NodePath.join(root, "state", "command-output", "execution-1"),
    );
    const file = await NodeFSP.stat(NodePath.join(root, "state", result.locationReference));
    expect(directory.mode & 0o777).toBe(0o700);
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("rejects symlinked state and escaping output references", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    const state = NodePath.join(root, "state");
    await NodeFSP.symlink(outside, state);
    const store = new CommandOutputStore({ stateRoot: state });
    await expect(store.createCapture("execution-1", [])).rejects.toThrow("real directory");
    await expect(store.readPage({ locationReference: "../outside-secret" })).rejects.toThrow(
      "escapes",
    );
  });
});
