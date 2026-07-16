// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics cryptoRandomUUID:off -- Execution identities are persisted before launch.
// @effect-diagnostics globalTimers:off -- Lease renewal is tied to one active command.
import * as NodeCrypto from "node:crypto";
import * as NodeTimers from "node:timers";

import { type CommandExecutionResult, DeterministicCommandRunner } from "@mkcode/command-runner";
import { ResolvedProjectCheck } from "@mkcode/project-config/schema";
import type { ClaimedJob, WorkflowEngine } from "@mkcode/workflow-engine";
import * as Schema from "effect/Schema";

const decodeCheck = Schema.decodeUnknownSync(ResolvedProjectCheck, {
  onExcessProperty: "error",
  errors: "all",
});

export class CommandExecutionWorker {
  readonly #engine: WorkflowEngine;
  readonly #runner: DeterministicCommandRunner;
  readonly #workerInstanceId: string;
  readonly #leaseMilliseconds: number;
  readonly #active = new Map<string, AbortController>();
  #stopping = false;

  constructor(input: {
    readonly engine: WorkflowEngine;
    readonly runner: DeterministicCommandRunner;
    readonly workerInstanceId: string;
    readonly leaseMilliseconds: number;
  }) {
    this.#engine = input.engine;
    this.#runner = input.runner;
    this.#workerInstanceId = input.workerInstanceId;
    this.#leaseMilliseconds = input.leaseMilliseconds;
  }

  stop(): void {
    this.#stopping = true;
    for (const controller of this.#active.values()) controller.abort();
  }

  cancelWorkflow(workflowRunId: string): void {
    this.#active.get(workflowRunId)?.abort();
  }

  async runClaimed(claimed: ClaimedJob): Promise<void> {
    if (claimed.job.jobType !== "command.execute") {
      throw new TypeError("Command worker received a non-command job.");
    }
    const detail = this.#engine.readWorkflow(claimed.job.workflowRunId);
    const command = detail.commands.find(
      (candidate) => candidate.stageRunId === claimed.job.stageRunId,
    );
    if (!command || command.status !== "pending") {
      throw new TypeError("Claimed command job has no pending CommandRun.");
    }
    let definition;
    try {
      definition = decodeCheck(command.commandDefinition);
    } catch {
      this.#engine.failJob({
        jobId: claimed.job.id,
        leaseOwner: this.#workerInstanceId,
        retryable: false,
        failureSummary: "The snapshotted project check is invalid.",
        expectedStageVersion: claimed.stageVersion,
      });
      return;
    }

    const executionId = NodeCrypto.randomUUID();
    const outputReferences = this.#runner.outputStore.referencesFor(executionId);
    let current = this.#engine.startCommand({
      commandRunId: command.id,
      jobId: claimed.job.id,
      leaseOwner: this.#workerInstanceId,
      attemptId: claimed.attempt.id,
      expectedStageVersion: claimed.stageVersion,
      processHostExecutionId: executionId,
      processHostType: "local",
      stdoutArtifactReference: outputReferences.stdout,
      stderrArtifactReference: outputReferences.stderr,
    });
    const controller = new AbortController();
    this.#active.set(command.workflowRunId, controller);
    let renewal: ReturnType<typeof NodeTimers.setInterval> | undefined;
    let renewalFailed = false;
    let result: CommandExecutionResult;
    renewal = NodeTimers.setInterval(
      () => {
        try {
          this.#engine.renewLease(claimed.job.id, this.#workerInstanceId, this.#leaseMilliseconds);
        } catch {
          renewalFailed = true;
          controller.abort();
        }
      },
      Math.max(50, Math.floor(this.#leaseMilliseconds / 3)),
    );
    renewal.unref();
    try {
      result = await this.#runner.execute({
        executionId,
        definition,
        executionRoot: command.executionRoot,
        signal: controller.signal,
        onStarted: (started) => {
          current = this.#engine.markCommandRunning({
            commandRunId: command.id,
            expectedVersion: current.version,
            processHostExecutionId: started.executionId,
            processHostType: started.processHostType,
            ...(started.nativePid === undefined ? {} : { nativePid: started.nativePid }),
            startedAt: started.startedAt,
            timeoutDeadline: started.timeoutDeadline,
            workingDirectory: started.workingDirectory,
          });
        },
      });
    } catch {
      if (!this.#stopping && !renewalFailed) {
        this.#engine.failCommandBeforeLaunch({
          commandRunId: command.id,
          jobId: claimed.job.id,
          leaseOwner: this.#workerInstanceId,
          expectedCommandVersion: current.version,
          expectedStageVersion: claimed.stageVersion,
          failureClassification: "command_preflight_failed",
        });
      }
      return;
    } finally {
      if (renewal) NodeTimers.clearInterval(renewal);
      this.#active.delete(command.workflowRunId);
    }
    if (this.#stopping) return;
    const latest = this.#engine.readCommand(command.id);
    if (latest.status === "cancelled") {
      if (result.outcome === "cancelled") {
        this.#engine.recordCancelledCommandResult(command.id, result);
      }
      return;
    }
    if (renewalFailed) return;
    this.#engine.completeCommand({
      commandRunId: command.id,
      jobId: claimed.job.id,
      leaseOwner: this.#workerInstanceId,
      expectedCommandVersion: latest.version,
      expectedStageVersion: claimed.stageVersion,
      result,
    });
  }
}
