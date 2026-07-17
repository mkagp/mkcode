// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, it } from "@effect/vitest";

describe("workspace-manager architecture", () => {
  it("owns Git side effects without importing workflow, UI, provider, or Herdr code", async () => {
    const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
    const source = await NodeFSP.readFile(NodePath.join(root, "workspaceManager.ts"), "utf8");
    for (const forbidden of [
      "@mkcode/workflow-engine",
      "@mkcode/factory-contracts",
      "factory.sqlite",
      "react",
      "Claude",
      "Codex",
      "OpenCode",
      "Herdr",
    ]) {
      NodeAssert.equal(source.includes(forbidden), false, `Unexpected dependency: ${forbidden}`);
    }
    NodeAssert.equal(source.includes("shell: false"), true);
    NodeAssert.match(source, /"worktree",\s*"add"/u);
    NodeAssert.match(source, /"worktree",\s*"remove"/u);
    NodeAssert.equal(source.includes("--force"), false);
  });
});
