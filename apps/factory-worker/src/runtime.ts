// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- This file owns the imperative process loop.
// @effect-diagnostics globalConsole:off -- This file owns the imperative process loop.
import type * as NodeHttp from "node:http";

import { DeterministicCommandRunner } from "@mkcode/command-runner";
import { WorkflowEngine } from "@mkcode/workflow-engine";

import { createFactoryApiServer } from "./api.ts";
import { CommandExecutionWorker } from "./commandWorker.ts";
import type { FactoryWorkerConfig } from "./config.ts";
import { SimulationWorker, type SimulationHandler } from "./simulationWorker.ts";
import { WorkspaceExecutionWorker } from "./workspaceWorker.ts";

const listen = (
  server: NodeHttp.Server,
  options: { readonly host: string; readonly port: number },
): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      reject(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });

const close = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((cause) => {
      if (cause) reject(cause);
      else resolve();
    });
  });

const waitForPoll = async (
  currentPoll: Promise<void> | undefined,
  graceMilliseconds: number,
): Promise<void> => {
  if (!currentPoll) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      currentPoll,
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, graceMilliseconds);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export interface RunningFactoryWorker {
  readonly engine: WorkflowEngine;
  readonly server: NodeHttp.Server;
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

export async function startFactoryWorker(
  config: FactoryWorkerConfig,
  handler?: SimulationHandler,
): Promise<RunningFactoryWorker> {
  const engine = await WorkflowEngine.open({
    stateDirectory: config.stateDirectory,
    databasePath: config.databasePath,
  });
  try {
    engine.reconcile();
  } catch (cause) {
    engine.close();
    throw cause;
  }

  const simulationWorker = new SimulationWorker({
    engine,
    workerInstanceId: config.workerInstanceId,
    leaseMilliseconds: config.leaseMilliseconds,
    ...(handler ? { handler } : {}),
  });
  const commandRunner = new DeterministicCommandRunner({
    stateRoot: config.stateDirectory,
    redactionValues: [config.credential],
    protectedEnvironmentSources: new Set(["MKCODE_FACTORY_TOKEN"]),
  });
  const commandWorker = new CommandExecutionWorker({
    engine,
    runner: commandRunner,
    workerInstanceId: config.workerInstanceId,
    leaseMilliseconds: config.leaseMilliseconds,
  });
  const workspaceWorker = new WorkspaceExecutionWorker({
    engine,
    workerInstanceId: config.workerInstanceId,
    factoryStateRoot: config.stateDirectory,
    leaseMilliseconds: config.leaseMilliseconds,
  });
  try {
    await workspaceWorker.reconcileAll();
  } catch (cause) {
    engine.close();
    throw cause;
  }
  const server = createFactoryApiServer({
    engine,
    credential: config.credential,
    workerInstanceId: config.workerInstanceId,
    outputStore: commandRunner.outputStore,
    onWorkflowCancelled: (workflowRunId) => commandWorker.cancelWorkflow(workflowRunId),
  });

  try {
    await listen(server, { host: config.host, port: config.port });
  } catch (cause) {
    engine.close();
    throw cause;
  }

  let polling = false;
  let workspaceOperationInFlight = false;
  let currentPoll: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (polling) return;
    polling = true;
    currentPoll = Promise.resolve()
      .then(async () => {
        const claimed = engine.claimNextJob(config.workerInstanceId, config.leaseMilliseconds);
        if (!claimed) return;
        if (
          claimed.job.jobType === "workspace.allocate" ||
          claimed.job.jobType === "workspace.cleanup"
        ) {
          workspaceOperationInFlight = true;
          try {
            await workspaceWorker.runClaimed(claimed);
          } finally {
            workspaceOperationInFlight = false;
          }
        } else if (claimed.job.jobType === "command.execute") {
          await commandWorker.runClaimed(claimed);
        } else {
          await simulationWorker.runClaimed(claimed);
        }
      })
      .then(() => undefined)
      .catch((cause: unknown) => {
        console.error("Factory job failed.", {
          error: cause instanceof Error ? cause.message : "unknown_error",
        });
      })
      .finally(() => {
        polling = false;
        currentPoll = undefined;
      });
  }, config.pollIntervalMilliseconds);
  interval.unref();

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  let stopped = false;
  return {
    engine,
    server,
    origin: `http://${config.host === "::1" ? "[::1]" : config.host}:${port}`,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      simulationWorker.stop();
      commandWorker.stop();
      workspaceWorker.stop();
      clearInterval(interval);
      await waitForPoll(currentPoll, config.shutdownGraceMilliseconds);
      if (workspaceOperationInFlight && currentPoll) await currentPoll;
      try {
        await close(server);
      } finally {
        engine.close();
      }
    },
  };
}
