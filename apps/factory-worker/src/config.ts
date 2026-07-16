// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { WorkflowEngineError } from "@mkcode/workflow-engine";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface FactoryWorkerConfig {
  readonly host: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly credential: string;
  readonly workerInstanceId: string;
  readonly pollIntervalMilliseconds: number;
  readonly leaseMilliseconds: number;
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
  readonly allowNonLoopback?: boolean;
}

const requirePositiveSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowEngineError("invalid_request", `${name} must be a positive safe integer.`);
  }
  return value;
};

export function resolveFactoryWorkerConfig(input: FactoryWorkerConfigInput): FactoryWorkerConfig {
  const host = input.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host) && input.allowNonLoopback !== true) {
    throw new WorkflowEngineError(
      "invalid_request",
      "Factory worker must bind to loopback unless non-loopback binding is explicitly enabled.",
    );
  }
  if (input.credential.trim().length < 32) {
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
  const leaseMilliseconds = requirePositiveSafeInteger(
    input.leaseMilliseconds ?? 30_000,
    "Factory worker lease duration",
  );
  return {
    host,
    port,
    stateDirectory,
    databasePath: input.databasePath ?? NodePath.join(stateDirectory, "factory.sqlite"),
    credential: input.credential,
    workerInstanceId: input.workerInstanceId ?? `factory-${process.pid}`,
    pollIntervalMilliseconds,
    leaseMilliseconds,
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
    ...(environment.MKCODE_FACTORY_PORT
      ? { port: Number.parseInt(environment.MKCODE_FACTORY_PORT, 10) }
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
    ...(environment.MKCODE_FACTORY_POLL_MS
      ? { pollIntervalMilliseconds: Number.parseInt(environment.MKCODE_FACTORY_POLL_MS, 10) }
      : {}),
    ...(environment.MKCODE_FACTORY_LEASE_MS
      ? { leaseMilliseconds: Number.parseInt(environment.MKCODE_FACTORY_LEASE_MS, 10) }
      : {}),
  });
}
