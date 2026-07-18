// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off -- Durable runtime evidence uses wall-clock timestamps.
// @effect-diagnostics globalTimers:off -- Runtime timeout and cancellation grace are bounded timers.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeTimers from "node:timers";

import {
  CommandOutputStore,
  LocalProcessHost,
  type HostedProcess,
  type ProcessHost,
  StreamingRedactor,
} from "@mkcode/command-runner";

import {
  AgentRuntimeError,
  type AgentReconciliationResult,
  type AgentResultEnvelope,
  type AgentRuntime,
  type AgentRuntimeCompletion,
  type AgentRuntimeEvent,
  type AgentRuntimeEventPage,
  type AgentRuntimeStatus,
  type AgentSessionReference,
  type StartedAgentSession,
  type StartAgentInput,
} from "./contracts.ts";
import { validateBuilderTaskEnvelope } from "./taskEnvelope.ts";

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const START_TIMEOUT_MILLISECONDS = 15_000;
const TERMINATION_GRACE_MILLISECONDS = 2_000;
const MAX_EVENT_BUFFER_BYTES = 1_048_576;
const MAX_RETAINED_EVENT_BYTES = 262_144;
const MAX_RETAINED_EVENT_COUNT = 2_048;
const SAFE_EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const resultSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  required: [
    "status",
    "summary",
    "claimedChangedPaths",
    "claimedTestsChanged",
    "unresolvedIssues",
    "questionsOrBlockers",
  ],
  properties: {
    status: { type: "string", enum: ["completed", "blocked"] },
    summary: { type: "string" },
    claimedChangedPaths: { type: "array", items: { type: "string" } },
    claimedTestsChanged: { type: "array", items: { type: "string" } },
    unresolvedIssues: { type: "array", items: { type: "string" } },
    questionsOrBlockers: { type: "array", items: { type: "string" } },
  },
} as const;

interface CodexStructuredResult {
  readonly status: "completed" | "blocked";
  readonly summary: string;
  readonly claimedChangedPaths: ReadonlyArray<string>;
  readonly claimedTestsChanged: ReadonlyArray<string>;
  readonly unresolvedIssues: ReadonlyArray<string>;
  readonly questionsOrBlockers: ReadonlyArray<string>;
}

interface ActiveRecord {
  readonly input: StartAgentInput;
  readonly hosted: HostedProcess;
  readonly startedAt: string;
  readonly timeoutDeadline: string;
  readonly stdoutReference: string;
  readonly stderrReference: string;
  readonly events: Array<AgentRuntimeEvent>;
  eventCursor: number;
  eventBytes: number;
  completion?: Promise<AgentRuntimeCompletion>;
  nativeSessionId?: string;
  finalMessage?: string;
  turnCompleted: boolean;
  protocolFailed: boolean;
  stopReason?: "cancelled" | "timed_out";
  timeout?: ReturnType<typeof NodeTimers.setTimeout>;
}

const nowIso = (): string => new Date().toISOString();

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentRuntimeError("runtime_start_failed", "Agent control path is unsafe.");
  }
  await NodeFSP.chmod(path, 0o700);
};

const readPrivateJson = async (path: string, maximumBytes = 1_048_576): Promise<unknown> => {
  const stat = await NodeFSP.lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) {
    throw new AgentRuntimeError("runtime_ambiguous", "Agent control file is unsafe.");
  }
  await NodeFSP.chmod(path, 0o600);
  return JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
};

const writePrivateJson = async (path: string, value: unknown): Promise<void> => {
  const temporaryPath = `${path}.tmp-${NodeCrypto.randomUUID()}`;
  const handle = await NodeFSP.open(
    temporaryPath,
    NodeFS.constants.O_CREAT |
      NodeFS.constants.O_EXCL |
      NodeFS.constants.O_WRONLY |
      (NodeFS.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (cause) {
    await NodeFSP.rm(temporaryPath, { force: true });
    throw cause;
  } finally {
    await handle.close();
  }
  try {
    await NodeFSP.link(temporaryPath, path);
    const directory = await NodeFSP.open(NodePath.dirname(path), NodeFS.constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const existing = await readPrivateJson(path);
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      throw new AgentRuntimeError(
        "runtime_ambiguous",
        "Existing agent control evidence conflicts with the requested value.",
      );
    }
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true });
  }
};

const safeEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> => {
  const allowed = [
    "PATH",
    "HOME",
    "CODEX_HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ] as const;
  const result: Record<string, string> = { NO_COLOR: "1", TERM: "dumb" };
  for (const name of allowed) {
    const value = environment[name];
    if (value !== undefined && value.length > 0) result[name] = value;
  }
  return result;
};

const redactString = (value: string, secrets: ReadonlyArray<string>): string => {
  const redactor = new StreamingRedactor(secrets);
  return redactor.push(Buffer.from(value)) + redactor.finish();
};

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseStructuredResult = (
  value: string | undefined,
  secrets: ReadonlyArray<string>,
): CodexStructuredResult | undefined => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      !["completed", "blocked"].includes(String(parsed.status)) ||
      typeof parsed.summary !== "string" ||
      !isStringArray(parsed.claimedChangedPaths) ||
      !isStringArray(parsed.claimedTestsChanged) ||
      !isStringArray(parsed.unresolvedIssues) ||
      !isStringArray(parsed.questionsOrBlockers)
    ) {
      return undefined;
    }
    const redactArray = (items: ReadonlyArray<string>) =>
      items.map((item) => redactString(item, secrets));
    return {
      status: parsed.status as "completed" | "blocked",
      summary: redactString(parsed.summary, secrets),
      claimedChangedPaths: redactArray(parsed.claimedChangedPaths),
      claimedTestsChanged: redactArray(parsed.claimedTestsChanged),
      unresolvedIssues: redactArray(parsed.unresolvedIssues),
      questionsOrBlockers: redactArray(parsed.questionsOrBlockers),
    };
  } catch {
    return undefined;
  }
};

const asObject = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isOutputArtifact = (value: unknown): boolean => {
  const artifact = asObject(value);
  return (
    artifact !== undefined &&
    typeof artifact.locationReference === "string" &&
    typeof artifact.digest === "string" &&
    typeof artifact.observedBytes === "number" &&
    typeof artifact.persistedBytes === "number" &&
    typeof artifact.truncated === "boolean"
  );
};

const isRuntimeCompletion = (value: unknown): value is AgentRuntimeCompletion => {
  const completion = asObject(value);
  const result = asObject(completion?.result);
  return (
    completion !== undefined &&
    ["completed", "failed", "cancelled", "timed_out", "blocked"].includes(
      String(completion.outcome),
    ) &&
    (completion.exitCode === null || typeof completion.exitCode === "number") &&
    (completion.signal === null || typeof completion.signal === "string") &&
    result !== undefined &&
    result.version === 1 &&
    typeof result.agentRunId === "string" &&
    typeof result.runtimeSessionReference === "string" &&
    typeof result.status === "string" &&
    typeof result.summary === "string" &&
    isOutputArtifact(completion.stdout) &&
    isOutputArtifact(completion.stderr)
  );
};

const isRuntimeEvent = (value: unknown): value is AgentRuntimeEvent => {
  const event = asObject(value);
  const metadata = asObject(event?.metadata);
  return (
    event !== undefined &&
    Number.isSafeInteger(event.cursor) &&
    Number(event.cursor) > 0 &&
    typeof event.type === "string" &&
    typeof event.timestamp === "string" &&
    metadata !== undefined &&
    Object.values(metadata).every((item) => ["string", "number", "boolean"].includes(typeof item))
  );
};

const isRuntimeEventPage = (value: unknown): value is AgentRuntimeEventPage => {
  const page = asObject(value);
  return (
    page !== undefined &&
    Array.isArray(page.events) &&
    page.events.every(isRuntimeEvent) &&
    Number.isSafeInteger(page.nextCursor) &&
    Number(page.nextCursor) >= 0
  );
};

const normalizedEvent = (event: Record<string, unknown>): Record<string, unknown> => {
  const type = typeof event.type === "string" ? event.type : "runtime.unknown";
  if (type === "item.completed") {
    const item = asObject(event.item);
    const itemType = typeof item?.type === "string" ? item.type : "unknown";
    if (itemType === "agent_message") {
      return { type, item: { type: itemType, structuredResultAvailable: true } };
    }
    if (itemType === "command_execution") {
      return {
        type,
        item: {
          type: itemType,
          ...(typeof item?.command === "string" ? { command: item.command } : {}),
          ...(typeof item?.exit_code === "number" ? { exitCode: item.exit_code } : {}),
          ...(typeof item?.status === "string" ? { status: item.status } : {}),
        },
      };
    }
    return { type, item: { type: itemType } };
  }
  if (type === "thread.started" && typeof event.thread_id === "string") {
    return { type, threadId: event.thread_id };
  }
  if (type === "turn.completed") return { type, usageAvailable: event.usage !== undefined };
  if (type === "error") {
    return { type, message: typeof event.message === "string" ? event.message : "runtime error" };
  }
  return { type };
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = NodeTimers.setTimeout(resolve, milliseconds);
    timer.unref();
  });

