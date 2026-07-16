// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { MAX_LEASE_MILLISECONDS, WorkflowEngineError } from "@mkcode/workflow-engine";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const MAX_TIMER_MILLISECONDS = 2_147_483_647;

export interface FactoryWorkerConfig {
  readonly host: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly credential: string;
  readonly workerInstanceId: string;
  readonly pollIntervalMilliseconds: number;
  readonly leaseMilliseconds: number;
  readonly shutdownGraceMilliseconds: number;
}

export interface FactoryWorkerConfigInput {
  readonly host?: string;
  readonly port?: number;
  readonly stateDirectory?: string;
  readonly databasePath?: string;
  readonly credential: string;
  readonly workerInstanceId?: string;
  readonly pollIntervalMilliseconds?: number;
  readonly leaseMilliseconds?: number;
  readonly shutdownGraceMilliseconds?: number;
  readonly allowNonLoopback?: boolean;
}

const requirePositiveSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowEngineError("invalid_request", `${name} must be a positive safe integer.`);
  }
  return value;
};

const parseEnvironmentInteger = (value: string, name: string): number => {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new WorkflowEngineError("invalid_request", `${name} must be a decimal integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new WorkflowEngineError("invalid_request", `${name} must be a safe integer.`);
  }
  return parsed;
};

export function resolveFactoryWorkerConfig(input: FactoryWorkerConfigInput): FactoryWorkerConfig {
  const host = input.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) && input.allowNonLoopback !== true) {
    throw new WorkflowEngineError(
      "invalid_request",
      "Factory worker must bind to loopback unless non-loopback binding is explicitly enabled.",
    );
  }
  const credential = input.credential.trim();
  if (credential.length < 32) {
    throw new WorkflowEngineError(
      "invalid_request",
      "Factory worker credential must contain at least 32 characters.",
    );
  }
  const stateDirectory = NodePath.resolve(
    input.stateDirectory ?? NodePath.join(NodeOS.homedir(), ".mkcode", "factory-worker"),
  );
  const port = input.port ?? 4317;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new WorkflowEngineError("invalid_request", "Factory worker port is invalid.");
  }
  const pollIntervalMilliseconds = requirePositiveSafeInteger(
    input.pollIntervalMilliseconds ?? 50,
    "Factory worker poll interval",
  );
  if (pollIntervalMilliseconds > MAX_TIMER_MILLISECONDS) {
    throw new WorkflowEngineError(
      "invalid_request",
      `Factory worker poll interval must not exceed ${MAX_TIMER_MILLISECONDS} milliseconds.`,
    );
  }
  const leaseMilliseconds = requirePositiveSafeInteger(
    input.leaseMilliseconds ?? 30_000,
    "Factory worker lease duration",
  );
  if (leaseMilliseconds > MAX_LEASE_MILLISECONDS) {
    throw new WorkflowEngineError(
      "invalid_request",
      `Factory worker lease duration must not exceed ${MAX_LEASE_MILLISECONDS} milliseconds.`,
    );
  }
  const shutdownGraceMilliseconds = requirePositiveSafeInteger(
    input.shutdownGraceMilliseconds ?? 5_000,
    "Factory worker shutdown grace period",
  );
  if (shutdownGraceMilliseconds > MAX_TIMER_MILLISECONDS) {
    throw new WorkflowEngineError(
      "invalid_request",
      `Factory worker shutdown grace period must not exceed ${MAX_TIMER_MILLISECONDS} milliseconds.`,
    );
  }
  return {
    host,
    port,
    stateDirectory,
    databasePath: input.databasePath
      ? NodePath.resolve(stateDirectory, input.databasePath)
      : NodePath.join(stateDirectory, "factory.sqlite"),
    credential,
    workerInstanceId: input.workerInstanceId ?? `factory-${process.pid}`,
    pollIntervalMilliseconds,
    leaseMilliseconds,
    shutdownGraceMilliseconds,
  };
}

export function configFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): FactoryWorkerConfig {
  const credential = environment.MKCODE_FACTORY_TOKEN;
  if (!credential) {
    throw new WorkflowEngineError(
      "invalid_request",
      "MKCODE_FACTORY_TOKEN is required to start the factory worker.",
    );
  }
  return resolveFactoryWorkerConfig({
    credential,
    allowNonLoopback: environment.MKCODE_FACTORY_ALLOW_NON_LOOPBACK === "true",
    ...(environment.MKCODE_FACTORY_HOST ? { host: environment.MKCODE_FACTORY_HOST } : {}),
    ...(environment.MKCODE_FACTORY_PORT !== undefined
      ? { port: parseEnvironmentInteger(environment.MKCODE_FACTORY_PORT, "MKCODE_FACTORY_PORT") }
      : {}),
    ...(environment.MKCODE_FACTORY_STATE_DIR
      ? { stateDirectory: environment.MKCODE_FACTORY_STATE_DIR }
      : {}),
    ...(environment.MKCODE_FACTORY_DATABASE_PATH
      ? { databasePath: environment.MKCODE_FACTORY_DATABASE_PATH }
      : {}),
    ...(environment.MKCODE_FACTORY_WORKER_ID
      ? { workerInstanceId: environment.MKCODE_FACTORY_WORKER_ID }
      : {}),
    ...(environment.MKCODE_FACTORY_POLL_MS !== undefined
      ? {
          pollIntervalMilliseconds: parseEnvironmentInteger(
            environment.MKCODE_FACTORY_POLL_MS,
            "MKCODE_FACTORY_POLL_MS",
          ),
        }
      : {}),
    ...(environment.MKCODE_FACTORY_LEASE_MS !== undefined
      ? {
          leaseMilliseconds: parseEnvironmentInteger(
            environment.MKCODE_FACTORY_LEASE_MS,
            "MKCODE_FACTORY_LEASE_MS",
          ),
        }
      : {}),
    ...(environment.MKCODE_FACTORY_SHUTDOWN_GRACE_MS !== undefined
      ? {
          shutdownGraceMilliseconds: parseEnvironmentInteger(
            environment.MKCODE_FACTORY_SHUTDOWN_GRACE_MS,
            "MKCODE_FACTORY_SHUTDOWN_GRACE_MS",
          ),
        }
      : {}),
  });
}
