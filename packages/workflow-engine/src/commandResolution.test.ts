// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { resolveSnapshotCommand } from "./commandResolution.ts";
import { makeProjectSnapshot } from "./testFixtures.ts";

const command = {
  id: "install",
  executable: "pnpm",
  args: ["install", "--frozen-lockfile"],
  workingDirectory: ".",
  resolvedWorkingDirectory: "/tmp/project",
  timeoutSeconds: 900,
  environment: [],
  artifacts: [],
};

describe("resolveSnapshotCommand", () => {
  it("resolves setup and check commands only from their selected category", () => {
    const snapshot = {
      ...makeProjectSnapshot("/tmp/project"),
      setup: [command],
      checks: [{ ...command, id: "lint", failureBehavior: "fail" as const }],
    };
    NodeAssert.equal(
      resolveSnapshotCommand({ projectSnapshot: snapshot, category: "setup", commandId: "install" })
        .id,
      "install",
    );
    NodeAssert.equal(
      resolveSnapshotCommand({ projectSnapshot: snapshot, category: "check", commandId: "lint" })
        .id,
      "lint",
    );
    NodeAssert.throws(() =>
      resolveSnapshotCommand({
        projectSnapshot: snapshot,
        category: "setup",
        commandId: "lint",
      }),
    );
  });

  it("rejects duplicate and unsafe historical command snapshots", () => {
    const duplicate = {
      ...makeProjectSnapshot("/tmp/project"),
      setup: [command, { ...command }],
    };
    NodeAssert.throws(() =>
      resolveSnapshotCommand({
        projectSnapshot: duplicate,
        category: "setup",
        commandId: "install",
      }),
    );
    const unsafe = {
      ...makeProjectSnapshot("/tmp/project"),
      setup: [
        {
          ...command,
          workingDirectory: "../outside",
          resolvedWorkingDirectory: "/tmp/outside",
        },
      ],
    };
    NodeAssert.throws(() =>
      resolveSnapshotCommand({
        projectSnapshot: unsafe,
        category: "setup",
        commandId: "install",
      }),
    );
    const mismatched = {
      ...makeProjectSnapshot("/tmp/project"),
      setup: [{ ...command, resolvedWorkingDirectory: "/tmp/project/other" }],
    };
    NodeAssert.throws(() =>
      resolveSnapshotCommand({
        projectSnapshot: mismatched,
        category: "setup",
        commandId: "install",
      }),
    );
  });
});