const matchesActiveSession = (record: ActiveRecord, session: AgentSessionReference): boolean =>
  session.runtimeKind === "codex" &&
  record.input.executionId === session.executionId &&
  record.nativeSessionId === session.nativeSessionId &&
  record.input.workingDirectory === session.workingDirectory &&
  record.stdoutReference === session.stdoutArtifactReference &&
  record.stderrReference === session.stderrArtifactReference;

const matchesCompletion = (
  completion: AgentRuntimeCompletion,
  session: AgentSessionReference,
): boolean =>
  session.runtimeKind === "codex" &&
  completion.result.runtimeSessionReference === session.nativeSessionId &&
  completion.stdout.locationReference === session.stdoutArtifactReference &&
  completion.stderr.locationReference === session.stderrArtifactReference;

export class CodexAgentRuntime implements AgentRuntime {
  readonly kind = "codex" as const;
  readonly capabilities = {
    structuredEvents: true,
    structuredResult: true,
    cancellation: true,
    timeout: true,
    nativeSessionIdentity: true,
    liveResumeObservation: false,
  } as const;
  readonly outputStore: CommandOutputStore;
  readonly #stateRoot: string;
  readonly #controlRoot: string;
  readonly #host: ProcessHost;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #executable: string;
  readonly #active = new Map<string, ActiveRecord>();

  constructor(input: {
    readonly stateRoot: string;
    readonly processHost?: ProcessHost;
    readonly environment?: NodeJS.ProcessEnv;
    readonly executable?: string;
    readonly maximumOutputBytesPerStream?: number;
  }) {
    this.#stateRoot = NodePath.resolve(input.stateRoot);
    this.#controlRoot = NodePath.join(this.#stateRoot, "agent-control");
    this.#host = input.processHost ?? new LocalProcessHost();
    this.#environment = input.environment ?? NodeProcess.env;
    this.#executable = input.executable ?? "codex";
    this.outputStore = new CommandOutputStore({
      stateRoot: this.#stateRoot,
      outputDirectoryName: "agent-output",
      ...(input.maximumOutputBytesPerStream === undefined
        ? {}
        : { maximumBytesPerStream: input.maximumOutputBytesPerStream }),
    });
  }

  outputReferences(executionId: string): { readonly stdout: string; readonly stderr: string } {
    return this.outputStore.referencesFor(executionId);
  }

