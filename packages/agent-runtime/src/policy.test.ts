// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, it } from "@effect/vitest";

import type { BuilderTaskEnvelope } from "./contracts.ts";
import {
  assertWorkspaceSymlinkContainment,
  evaluateAgentWorkspacePolicy,
  type AgentGitEvidence,
} from "./policy.ts";

const task = (root: string): BuilderTaskEnvelope => ({
  version: 1,
  role: "single-builder",
  workItemId: "work",
  workflowRunId: "run",
  agentRunId: "agent",
  projectId: "fixture",
  objective: "edit fixture",
  task: { title: "edit", description: "edit" },
  acceptanceCriteria: ["done"],
  scope: { allowedPaths: ["src/**"], forbiddenPaths: [".git/**", ".mkcode/**"] },
  worktreePathReference: root,
  contextFileReferences: [],
  validationCheckId: "verify",
  maximumRuntimeSeconds: 60,
  cancellationPolicy: "interrupt_then_kill",
  completionOutput: { structuredResultRequired: true },
});
const evidence = (paths: ReadonlyArray<string>): AgentGitEvidence => ({
  head: "a".repeat(40),
  branch: "mkcode/run",
  trackedChangedPaths: [],
  untrackedPaths: paths,
  localConfigurationDigest: "config",
  ownershipMarkerDigest: "marker",
});

describe("agent workspace policy", () => {
  it("accepts bounded edits and rejects forbidden, committed, branch, config, and escaping changes", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-policy-"));
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-policy-outside-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, "src"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(outside, "secret"), "secret", "utf8");
      await NodeFSP.writeFile(NodePath.join(outside, "created.txt"), "outside", "utf8");
      await NodeFSP.symlink(NodePath.join(outside, "secret"), NodePath.join(root, "src", "link"));
      await NodeFSP.symlink(outside, NodePath.join(root, "src", "external"));
      await NodeFSP.symlink(
        NodePath.join(outside, "missing"),
        NodePath.join(root, "src", "dangling"),
      );
      const before = evidence([]);
      NodeAssert.deepEqual(
        (
          await evaluateAgentWorkspacePolicy({
            task: task(root),
            worktreeRoot: root,
            before,
            after: evidence(["src/result.txt"]),
          })
        ).violations,
        [],
      );
      const after = {
        ...evidence([
          ".mkcode/project.yaml",
          "src/dangling",
          "src/external/created.txt",
          "src/link",
        ]),
        head: "b".repeat(40),
        branch: "other",
        localConfigurationDigest: "changed",
      };
      const result = await evaluateAgentWorkspacePolicy({
        task: task(root),
        worktreeRoot: root,
        before,
        after,
      });
      NodeAssert.ok(result.violations.includes("commit_created_or_head_changed"));
      NodeAssert.ok(result.violations.includes("branch_changed"));
      NodeAssert.ok(result.violations.includes("git_configuration_changed"));
      NodeAssert.ok(result.violations.includes("forbidden_path:.mkcode/project.yaml"));
      NodeAssert.ok(result.violations.includes("symlink_escape:src/external/created.txt"));
      NodeAssert.ok(result.violations.includes("symlink_escape:src/link"));
      NodeAssert.ok(result.violations.includes("symlink_escape:src/dangling"));
    } finally {
      await NodeFSP.rm(root, { recursive: true });
      await NodeFSP.rm(outside, { recursive: true });
    }
  });

  it("rejects pre-existing symlinks that escape before the runtime can write through them", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-policy-"));
    const outside = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-policy-outside-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, "src"));
      await NodeFSP.symlink(outside, NodePath.join(root, "src", "external"));
      await NodeAssert.rejects(
        () => assertWorkspaceSymlinkContainment(root),
        /symbolic link escaping the worktree/u,
      );
      await NodeFSP.rm(NodePath.join(root, "src", "external"));
      await NodeFSP.symlink(NodePath.join(root, "src"), NodePath.join(root, "internal"));
      await assertWorkspaceSymlinkContainment(root);
    } finally {
      await NodeFSP.rm(root, { recursive: true });
      await NodeFSP.rm(outside, { recursive: true });
    }
  });
});
