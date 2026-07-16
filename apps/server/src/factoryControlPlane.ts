import type { WorkItemSource, WorkflowCreateResult } from "@mkcode/factory-contracts";
import type { ProjectRegistrationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { FactoryWorkerClient, FactoryWorkerClientError } from "./factoryWorkerClient.ts";
import * as ProjectRegistry from "./projectRegistry.ts";

export class FactoryControlPlaneError extends Schema.TaggedErrorClass<FactoryControlPlaneError>()(
  "FactoryControlPlaneError",
  {
    code: Schema.Literals(["project_unavailable", "project_disabled", "worker_unavailable"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "project_unavailable":
        return "The registered project does not have a currently valid configuration.";
      case "project_disabled":
        return "The registered project is disabled.";
      case "worker_unavailable":
        return "The factory worker could not accept the workflow request.";
    }
  }
}

export interface CreateRegisteredProjectWorkflowInput {
  readonly projectId: string;
  readonly idempotencyKey: string;
  readonly workItemId?: string;
  readonly title: string;
  readonly description: string;
  readonly source: WorkItemSource;
  readonly workflowType: string;
  readonly requestedBy: string;
  readonly validationCheckId?: string;
}

export const createRegisteredProjectWorkflow = Effect.fn(
  "factoryControlPlane.createRegisteredProjectWorkflow",
)(function* (
  client: FactoryWorkerClient,
  input: CreateRegisteredProjectWorkflowInput,
): Effect.fn.Return<
  WorkflowCreateResult,
  FactoryControlPlaneError | FactoryWorkerClientError | ProjectRegistrationError,
  ProjectRegistry.ProjectRegistry
> {
  const registry = yield* ProjectRegistry.ProjectRegistry;
  const storedRegistration = yield* registry.read(input.projectId);
  if (!storedRegistration.enabled) {
    return yield* new FactoryControlPlaneError({
      code: "project_disabled",
    });
  }
  const registration = yield* registry.validate(input.projectId);
  if (!registration.enabled) {
    return yield* new FactoryControlPlaneError({
      code: "project_disabled",
    });
  }
  if (registration.validationStatus !== "valid") {
    return yield* new FactoryControlPlaneError({
      code: "project_unavailable",
    });
  }
  return yield* Effect.tryPromise({
    try: () =>
      client.createWorkflow({
        idempotencyKey: input.idempotencyKey,
        workItem: {
          ...(input.workItemId ? { id: input.workItemId } : {}),
          projectId: registration.projectId,
          title: input.title,
          description: input.description,
          source: input.source,
        },
        workflowType: input.workflowType,
        requestedBy: input.requestedBy,
        projectSnapshot: registration.resolvedConfiguration,
        ...(input.validationCheckId === undefined
          ? {}
          : { validationCheckId: input.validationCheckId }),
      }),
    catch: (cause) =>
      cause instanceof FactoryWorkerClientError && cause.status !== 504
        ? cause
        : new FactoryControlPlaneError({
            code: "worker_unavailable",
            cause,
          }),
  });
});