  async start(input: StartAgentInput): Promise<StartedAgentSession> {
    const task = validateBuilderTaskEnvelope(input.task);
    if (
      input.runtimeConfiguration.kind !== "codex" ||
      input.runtimeConfiguration.executable !== "codex"
    ) {
      throw new AgentRuntimeError(
        "invalid_configuration",
        "Codex runtime configuration is invalid.",
      );
    }
    if (input.runtimeConfiguration.model && !MODEL.test(input.runtimeConfiguration.model)) {
      throw new AgentRuntimeError("invalid_configuration", "Codex model identifier is invalid.");
    }
    if (!SAFE_EXECUTION_ID.test(input.executionId)) {
      throw new AgentRuntimeError("invalid_configuration", "Agent execution ID is unsafe.");
    }
    const workingDirectory = await NodeFSP.realpath(input.workingDirectory);
    const worktree = await NodeFSP.realpath(task.worktreePathReference);
    const stat = await NodeFSP.lstat(input.workingDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || workingDirectory !== worktree) {
      throw new AgentRuntimeError(
        "invalid_configuration",
        "Agent working directory must be the canonical workflow worktree.",
      );
    }
    await ensurePrivateDirectory(this.#stateRoot);
    await ensurePrivateDirectory(this.#controlRoot);
    const executionControl = NodePath.join(this.#controlRoot, input.executionId);
    await ensurePrivateDirectory(executionControl);
    const schemaPath = NodePath.join(executionControl, "result.schema.json");
    await writePrivateJson(schemaPath, resultSchema);
    const capture = await this.outputStore.createCapture(input.executionId, input.redactionValues);
    const references = this.outputStore.referencesFor(input.executionId);
    const args = [
      "exec",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "--sandbox",
      "workspace-write",
      "--cd",
      workingDirectory,
      "--output-schema",
      schemaPath,
      "--color",
      "never",
      ...(input.runtimeConfiguration.model ? ["--model", input.runtimeConfiguration.model] : []),
      "-",
    ];
    let hosted: HostedProcess;
    try {
      hosted = await this.#host.start({
        executionId: input.executionId,
        executable: this.#executable,
        args,
        workingDirectory,
        environment: safeEnvironment(this.#environment),
        stdin: input.prompt,
      });
    } catch (cause) {
      await Promise.allSettled([capture.stdout.close(), capture.stderr.close()]);
      throw new AgentRuntimeError(
        (cause as NodeJS.ErrnoException).code === "ENOENT"
          ? "runtime_unavailable"
          : "runtime_start_failed",
        (cause as NodeJS.ErrnoException).code === "ENOENT"
          ? "Codex executable is unavailable."
          : "Codex runtime could not start.",
      );
    }
    const startedAt = nowIso();
    const timeoutDeadline = new Date(Date.now() + task.maximumRuntimeSeconds * 1_000).toISOString();
    const active: ActiveRecord = {
      input: { ...input, workingDirectory },
      hosted,
      startedAt,
      timeoutDeadline,
      stdoutReference: references.stdout,
      stderrReference: references.stderr,
      events: [],
      eventCursor: 0,
      eventBytes: 0,
      turnCompleted: false,
      protocolFailed: false,
    };
    active.completion = this.#monitor(active, capture);
    this.#active.set(input.executionId, active);
    active.timeout = NodeTimers.setTimeout(() => {
      void this.#requestStop(active, "timed_out");
    }, task.maximumRuntimeSeconds * 1_000);
    active.timeout.unref();
    const receipt = await Promise.race([
      this.#waitForSession(active),
      active.completion.then(() => undefined),
      delay(START_TIMEOUT_MILLISECONDS).then(() => undefined),
    ]);
    const sessionId = receipt ?? active.nativeSessionId;
    if (!sessionId) {
      await this.#requestStop(active, "cancelled");
      throw new AgentRuntimeError(
        "runtime_protocol_error",
        "Codex did not provide a native session receipt before startup completed.",
      );
    }
    return {
      session: {
        runtimeKind: "codex",
        executionId: input.executionId,
        nativeSessionId: sessionId,
        workingDirectory,
        stdoutArtifactReference: references.stdout,
        stderrArtifactReference: references.stderr,
        ...(hosted.nativePid === undefined ? {} : { nativePid: hosted.nativePid }),
      },
      startedAt,
      timeoutDeadline,
    };
  }

  async status(session: AgentSessionReference): Promise<AgentRuntimeStatus> {
    const completion = await this.result(session);
    if (completion) return { state: "completed", result: completion };
    const active = this.#active.get(session.executionId);
    if (active) return { state: "running" };
    return { state: "unknown" };
  }

  async wait(session: AgentSessionReference): Promise<AgentRuntimeCompletion> {
    const active = this.#active.get(session.executionId);
    if (!active || !matchesActiveSession(active, session)) {
      const recovered = await this.#readCompletion(session.executionId);
      if (recovered && matchesCompletion(recovered, session)) return recovered;
      throw new AgentRuntimeError(
        "runtime_session_not_found",
        "Agent runtime session is unavailable.",
      );
    }
    if (!active.completion) {
      throw new AgentRuntimeError("runtime_ambiguous", "Agent completion monitor is unavailable.");
    }
    return active.completion;
  }

  async cancel(session: AgentSessionReference, _reason: string): Promise<void> {
    const active = this.#active.get(session.executionId);
    if (!active || !matchesActiveSession(active, session)) return;
    await this.#requestStop(active, "cancelled");
  }

  async reconcile(session: AgentSessionReference): Promise<AgentReconciliationResult> {
    const completion = await this.#readCompletion(session.executionId);
    if (completion && matchesCompletion(completion, session)) {
      return { state: "completed", completion };
    }
    const active = this.#active.get(session.executionId);
    if (active && matchesActiveSession(active, session)) return { state: "running" };
    return {
      state: "ambiguous",
      reason: "Local Codex process ownership cannot be proven after worker restart.",
    };
  }

  async events(session: AgentSessionReference, cursor = 0): Promise<AgentRuntimeEventPage> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new AgentRuntimeError("invalid_configuration", "Agent event cursor is invalid.");
    }
    const active = this.#active.get(session.executionId);
    if (active && !matchesActiveSession(active, session)) {
      throw new AgentRuntimeError(
        "runtime_session_not_found",
        "Agent runtime session is unavailable.",
      );
    }
    const completion = active ? undefined : await this.#readCompletion(session.executionId);
    if (!active && (!completion || !matchesCompletion(completion, session))) {
      throw new AgentRuntimeError(
        "runtime_session_not_found",
        "Agent runtime session is unavailable.",
      );
    }
    const persistedEvents = active ? undefined : await this.#readEvents(session.executionId);
    const events = (active?.events ?? persistedEvents?.events ?? []).filter(
      (event) => event.cursor > cursor,
    );
    return { events, nextCursor: events.at(-1)?.cursor ?? cursor };
  }

