import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";
import type { WorkflowCreateRequest } from "@mkcode/factory-contracts";
import type { ProjectRegistration } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  createRegisteredProjectWorkflow,
  FactoryControlPlaneError,
} from "./factoryControlPlane.ts";
import { FactoryWorkerClient, FactoryWorkerClientError } from "./factoryWorkerClient.ts";
import * as ProjectRegistry from "./projectRegistry.ts";

const isFactoryControlPlaneError = Schema.is(FactoryControlPlaneError);

const registration = (digest: string): ProjectRegistration => ({
  projectId: "project-1",
  repositoryPath: "/repo",
  enabled: true,
  displayName: "Project",
  addedAt: "2026-01-01T00:00:00.000Z",
  lastValidatedAt: "2026-01-01T00:00:00.000Z",
  validationStatus: "valid",
  configurationFileLocation: "/repo/.mkcode/project.yaml",
  configurationDigest: digest,
  resolvedConfiguration: {
    version: 1,
    project: { id: "project-1", name: "Project" },
    repository: {
      baseBranch: "main",
      root: "/repo",
      worktreeRoot: "/worktrees",
      contextFiles: [],
    },
    setup: [],
    checks: [],
    workflows: { allowed: ["feature"] },
    execution: { defaultProfile: "default" },
    sourcePath: "/repo/.mkcode/project.yaml",
    contentDigest: digest,
  },
  validationErrors: [],
});

describe("factory control plane", () => {
  it.effect("revalidates an enabled project and forwards only the fresh snapshot", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let forwarded: WorkflowCreateRequest | undefined;
      const stored = registration("stored-digest");
      const validated = registration("fresh-digest");
      const registry = ProjectRegistry.ProjectRegistry.of({
        register: () => Effect.succeed(stored),
        list: Effect.succeed([stored]),
        read: () =>
          Effect.sync(() => {
            calls.push("read");
            return stored;
          }),
        validate: () =>
          Effect.sync(() => {
            calls.push("validate");
            return validated;
          }),
        disable: () => Effect.succeed({ ...stored, enabled: false, validationStatus: "disabled" }),
        enable: () => Effect.succeed(stored),
      });
      const client = {
        createWorkflow: (input: WorkflowCreateRequest) => {
          calls.push("create");
          forwarded = input;
          return Promise.reject(new Error("controlled worker failure"));
        },
      } as unknown as FactoryWorkerClient;

      const result = yield* Effect.result(
        createRegisteredProjectWorkflow(client, {
          projectId: "project-1",
          idempotencyKey: "request-1",
          title: "Title",
          description: "Description",
          source: "manual",
          workflowType: "feature",
          requestedBy: "operator",
          validationCheckId: "lint",
        }),
      ).pipe(Effect.provideService(ProjectRegistry.ProjectRegistry, registry));

      NodeAssert.deepEqual(calls, ["read", "validate", "create"]);
      NodeAssert.equal(forwarded?.projectSnapshot.contentDigest, "fresh-digest");
      NodeAssert.equal(forwarded?.validationCheckId, "lint");
      NodeAssert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") {
        NodeAssert.fail("Expected workflow creation to fail.");
      }
      NodeAssert.ok(isFactoryControlPlaneError(result.failure));
      if (!isFactoryControlPlaneError(result.failure)) {
        NodeAssert.fail("Expected a FactoryControlPlaneError.");
      }
      NodeAssert.equal(result.failure.code, "worker_unavailable");
      NodeAssert.equal(
        result.failure.message,
        "The factory worker could not accept the workflow request.",
      );
      NodeAssert.ok(result.failure.cause instanceof Error);
    }),
  );

  it.effect("preserves deterministic worker rejection semantics", () =>
    Effect.gen(function* () {
      const stored = registration("fresh-digest");
      const registry = ProjectRegistry.ProjectRegistry.of({
        register: () => Effect.succeed(stored),
        list: Effect.succeed([stored]),
        read: () => Effect.succeed(stored),
        validate: () => Effect.succeed(stored),
        disable: () => Effect.succeed({ ...stored, enabled: false, validationStatus: "disabled" }),
        enable: () => Effect.succeed(stored),
      });
      const conflict = new FactoryWorkerClientError(409, {
        code: "conflict",
        message: "Idempotency conflict.",
      });
      const client = {
        createWorkflow: () => Promise.reject(conflict),
      } as unknown as FactoryWorkerClient;

      const result = yield* Effect.result(
        createRegisteredProjectWorkflow(client, {
          projectId: "project-1",
          idempotencyKey: "request-conflict",
          title: "Title",
          description: "Description",
          source: "manual",
          workflowType: "feature",
          requestedBy: "operator",
        }),
      ).pipe(Effect.provideService(ProjectRegistry.ProjectRegistry, registry));

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag === "Failure") NodeAssert.equal(result.failure, conflict);
    }),
  );

  it.effect("reports a project disabled during revalidation as disabled", () =>
    Effect.gen(function* () {
      const stored = registration("stored-digest");
      const disabled = {
        ...stored,
        enabled: false,
        validationStatus: "disabled" as const,
      };
      const registry = ProjectRegistry.ProjectRegistry.of({
        register: () => Effect.succeed(stored),
        list: Effect.succeed([stored]),
        read: () => Effect.succeed(stored),
        validate: () => Effect.succeed(disabled),
        disable: () => Effect.succeed(disabled),
        enable: () => Effect.succeed(stored),
      });
      const client = {
        createWorkflow: () => NodeAssert.fail("Disabled project must not reach the worker."),
      } as unknown as FactoryWorkerClient;

      const result = yield* Effect.result(
        createRegisteredProjectWorkflow(client, {
          projectId: "project-1",
          idempotencyKey: "request-disabled-race",
          title: "Title",
          description: "Description",
          source: "manual",
          workflowType: "feature",
          requestedBy: "operator",
        }),
      ).pipe(Effect.provideService(ProjectRegistry.ProjectRegistry, registry));

      NodeAssert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") NodeAssert.fail("Expected disabled project failure.");
      NodeAssert.ok(isFactoryControlPlaneError(result.failure));
      if (!isFactoryControlPlaneError(result.failure)) {
        NodeAssert.fail("Expected a FactoryControlPlaneError.");
      }
      NodeAssert.equal(result.failure.code, "project_disabled");
    }),
  );
});
