import type { ClaimedJob, WorkflowEngine } from "@mkcode/workflow-engine";

export type SimulationOutcome =
  | { readonly kind: "success"; readonly metadata?: Readonly<Record<string, unknown>> }
  | {
      readonly kind: "retryable_failure";
      readonly summary: string;
      readonly retryDelayMilliseconds?: number;
      readonly maximumAttempts?: number;
    }
  | { readonly kind: "terminal_failure"; readonly summary: string };

export type SimulationHandler = (claimed: ClaimedJob) => Promise<SimulationOutcome>;

const defaultHandler: SimulationHandler = async () => ({ kind: "success" });

export class SimulationWorker {
  readonly #engine: WorkflowEngine;
  readonly #workerInstanceId: string;
  readonly #leaseMilliseconds: number;
  readonly #handler: SimulationHandler;
  #stopping = false;

  constructor(input: {
    readonly engine: WorkflowEngine;
    readonly workerInstanceId: string;
    readonly leaseMilliseconds: number;
    readonly handler?: SimulationHandler;
  }) {
    this.#engine = input.engine;
    this.#workerInstanceId = input.workerInstanceId;
    this.#leaseMilliseconds = input.leaseMilliseconds;
    this.#handler = input.handler ?? defaultHandler;
  }

  stop(): void {
    this.#stopping = true;
  }

  async runOnce(): Promise<boolean> {
    if (this.#stopping) return false;
    const claimed = this.#engine.claimNextJob(this.#workerInstanceId, this.#leaseMilliseconds);
    if (!claimed) return false;

    let outcome: SimulationOutcome;
    try {
      outcome = await this.#handler(claimed);
    } catch {
      this.#engine.failJob({
        jobId: claimed.job.id,
        leaseOwner: this.#workerInstanceId,
        retryable: true,
        failureSummary: "Simulation handler failed unexpectedly.",
        expectedStageVersion: claimed.stageVersion,
      });
      return true;
    }
    if (outcome.kind === "success") {
      this.#engine.completeJob(
        claimed.job.id,
        this.#workerInstanceId,
        outcome.metadata ?? { simulated: true },
        claimed.stageVersion,
      );
      return true;
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
    return true;
  }
}
