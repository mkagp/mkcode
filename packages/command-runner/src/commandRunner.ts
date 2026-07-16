// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Command deadlines and termination grace use timers.
// @effect-diagnostics globalDate:off -- Durable wall-clock timestamps complement monotonic timers.
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";

import type { ResolvedProjectCheck, ResolvedProjectCommand } from "@mkcode/project-config/schema";

import { CommandOutputStore, type OutputArtifact } from "./outputStore.ts";
import { LocalProcessHost, type ProcessExit, type ProcessHost } from "./processHost.ts";

const DEFAULT_BASE_ENVIRONMENT = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;
const DEFAULT_TERMINATION_GRACE_MILLISECONDS = 2_000;
const MAX_COMMAND_TIMEOUT_SECONDS = 86_400;

export type ProjectCommandSnapshot = ResolvedProjectCommand | ResolvedProjectCheck;

export type CommandExecutionOutcome =
  | "passed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_failed"
  | "terminated";

export interface CommandExecutionResult {
  readonly outcome: CommandExecutionOutcome;
  readonly executionId: string;
  readonly workingDirectory: string;
  readonly processHostType: string;
  readonly nativePid?: number;
  readonly startedAt?: string;
  readonly completedAt: string;
  readonly timeoutDeadline?: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stdout: OutputArtifact;
  readonly stderr: OutputArtifact;
  readonly resolvedEnvironmentNames: ReadonlyArray<string>;
  readonly redactionCount: number;
  readonly spawnErrorCode?: string;
}

export interface CommandExecutionStarted {
  readonly executionId: string;
  readonly processHostType: string;
  readonly nativePid?: number;
  readonly startedAt: string;
  readonly timeoutDeadline: string;
  readonly workingDirectory: string;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = NodeTimers.setTimeout(resolve, milliseconds);
    timer.unref();
  });

const canonicalDirectory = async (executionRoot: string, configuredDirectory: string) => {
  if (NodePath.isAbsolute(configuredDirectory)) {
    throw new TypeError("Command working directory must be relative.");
  }
  const root = await NodeFSP.realpath(executionRoot);
  const rootStat = await NodeFSP.stat(root);
  if (!rootStat.isDirectory()) throw new TypeError("Execution root must be a directory.");
  const lexical = NodePath.resolve(root, configuredDirectory);
  const lexicalRelative = NodePath.relative(root, lexical);
  if (
    lexicalRelative === ".." ||
    lexicalRelative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(lexicalRelative)
  ) {
    throw new TypeError("Command working directory escapes the execution root.");
  }
  const resolved = await NodeFSP.realpath(lexical);
  const relative = NodePath.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  ) {
    throw new TypeError("Command working directory resolves outside the execution root.");
  }
  const stat = await NodeFSP.stat(resolved);
  if (!stat.isDirectory()) throw new TypeError("Command working directory must be a directory.");
  return { root, workingDirectory: resolved };
};

export class DeterministicCommandRunner {
  readonly #host: ProcessHost;
  readonly #outputStore: CommandOutputStore;
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #protectedEnvironmentSources: ReadonlySet<string>;
  readonly #redactionValues: ReadonlyArray<string>;
  readonly #terminationGraceMilliseconds: number;

