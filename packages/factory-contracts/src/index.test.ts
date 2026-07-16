import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { FactoryHealth, WorkflowCreateRequest, WorkflowEvent } from "./index.ts";

const decodeFactoryHealth = Schema.decodeUnknownSync(FactoryHealth);
const decodeWorkflowEvent = Schema.decodeUnknownSync(WorkflowEvent);

describe("factory contracts", () => {
  it("decodes versioned health and durable cursor events", () => {
    NodeAssert.deepEqual(
      decodeFactoryHealth({
        ok: true,
        apiVersion: 1,
        workerInstanceId: "worker-1",
        schemaVersion: 1,
      }),
      {
        ok: true,
        apiVersion: 1,
        workerInstanceId: "worker-1",
        schemaVersion: 1,
      },
    );
    NodeAssert.equal(
      decodeWorkflowEvent({
        cursor: 42,
        id: "event-42",
        workflowRunId: "run-1",
        eventType: "stage.completed",
        schemaVersion: 1,
        payload: { stageKey: "planning" },
        timestamp: "2026-01-01T00:00:00.000Z",
      }).cursor,
      42,
    );
  });

  it("rejects unknown request fields under the worker API strict-decoding policy", () => {
    const decode = Schema.decodeUnknownSync(WorkflowCreateRequest, {
      onExcessProperty: "error",
    });
    const request = {
      idempotencyKey: "request-1",
      workItem: {
        projectId: "project-1",
        title: "Title",
        description: "Description",
        source: "manual" as const,
      },
      workflowType: "feature",
      requestedBy: "operator",
      projectSnapshot: {
        version: 1 as const,
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
        contentDigest: "digest",
      },
    };

    NodeAssert.doesNotThrow(() => decode(request));
    NodeAssert.throws(() => decode({ ...request, unexpected: true }));
    for (const invalidRequest of [
      { ...request, idempotencyKey: " " },
      { ...request, workItem: { ...request.workItem, projectId: "" } },
      { ...request, requestedBy: "\t" },
    ]) {
      NodeAssert.throws(() => decode(invalidRequest));
    }
  });

  it("rejects fractional and out-of-range counters", () => {
    NodeAssert.throws(() =>
      decodeWorkflowEvent({
        cursor: 0,
        id: "event-0",
        workflowRunId: "run-1",
        eventType: "stage.completed",
        schemaVersion: 1,
        payload: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
    NodeAssert.throws(() =>
      decodeWorkflowEvent({
        cursor: 1.5,
        id: "event-fractional",
        workflowRunId: "run-1",
        eventType: "stage.completed",
        schemaVersion: 1,
        payload: {},
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
    );
  });
});