  async result(session: AgentSessionReference): Promise<AgentRuntimeCompletion | null> {
    const persisted = await this.#readCompletion(session.executionId);
    if (persisted) {
      if (!matchesCompletion(persisted, session)) {
        throw new AgentRuntimeError(
          "runtime_session_not_found",
          "Agent runtime session is unavailable.",
        );
      }
      return persisted;
    }
    const active = this.#active.get(session.executionId);
    if (active && matchesActiveSession(active, session)) {
      const hostStatus = await this.#host.status(session.executionId);
      if (hostStatus.state === "running") return null;
      return active.completion ?? null;
    }
    if (active)
      throw new AgentRuntimeError(
        "runtime_session_not_found",
        "Agent runtime session is unavailable.",
      );
    return null;
  }

  async #monitor(
    record: ActiveRecord,
    capture: Awaited<ReturnType<CommandOutputStore["createCapture"]>>,
  ): Promise<AgentRuntimeCompletion> {
    const stdoutDone = this.#consumeStdout(record, capture.stdout);
    const stderrDone = (async () => {
      for await (const chunk of record.hosted.stderr) capture.stderr.write(Buffer.from(chunk));
    })();
    const [exit] = await Promise.all([record.hosted.completion, stdoutDone, stderrDone]);
    if (record.timeout) NodeTimers.clearTimeout(record.timeout);
    const [stdout, stderr] = await Promise.all([capture.stdout.close(), capture.stderr.close()]);
    const structured = parseStructuredResult(record.finalMessage, record.input.redactionValues);
    const completedAt = nowIso();
    const outcome =
      record.stopReason === "timed_out"
        ? "timed_out"
        : record.stopReason === "cancelled"
          ? "cancelled"
          : exit.exitCode === 0 && record.turnCompleted && !record.protocolFailed && structured
            ? structured.status
            : "failed";
    const result: AgentResultEnvelope = {
      version: 1,
      agentRunId: record.input.task.agentRunId,
      runtimeSessionReference: record.nativeSessionId ?? "unconfirmed",
      status: outcome,
      summary: structured?.summary ?? "Codex did not return a valid structured result.",
      claimedChangedPaths: structured?.claimedChangedPaths ?? [],
      claimedTestsChanged: structured?.claimedTestsChanged ?? [],
      unresolvedIssues: structured?.unresolvedIssues ?? [],
      questionsOrBlockers: structured?.questionsOrBlockers ?? [],
      runtimeCompletionReason:
        record.stopReason ?? (record.turnCompleted ? "turn_completed" : "process_exited"),
      nativeSessionMetadata: { runtime: "codex", protocol: "exec-jsonl" },
      startedAt: record.startedAt,
      completedAt,
    };
    const completion: AgentRuntimeCompletion = {
      outcome,
      result,
      exitCode: exit.exitCode,
      signal: exit.signal,
      stdout,
      stderr,
    };
    this.#appendEvent(record, `agent.${outcome}`, { exitCode: exit.exitCode ?? -1 });
    await this.#writeEvents(record.input.executionId, {
      events: record.events,
      nextCursor: record.eventCursor,
    });
    await this.#writeCompletion(record.input.executionId, completion);
    if (this.#active.get(record.input.executionId) === record) {
      this.#active.delete(record.input.executionId);
      delete record.finalMessage;
      record.events.splice(0);
      record.eventBytes = 0;
    }
    return completion;
  }

  async #consumeStdout(
    record: ActiveRecord,
    capture: Awaited<ReturnType<CommandOutputStore["createCapture"]>>["stdout"],
  ): Promise<void> {
    let buffer = "";
    const decoder = new NodeStringDecoder.StringDecoder("utf8");
    for await (const chunk of record.hosted.stdout) {
      buffer += decoder.write(Buffer.from(chunk));
      if (Buffer.byteLength(buffer) > MAX_EVENT_BUFFER_BYTES) {
        record.protocolFailed = true;
        capture.write(Buffer.from(`${JSON.stringify({ type: "runtime.event_too_large" })}\n`));
        buffer = "";
        continue;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) this.#consumeEventLine(record, capture, line);
        newline = buffer.indexOf("\n");
      }
    }
    buffer += decoder.end();
    const final = buffer.trim();
    if (final.length > 0) this.#consumeEventLine(record, capture, final);
  }

  #consumeEventLine(
    record: ActiveRecord,
    capture: Awaited<ReturnType<CommandOutputStore["createCapture"]>>["stdout"],
    line: string,
  ): void {
    let event: Record<string, unknown>;
    try {
      event = asObject(JSON.parse(line)) ?? { type: "runtime.invalid_event" };
    } catch {
      record.protocolFailed = true;
      event = { type: "runtime.invalid_json" };
    }
    const type = typeof event.type === "string" ? event.type : "runtime.unknown";
    if (type === "thread.started" && typeof event.thread_id === "string") {
      record.nativeSessionId = event.thread_id;
    }
    if (type === "turn.completed") record.turnCompleted = true;
    if (type === "item.completed") {
      const item = asObject(event.item);
      if (item?.type === "agent_message" && typeof item.text === "string") {
        record.finalMessage = item.text;
      }
    }
    const normalized = normalizedEvent(event);
    capture.write(Buffer.from(`${JSON.stringify(normalized)}\n`));
    this.#appendEvent(record, type, {});
  }

  #appendEvent(
    record: ActiveRecord,
    type: string,
    metadata: Readonly<Record<string, string | number | boolean>>,
  ): void {
    const event = {
      cursor: (record.eventCursor += 1),
      type,
      timestamp: nowIso(),
      metadata,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    record.events.push(event);
    record.eventBytes += bytes;
    while (
      record.events.length > MAX_RETAINED_EVENT_COUNT ||
      record.eventBytes > MAX_RETAINED_EVENT_BYTES
    ) {
      const removed = record.events.shift();
      if (!removed) break;
      record.eventBytes -= Buffer.byteLength(JSON.stringify(removed));
    }
  }

  async #waitForSession(record: ActiveRecord): Promise<string> {
    while (!record.nativeSessionId) {
      const status = await this.#host.status(record.input.executionId);
      if (status.state !== "running") return "";
      await delay(10);
    }
    return record.nativeSessionId;
  }

  async #requestStop(record: ActiveRecord, reason: "cancelled" | "timed_out"): Promise<void> {
    record.stopReason ??= reason;
    await this.#host.interrupt(record.input.executionId);
    const finished = await Promise.race([
      record.completion?.then(() => true) ?? Promise.resolve(false),
      delay(TERMINATION_GRACE_MILLISECONDS).then(() => false),
    ]);
    if (!finished) await this.#host.terminate(record.input.executionId);
  }

  #completionPath(executionId: string): string {
    if (!SAFE_EXECUTION_ID.test(executionId)) {
      throw new AgentRuntimeError("invalid_configuration", "Agent execution ID is unsafe.");
    }
    return NodePath.join(this.#controlRoot, executionId, "completion.json");
  }

  #eventsPath(executionId: string): string {
    if (!SAFE_EXECUTION_ID.test(executionId)) {
      throw new AgentRuntimeError("invalid_configuration", "Agent execution ID is unsafe.");
    }
    return NodePath.join(this.#controlRoot, executionId, "events.json");
  }

  async #writeCompletion(executionId: string, completion: AgentRuntimeCompletion): Promise<void> {
    const path = this.#completionPath(executionId);
    await writePrivateJson(path, completion);
  }

  async #readCompletion(executionId: string): Promise<AgentRuntimeCompletion | undefined> {
    try {
      const path = this.#completionPath(executionId);
      const value = await readPrivateJson(path);
      return isRuntimeCompletion(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async #writeEvents(executionId: string, events: AgentRuntimeEventPage): Promise<void> {
    await writePrivateJson(this.#eventsPath(executionId), events);
  }

  async #readEvents(executionId: string): Promise<AgentRuntimeEventPage | undefined> {
    try {
      const value = await readPrivateJson(this.#eventsPath(executionId));
      return isRuntimeEventPage(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }
}
