// @effect-diagnostics globalTimers:off -- Simulation deadlines protect durable leases.
import * as NodeTimers from "node:timers";

import type { ClaimedJob, WorkflowEngine } from "@mkcode/workflow-engine";

export const MIN_SIMULATION_LEASE_MILLISECONDS = 100;

export type SimulationOutcome =
  | { readonly kind: "success"; readonly metadata?: Readonly<Record<string, unknown>> }
  | {
      readonly kind: "retryable_failure";
      readonly summary: string;
      readonly retryDelayMilliseconds?: number;
      readonly maximumAttempts?: number;
    }
  | { readonly kind: "terminal_failure"; readonly summary: string };

export type SimulationHandler = (
  claimed: ClaimedJob,
  signal: AbortSignal,
) => Promise<SimulationOutcome>;

const defaultHandler: SimulationHandler = async () => ({ kind: "success" });

class SimulationDeadlineError extends Error {}

const waitForSettlement = async (
  promise: Promise<unknown>,
  graceMilliseconds: number,
): Promise<boolean> => {
  let timeout: ReturnType<typeof NodeTimers.setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timeout = NodeTimers.setTimeout(() => resolve(false), graceMilliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) NodeTimers.clearTimeout(timeout);
  }
};

export class SimulationWorker {
  readonly #engine: WorkflowEngine;
  readonly #workerInstanceId: string;
  readonly #leaseMilliseconds: number;
  readonly #handler: SimulationHandler;
  #activeController: AbortController | undefined;
  #stopping = false;

  constructor(input: {
    readonly engine: WorkflowEngine;
    readonly workerInstanceId: string;
    readonly leaseMilliseconds: number;
    readonly handler?: SimulationHandler;
  }) {
    if (
      !Number.isSafeInteger(input.leaseMilliseconds) ||
      input.leaseMilliseconds < MIN_SIMULATION_LEASE_MILLISECONDS
    ) {
      throw new TypeError(
        `Simulation lease must be at least ${MIN_SIMULATION_LEASE_MILLISECONDS} milliseconds.`,
      );
    }
    this.#engine = input.engine;
    this.#workerInstanceId = input.workerInstanceId;
    this.#leaseMilliseconds = input.leaseMilliseconds;
    this.#handler = input.handler ?? defaultHandler;
  }

  stop(): void {
    this.#stopping = true;
    this.#activeController?.abort();
  }

  async runClaimed(claimed: ClaimedJob): Promise<void> {
    if (claimed.job.jobType === "command.execute") {
      throw new TypeError("Simulation worker received a command-execution job.");
    }
    let outcome: SimulationOutcome;
    const controller = new AbortController();
    this.#activeController = controller;
    const deadlineMilliseconds = Math.max(1, Math.floor(this.#leaseMilliseconds / 2));
    const abortGraceMilliseconds = Math.max(1, Math.floor(this.#leaseMilliseconds / 4));
    let deadline: ReturnType<typeof NodeTimers.setTimeout> | undefined;
    let handler: Promise<SimulationOutcome> | undefined;
    try {
      handler = this.#handler(claimed, controller.signal);
      outcome = await Promise.race([
        handler,
        new Promise<never>((_resolve, reject) => {
          deadline = NodeTimers.setTimeout(() => {
            controller.abort();
            reject(new SimulationDeadlineError());
          }, deadlineMilliseconds);
          deadline.unref();
        }),
      ]);
    } catch (cause) {
      controller.abort();
      if (
        this.#stopping ||
        (cause instanceof SimulationDeadlineError &&
          handler !== undefined &&
          !(await waitForSettlement(handler, abortGraceMilliseconds)))
      ) {
        return;
      }
      this.#engine.failJob({
        jobId: claimed.job.id,
        leaseOwner: this.#workerInstanceId,
        retryable: true,
        failureSummary: "Simulation handler failed unexpectedly.",
        expectedStageVersion: claimed.stageVersion,
      });
      return;
    } finally {
      if (deadline) NodeTimers.clearTimeout(deadline);
      controller.abort();
      if (this.#activeController === controller) this.#activeController = undefined;
    }
    if (this.#stopping) return;
    if (outcome.kind === "success") {
      this.#engine.completeJob(
        claimed.job.id,
        this.#workerInstanceId,
        outcome.metadata ?? { simulated: true },
        claimed.stageVersion,
      );
      return;
    }
    this.#engine.failJob({
      jobId: claimed.job.id,
      leaseOwner: this.#workerInstanceId,
      retryable: outcome.kind === "retryable_failure",
      failureSummary: outcome.summary,
      expectedStageVersion: claimed.stageVersion,
      ...(outcome.kind === "retryable_failure"
        ? {
            retryDelayMilliseconds: outcome.retryDelayMilliseconds,
            maximumAttempts: outcome.maximumAttempts,
          }
        : {}),
    });
    return;
  }
}