  constructor(input: {
    readonly stateRoot: string;
    readonly processHost?: ProcessHost;
    readonly environment?: Readonly<NodeJS.ProcessEnv>;
    readonly protectedEnvironmentSources?: ReadonlySet<string>;
    readonly redactionValues?: ReadonlyArray<string>;
    readonly terminationGraceMilliseconds?: number;
    readonly maximumOutputBytesPerStream?: number;
  }) {
    this.#host = input.processHost ?? new LocalProcessHost();
    this.#outputStore = new CommandOutputStore({
      stateRoot: input.stateRoot,
      ...(input.maximumOutputBytesPerStream === undefined
        ? {}
        : { maximumBytesPerStream: input.maximumOutputBytesPerStream }),
    });
    this.#environment = input.environment ?? process.env;
    this.#protectedEnvironmentSources = new Set([
      "MKCODE_FACTORY_TOKEN",
      ...(input.protectedEnvironmentSources ?? []),
    ]);
    this.#redactionValues = input.redactionValues ?? [];
    this.#terminationGraceMilliseconds =
      input.terminationGraceMilliseconds ?? DEFAULT_TERMINATION_GRACE_MILLISECONDS;
  }

  get outputStore(): CommandOutputStore {
    return this.#outputStore;
  }

  async execute(input: {
    readonly executionId?: string;
    readonly definition: ProjectCommandSnapshot;
    readonly executionRoot: string;
    readonly signal?: AbortSignal;
    readonly onStarted?: (started: CommandExecutionStarted) => void | Promise<void>;
  }): Promise<CommandExecutionResult> {
    if (input.definition.executable.trim().length === 0) {
      throw new TypeError("Executable must not be empty.");
    }
    if (
      !Number.isSafeInteger(input.definition.timeoutSeconds) ||
      input.definition.timeoutSeconds < 1 ||
      input.definition.timeoutSeconds > MAX_COMMAND_TIMEOUT_SECONDS
    ) {
      throw new TypeError(
        `Command timeout must be an integer between 1 and ${MAX_COMMAND_TIMEOUT_SECONDS}.`,
      );
    }
    const { root, workingDirectory } = await canonicalDirectory(
      input.executionRoot,
      input.definition.workingDirectory,
    );
    const environment: Record<string, string> = {};
    for (const name of DEFAULT_BASE_ENVIRONMENT) {
      const value = this.#environment[name];
      if (value !== undefined) environment[name] = value;
    }
    const resolvedSecrets: Array<string> = [];
    const resolvedEnvironmentNames: Array<string> = [];
    for (const reference of input.definition.environment) {
      if (this.#protectedEnvironmentSources.has(reference.source)) {
        throw new TypeError("A protected worker environment source cannot be forwarded.");
      }
      const value = this.#environment[reference.source];
      if (value === undefined) {
        throw new TypeError(`Required environment reference '${reference.source}' is unavailable.`);
      }
      environment[reference.name] = value;
      resolvedEnvironmentNames.push(reference.name);
      if (value.length > 0) resolvedSecrets.push(value);
    }
    const executionId = input.executionId ?? NodeCrypto.randomUUID();
    const capture = await this.#outputStore.createCapture(executionId, [
      ...resolvedSecrets,
      ...this.#redactionValues,
    ]);
    const completedAt = () => new Date().toISOString();
    const closeArtifacts = async () => {
      const [stdout, stderr] = await Promise.allSettled([
        capture.stdout.close(),
        capture.stderr.close(),
      ]);
      if (stdout.status === "rejected") throw stdout.reason;
      if (stderr.status === "rejected") throw stderr.reason;
      return { stdout: stdout.value, stderr: stderr.value };
    };
    if (input.signal?.aborted) {
      const artifacts = await closeArtifacts();
      return {
        outcome: "cancelled",
        executionId,
        workingDirectory,
        processHostType: this.#host.type,
        completedAt: completedAt(),
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: true,
        ...artifacts,
        resolvedEnvironmentNames,
        redactionCount: resolvedSecrets.length + this.#redactionValues.length,
      };
    }

    let hosted;
    let launchedWorkingDirectory = workingDirectory;
    try {
      // Re-resolve immediately before spawn to narrow the path replacement window.
      const immediate = await canonicalDirectory(root, input.definition.workingDirectory);
      hosted = await this.#host.start({
        executionId,
        executable: input.definition.executable,
        args: input.definition.args,
        workingDirectory: immediate.workingDirectory,
        environment,
      });
      launchedWorkingDirectory = immediate.workingDirectory;
    } catch (cause) {
      const artifacts = await closeArtifacts();
      return {
        outcome: "spawn_failed",
        executionId,
        workingDirectory,
        processHostType: this.#host.type,
        completedAt: completedAt(),
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        ...artifacts,
        resolvedEnvironmentNames,
        redactionCount: resolvedSecrets.length + this.#redactionValues.length,
        ...((cause as NodeJS.ErrnoException).code
          ? { spawnErrorCode: String((cause as NodeJS.ErrnoException).code) }
          : {}),
      };
    }

    hosted.stdout.on("data", (chunk: Buffer) => capture.stdout.write(chunk));
    hosted.stderr.on("data", (chunk: Buffer) => capture.stderr.write(chunk));
    const startedAt = new Date();
    const timeoutMilliseconds = input.definition.timeoutSeconds * 1_000;
    const timeoutDeadline = new Date(startedAt.getTime() + timeoutMilliseconds).toISOString();
    let timeout: ReturnType<typeof NodeTimers.setTimeout> | undefined;
    let removeAbort = () => {};
    const control = new Promise<"timed_out" | "cancelled">((resolve) => {
      timeout = NodeTimers.setTimeout(() => resolve("timed_out"), timeoutMilliseconds);
      timeout.unref();
      if (input.signal?.aborted) {
        resolve("cancelled");
      } else if (input.signal) {
        const onAbort = () => resolve("cancelled");
        input.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => input.signal?.removeEventListener("abort", onAbort);
      }
    });
    const started = Promise.resolve()
      .then(() =>
        input.onStarted?.({
          executionId,
          processHostType: this.#host.type,
          ...(hosted.nativePid === undefined ? {} : { nativePid: hosted.nativePid }),
          startedAt: startedAt.toISOString(),
          timeoutDeadline,
          workingDirectory: launchedWorkingDirectory,
        }),
      )
      .then(
        () => ({ kind: "started" as const }),
        (cause: unknown) => ({ kind: "start_failed" as const, cause }),
      );
    const processCompletion = hosted.completion.then((exit) => ({ kind: "exit" as const, exit }));
    const startGate = await Promise.race([
      started,
      processCompletion,
      control.then((reason) => ({ kind: "control" as const, reason })),
    ]);
    if (startGate.kind === "start_failed") {
      if (timeout) NodeTimers.clearTimeout(timeout);
      removeAbort();
      await this.#host.interrupt(executionId);
      const settled = await Promise.race([
        hosted.completion.then(() => true),
        wait(this.#terminationGraceMilliseconds).then(() => false),
      ]);
      if (!settled) {
        await this.#host.terminate(executionId);
        await hosted.completion;
      }
      await closeArtifacts();
      throw startGate.cause;
    }

    let first:
      | { readonly kind: "exit"; readonly exit: ProcessExit }
      | { readonly kind: "control"; readonly reason: "timed_out" | "cancelled" };
    if (startGate.kind === "exit") {
      const persistedStart = await Promise.race([
        started,
        control.then(() => ({ kind: "control" as const })),
      ]);
      if (persistedStart.kind === "start_failed") {
        if (timeout) NodeTimers.clearTimeout(timeout);
        removeAbort();
        await closeArtifacts();
        throw persistedStart.cause;
      }
      first = startGate;
    } else if (startGate.kind === "control") {
      first = startGate;
    } else {
      first = await Promise.race([
        processCompletion,
        control.then((reason) => ({ kind: "control" as const, reason })),
      ]);
    }

    let exit: ProcessExit;
    let forcedOutcome: "timed_out" | "cancelled" | undefined;
    if (first.kind === "exit") {
      exit = first.exit;
    } else {
      forcedOutcome = first.reason;
      await this.#host.interrupt(executionId);
      const graceful = await Promise.race([
        hosted.completion.then((value) => ({ settled: true as const, value })),
        wait(this.#terminationGraceMilliseconds).then(() => ({ settled: false as const })),
      ]);
      if (graceful.settled) {
        exit = graceful.value;
      } else {
        await this.#host.terminate(executionId);
        exit = await hosted.completion;
      }
    }
    if (timeout) NodeTimers.clearTimeout(timeout);
    removeAbort();
    const artifacts = await closeArtifacts();
    const outcome =
      forcedOutcome ??
      (exit.signal !== null ? "terminated" : exit.exitCode === 0 ? "passed" : "failed");
    return {
      outcome,
      executionId,
      workingDirectory: launchedWorkingDirectory,
      processHostType: this.#host.type,
      ...(hosted.nativePid === undefined ? {} : { nativePid: hosted.nativePid }),
      startedAt: startedAt.toISOString(),
      completedAt: completedAt(),
      timeoutDeadline,
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut: outcome === "timed_out",
      cancelled: outcome === "cancelled",
      ...artifacts,
      resolvedEnvironmentNames,
      redactionCount: resolvedSecrets.length + this.#redactionValues.length,
    };
  }
}
