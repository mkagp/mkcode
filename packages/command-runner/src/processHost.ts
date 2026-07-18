// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import type * as NodeStream from "node:stream";

export interface ProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ProcessStartInput {
  readonly executionId?: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly workingDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin?: string;
}

export interface HostedProcess {
  readonly executionId: string;
  readonly nativePid?: number;
  readonly stdout: NodeStream.Readable;
  readonly stderr: NodeStream.Readable;
  readonly completion: Promise<ProcessExit>;
}

export interface ProcessStatus {
  readonly state: "running" | "exited" | "unknown";
  readonly exitCode?: number | null;
  readonly signal?: NodeJS.Signals | null;
}

export interface ProcessHost {
  readonly type: string;
  start(input: ProcessStartInput): Promise<HostedProcess>;
  status(executionId: string): Promise<ProcessStatus>;
  interrupt(executionId: string): Promise<void>;
  terminate(executionId: string): Promise<void>;
}

interface LocalProcessRecord {
  readonly child: NodeChildProcess.ChildProcessByStdio<
    NodeStream.Writable,
    NodeStream.Readable,
    NodeStream.Readable
  >;
  readonly completion: Promise<ProcessExit>;
}

const signalChild = (record: LocalProcessRecord, signal: NodeJS.Signals): void => {
  if (record.child.exitCode !== null || record.child.signalCode !== null) return;
  try {
    if (NodeProcess.platform === "linux" && record.child.pid) {
      NodeProcess.kill(-record.child.pid, signal);
    } else {
      record.child.kill(signal);
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
};

export class LocalProcessHost implements ProcessHost {
  readonly type = "local";
  readonly #processes = new Map<string, LocalProcessRecord>();
  readonly #reservedExecutionIds = new Set<string>();

  async start(input: ProcessStartInput): Promise<HostedProcess> {
    if (input.executable.trim().length === 0) throw new TypeError("Executable must not be empty.");
    const executionId = input.executionId ?? NodeCrypto.randomUUID();
    if (this.#processes.has(executionId) || this.#reservedExecutionIds.has(executionId)) {
      throw new Error("Process-host execution ID is already active.");
    }
    this.#reservedExecutionIds.add(executionId);
    try {
      const child = NodeChildProcess.spawn(input.executable, [...input.args], {
        cwd: input.workingDirectory,
        env: { ...input.environment },
        shell: false,
        detached: NodeProcess.platform === "linux",
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const completion = new Promise<ProcessExit>((resolve) => {
        child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
      });
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          child.off("error", onError);
          resolve();
        };
        const onError = (cause: Error) => {
          child.off("spawn", onSpawn);
          reject(cause);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
      // A child may close stdin immediately after spawn. Keep a late EPIPE from becoming
      // an unhandled stream error; process completion remains the durable runtime result.
      child.stdin.on("error", () => undefined);
      child.stdin.end(input.stdin);
      const record = { child, completion };
      this.#processes.set(executionId, record);
      void completion.finally(() => {
        if (this.#processes.get(executionId) === record) {
          this.#processes.delete(executionId);
        }
      });
      return {
        executionId,
        ...(child.pid === undefined ? {} : { nativePid: child.pid }),
        stdout: child.stdout,
        stderr: child.stderr,
        completion,
      };
    } finally {
      this.#reservedExecutionIds.delete(executionId);
    }
  }

  async status(executionId: string): Promise<ProcessStatus> {
    const record = this.#processes.get(executionId);
    if (!record) return { state: "unknown" };
    if (record.child.exitCode === null && record.child.signalCode === null) {
      return { state: "running" };
    }
    return {
      state: "exited",
      exitCode: record.child.exitCode,
      signal: record.child.signalCode,
    };
  }

  async interrupt(executionId: string): Promise<void> {
    const record = this.#processes.get(executionId);
    if (record) signalChild(record, "SIGINT");
  }

  async terminate(executionId: string): Promise<void> {
    const record = this.#processes.get(executionId);
    if (record) signalChild(record, "SIGKILL");
  }
}
