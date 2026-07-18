// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { AgentRuntimeError } from "./contracts.ts";
import type { BuilderTaskEnvelope } from "./contracts.ts";
import { scopePatternMatches } from "./taskEnvelope.ts";

export interface AgentGitEvidence {
  readonly head: string;
  readonly branch: string;
  readonly trackedChangedPaths: ReadonlyArray<string>;
  readonly untrackedPaths: ReadonlyArray<string>;
  readonly localConfigurationDigest: string;
  readonly ownershipMarkerDigest: string;
}

export interface AgentWorkspacePolicyResult {
  readonly violations: ReadonlyArray<string>;
  readonly changedPaths: ReadonlyArray<string>;
}

const MAX_WORKSPACE_ENTRIES = 100_000;

const isContained = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative !== ".." && !relative.startsWith(`..${NodePath.sep}`) && !NodePath.isAbsolute(relative)
  );
};

export async function assertWorkspaceSymlinkContainment(root: string): Promise<void> {
  const canonicalRoot = await NodeFSP.realpath(root);
  const pending = [canonicalRoot];
  let observedEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      observedEntries += 1;
      if (observedEntries > MAX_WORKSPACE_ENTRIES) {
        throw new AgentRuntimeError(
          "invalid_configuration",
          "Workspace symlink containment exceeds the bounded inspection limit.",
        );
      }
      const path = NodePath.join(directory, entry.name);
      const stat = await NodeFSP.lstat(path);
      if (stat.isSymbolicLink()) {
        let target: string;
        try {
          target = await NodeFSP.realpath(path);
        } catch {
          throw new AgentRuntimeError(
            "invalid_configuration",
            "Workspace contains an unresolved symbolic link.",
          );
        }
        if (!isContained(canonicalRoot, target)) {
          throw new AgentRuntimeError(
            "invalid_configuration",
            "Workspace contains a symbolic link escaping the worktree.",
          );
        }
      } else if (stat.isDirectory()) pending.push(path);
    }
  }
}

const isForbidden = (task: BuilderTaskEnvelope, path: string): boolean =>
  task.scope.forbiddenPaths.some((pattern) => scopePatternMatches(pattern, path));

const isAllowed = (task: BuilderTaskEnvelope, path: string): boolean =>
  task.scope.allowedPaths.some((pattern) => scopePatternMatches(pattern, path));

const escapesWorkspace = async (root: string, path: string): Promise<boolean> => {
  const canonicalRoot = await NodeFSP.realpath(root);
  const absolute = NodePath.resolve(canonicalRoot, path);
  const relative = NodePath.relative(canonicalRoot, absolute);
  if (!isContained(canonicalRoot, absolute)) return true;
  let current = canonicalRoot;
  for (const segment of relative.split(NodePath.sep).filter((item) => item.length > 0)) {
    current = NodePath.join(current, segment);
    let observed = false;
    try {
      await NodeFSP.lstat(current);
      observed = true;
      const resolved = await NodeFSP.realpath(current);
      if (!isContained(canonicalRoot, resolved)) return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return observed;
      throw new AgentRuntimeError(
        "invalid_configuration",
        "Changed-path containment could not be verified safely.",
      );
    }
  }
  return false;
};

export async function evaluateAgentWorkspacePolicy(input: {
  readonly task: BuilderTaskEnvelope;
  readonly worktreeRoot: string;
  readonly before: AgentGitEvidence;
  readonly after: AgentGitEvidence;
}): Promise<AgentWorkspacePolicyResult> {
  const changedPaths = [
    ...new Set([...input.after.trackedChangedPaths, ...input.after.untrackedPaths]),
  ].sort();
  const violations: Array<string> = [];
  if (input.after.head !== input.before.head) violations.push("commit_created_or_head_changed");
  if (input.after.branch !== input.before.branch) violations.push("branch_changed");
  if (input.after.ownershipMarkerDigest !== input.before.ownershipMarkerDigest)
    violations.push("ownership_evidence_changed");
  if (input.after.localConfigurationDigest !== input.before.localConfigurationDigest)
    violations.push("git_configuration_changed");
  for (const path of changedPaths) {
    if (isForbidden(input.task, path)) violations.push(`forbidden_path:${path}`);
    else if (!isAllowed(input.task, path)) violations.push(`outside_allowed_paths:${path}`);
    if (await escapesWorkspace(input.worktreeRoot, path)) violations.push(`symlink_escape:${path}`);
  }
  return { violations: [...new Set(violations)], changedPaths };
}
