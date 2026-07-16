// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off -- Process startup emits two operator-facing lines.
import * as NodeProcess from "node:process";

import { configFromEnvironment } from "./config.ts";
import { startFactoryWorker, type RunningFactoryWorker } from "./runtime.ts";

const processRuntime = (NodeProcess as unknown as { readonly default: NodeJS.Process }).default;
const config = configFromEnvironment();
let worker: RunningFactoryWorker | undefined;
let stopRequested = false;
let stopPromise: Promise<void> | undefined;

const stop = async () => {
  stopRequested = true;
  if (!worker) return;
  stopPromise ??= worker.stop();
  await stopPromise;
};

const reportShutdownFailure = (cause: unknown): void => {
  console.error("Factory worker shutdown failed.", {
    error: cause instanceof Error ? cause.message : "unknown_error",
  });
  processRuntime.exitCode = 1;
};

const requestStop = (): void => {
  void stop().catch(reportShutdownFailure);
};

processRuntime.once("SIGINT", requestStop);
processRuntime.once("SIGTERM", requestStop);

worker = await startFactoryWorker(config);
if (stopRequested) {
  await stop().catch((cause: unknown) => {
    reportShutdownFailure(cause);
    throw cause;
  });
} else {
  console.log(`MK Code factory worker listening at ${worker.origin}`);
  console.log(`Factory state: ${config.stateDirectory}`);
}
