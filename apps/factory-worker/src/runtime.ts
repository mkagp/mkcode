// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- This file owns the imperative process loop.
// @effect-diagnostics globalConsole:off -- This file owns the imperative process loop.
import type * as NodeHttp from "node:http";

import { WorkflowEngine } from "@mkcode/workflow-engine";

import { createFactoryApiServer } from "./api.ts";
import type { FactoryWorkerConfig } from "./config.ts";
import { SimulationWorker, type SimulationHandler } from "./simulationWorker.ts";

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
  const server = createFactoryApiServer({
    engine,
    credential: config.credential,
    workerInstanceId: config.workerInstanceId,
  });

  try {
    await listen(server, { host: config.host, port: config.port });
  } catch (cause) {
    engine.close();
    throw cause;
  }

  let polling = false;
  let currentPoll: Promise<void> | undefined;
  const interval = setInterval(() => {
    if (polling) return;
    polling = true;
    currentPoll = simulationWorker
      .runOnce()
      .then(() => undefined)
      .catch((cause: unknown) => {
        console.error("Factory simulation job failed.", {
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
      clearInterval(interval);
      await currentPoll;
      await close(server);
      engine.close();
    },
  };
}
