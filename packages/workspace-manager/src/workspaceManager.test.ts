// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { afterEach, describe, it } from "@effect/vitest";

import {
  generatedWorkspaceBranch,
  GitWorktreeWorkspaceManager,
  WorkspaceManagerError,
  type WorkspaceAllocationPlan,
} from "./workspaceManager.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const roots: Array<string> = [];
const permissionBits = (mode: number) => mode & 0o777;

const makeRoot = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "mkcode-workspace-manager-"));
  roots.push(root);
  return root;
};

const git = async (cwd: string, ...args: ReadonlyArray<string>) =>
  execFile("git", ["-C", cwd, ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    maxBuffer: 1024 * 1024,
  });

const makeRepository = async () => {
  const root = await makeRoot();
  const repository = NodePath.join(root, "repository");
  const state = NodePath.join(root, "state");
  await NodeFSP.mkdir(repository);
  await NodeFSP.mkdir(state, { mode: 0o700 });
  await execFile("git", ["init", "-b", "main", repository]);
  await NodeFSP.writeFile(NodePath.join(repository, "README.md"), "primary\n");
  await git(repository, "add", "README.md");
  await git(
    repository,
    "-c",
    "user.name=MK Code Test",
    "-c",
    "user.email=mkcode@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  return { root, repository, state };
};

const plan = async (
  manager: GitWorktreeWorkspaceManager,
  fixture: Awaited<ReturnType<typeof makeRepository>>,
  overrides: Partial<Parameters<GitWorktreeWorkspaceManager["plan"]>[0]> = {},
) =>
  manager.plan({
    workspaceId: "workspace-1",
    workflowRunId: "workflow-1",
    projectId: "example-project",
    sourceRepositoryPath: fixture.repository,
    requestedBaseBranch: "main",
    configuredWorktreeRoot: NodePath.join(fixture.repository, ".mkcode", "worktrees"),
    factoryStateRoot: fixture.state,
    createdAt: "2026-07-17T00:00:00.000Z",
    ownershipNonce: "nonce-1",
    ...overrides,
  });

const inspectionInput = (
  value: WorkspaceAllocationPlan,
  allocated: Awaited<ReturnType<GitWorktreeWorkspaceManager["allocate"]>>,
) => ({
  workspaceId: value.workspaceId,
  workflowRunId: value.workflowRunId,
  projectId: value.projectId,
  canonicalSourceRepositoryPath: value.canonicalSourceRepositoryPath,
  gitCommonDirectory: value.gitCommonDirectory,
  canonicalWorktreePath: allocated.canonicalWorktreePath,
  branchName: value.branchName,
  resolvedBaseCommit: value.resolvedBaseCommit,
  ownershipClaimPath: value.ownershipClaimPath,
  ownershipMarkerPath: allocated.ownershipMarkerPath,
  ownershipMarkerDigest: allocated.ownershipMarkerDigest,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true })));
});

describe("GitWorktreeWorkspaceManager", () => {
  it("resolves the base to a commit and plans a factory-owned deterministic branch", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const head = (await git(fixture.repository, "rev-parse", "HEAD")).stdout.trim();
    NodeAssert.equal(value.resolvedBaseCommit, head);
    NodeAssert.equal(value.branchName, generatedWorkspaceBranch("workflow-1"));
    NodeAssert.notEqual(value.branchName, generatedWorkspaceBranch("workflow-2"));
    NodeAssert.equal(
      value.worktreePath.startsWith(NodePath.join(fixture.state, "worktrees")),
      true,
    );
    NodeAssert.equal(value.worktreePath.startsWith(fixture.repository), false);
  });

  it("creates a worktree at the recorded commit without dirtying the primary checkout", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const primaryHead = (await git(fixture.repository, "rev-parse", "HEAD")).stdout.trim();
    const allocated = await manager.allocate(value);

    NodeAssert.equal(allocated.head, primaryHead);
    NodeAssert.equal(allocated.branchName, value.branchName);
    NodeAssert.equal((await git(fixture.repository, "status", "--porcelain")).stdout, "");
    NodeAssert.equal(
      (await git(fixture.repository, "branch", "--show-current")).stdout.trim(),
      "main",
    );
    NodeAssert.equal(
      (await git(allocated.canonicalWorktreePath, "status", "--porcelain")).stdout,
      "",
    );
    NodeAssert.equal(
      NodePath.dirname(allocated.ownershipMarkerPath).startsWith(value.gitCommonDirectory),
      true,
    );
    const { ownershipMarkerPath: _recordedMarker, ...withoutRecordedMarker } = inspectionInput(
      value,
      allocated,
    );
    NodeAssert.equal(
      (await manager.inspect(withoutRecordedMarker)).ownershipMarkerPath,
      allocated.ownershipMarkerPath,
    );
    NodeAssert.equal(permissionBits((await NodeFSP.stat(value.effectiveWorktreeRoot)).mode), 0o700);
    NodeAssert.equal(
      permissionBits((await NodeFSP.stat(allocated.canonicalWorktreePath)).mode),
      0o700,
    );
    NodeAssert.equal(
      permissionBits((await NodeFSP.stat(allocated.ownershipMarkerPath)).mode),
      0o600,
    );
    const replayed = await manager.allocate(value);
    NodeAssert.equal(replayed.canonicalWorktreePath, allocated.canonicalWorktreePath);
    NodeAssert.equal(replayed.ownershipMarkerDigest, allocated.ownershipMarkerDigest);
    await NodeFSP.writeFile(
      NodePath.join(allocated.canonicalWorktreePath, "builder-output.txt"),
      "bounded edit\n",
      "utf8",
    );
    const evidence = await manager.captureGitEvidence(inspectionInput(value, allocated));
    NodeAssert.equal(evidence.head, primaryHead);
    NodeAssert.equal(evidence.branch, value.branchName);
    NodeAssert.deepEqual(evidence.untrackedPaths, ["builder-output.txt"]);
    NodeAssert.equal(evidence.dirty, true);
    NodeAssert.equal(evidence.ownershipMarkerDigest, allocated.ownershipMarkerDigest);
  });

  it("resumes a matching allocation interrupted immediately after Git adds the worktree", async () => {
    const fixture = await makeRepository();
    let failAfterAdd = true;
    const manager = new GitWorktreeWorkspaceManager({
      afterWorktreeAdded: () => {
        if (failAfterAdd) throw new Error("injected failure after worktree add");
      },
    });
    const value = await plan(manager, fixture);
    await NodeAssert.rejects(() => manager.allocate(value), /injected failure/u);
    const claim = await NodeFSP.readFile(value.ownershipClaimPath, "utf8");
    NodeAssert.equal(permissionBits((await NodeFSP.stat(value.ownershipClaimPath)).mode), 0o600);
    NodeAssert.equal(
      (await git(fixture.repository, "worktree", "list", "--porcelain")).stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
      2,
    );
    await NodeFSP.writeFile(value.ownershipClaimPath, "{}\n", { mode: 0o600 });
    await NodeAssert.rejects(
      () => manager.allocate(value),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "path_collision",
    );
    await NodeFSP.writeFile(value.ownershipClaimPath, claim, { mode: 0o600 });

    failAfterAdd = false;
    const allocated = await manager.allocate(value);
    NodeAssert.equal(allocated.head, value.resolvedBaseCommit);
    NodeAssert.equal((await manager.inspect(inspectionInput(value, allocated))).state, "matching");
    await NodeAssert.rejects(() => NodeFSP.stat(value.ownershipClaimPath));
    NodeAssert.equal((await git(fixture.repository, "status", "--porcelain")).stdout, "");
  });

  it("refuses to emit Git evidence when the status snapshot never stabilizes", async () => {
    const fixture = await makeRepository();
    let worktreePath = "";
    let mutation = 0;
    const manager = new GitWorktreeWorkspaceManager({
      beforeEvidenceStabilityCheck: async () => {
        mutation += 1;
        await NodeFSP.writeFile(
          NodePath.join(worktreePath, `concurrent-${mutation}.txt`),
          "change\n",
        );
      },
    });
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    worktreePath = allocated.canonicalWorktreePath;
    await NodeAssert.rejects(
      () => manager.captureGitEvidence(inspectionInput(value, allocated)),
      /changed repeatedly/u,
    );
  });

  it("rejects ownership-marker changes during Git evidence collection", async () => {
    const fixture = await makeRepository();
    let markerPath = "";
    const manager = new GitWorktreeWorkspaceManager({
      beforeEvidenceStabilityCheck: async () => {
        await NodeFSP.writeFile(markerPath, "{}\n", "utf8");
      },
    });
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    markerPath = allocated.ownershipMarkerPath;
    await NodeAssert.rejects(
      () => manager.captureGitEvidence(inspectionInput(value, allocated)),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "ownership_mismatch",
    );
  });

  it("rejects truncated porcelain status instead of enforcing policy on partial paths", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    for (let index = 0; index < 1_600; index += 1) {
      const name = `${String(index).padStart(4, "0")}-${"x".repeat(80)}.txt`;
      await NodeFSP.writeFile(NodePath.join(allocated.canonicalWorktreePath, name), "change\n");
    }
    await NodeAssert.rejects(
      () => manager.captureGitEvidence(inspectionInput(value, allocated)),
      /exceeded the collection limit/u,
    );
  });

  it("publishes ownership evidence atomically after an interrupted marker finalization", async () => {
    const fixture = await makeRepository();
    let interruptFinalization = true;
    const manager = new GitWorktreeWorkspaceManager({
      beforeOwnershipMarkerPublished: () => {
        if (interruptFinalization) throw new Error("injected failure before marker publish");
      },
    });
    const value = await plan(manager, fixture);

    await NodeAssert.rejects(
      () => manager.allocate(value),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "ownership_ambiguous",
    );
    const gitDirectory = (
      await git(value.worktreePath, "rev-parse", "--absolute-git-dir")
    ).stdout.trim();
    const markerPath = NodePath.join(gitDirectory, "mkcode-workspace.json");
    await NodeAssert.rejects(() => NodeFSP.lstat(markerPath));
    NodeAssert.equal(
      (await NodeFSP.readdir(gitDirectory)).some((name) =>
        name.startsWith(".mkcode-workspace.json."),
      ),
      false,
    );
    NodeAssert.equal(permissionBits((await NodeFSP.stat(value.ownershipClaimPath)).mode), 0o600);

    interruptFinalization = false;
    const allocated = await manager.allocate(value);
    NodeAssert.equal(allocated.ownershipMarkerPath, markerPath);
    NodeAssert.equal(permissionBits((await NodeFSP.stat(markerPath)).mode), 0o600);
    await NodeAssert.rejects(() => NodeFSP.lstat(value.ownershipClaimPath));
  });

  it("discards only a matching pre-allocation claim when no Git side effect exists", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const input = {
      workspaceId: value.workspaceId,
      workflowRunId: value.workflowRunId,
      projectId: value.projectId,
      canonicalSourceRepositoryPath: value.canonicalSourceRepositoryPath,
      gitCommonDirectory: value.gitCommonDirectory,
      canonicalWorktreePath: value.worktreePath,
      branchName: value.branchName,
      resolvedBaseCommit: value.resolvedBaseCommit,
      ownershipClaimPath: value.ownershipClaimPath,
      ownershipMarkerDigest: value.markerDigest,
    };
    await NodeFSP.mkdir(NodePath.dirname(value.ownershipClaimPath), {
      recursive: true,
      mode: 0o700,
    });
    await NodeFSP.writeFile(value.ownershipClaimPath, `${JSON.stringify(value.marker)}\n`, {
      mode: 0o600,
    });

    const inspection = await manager.inspect(input);
    NodeAssert.equal(inspection.state, "missing");
    NodeAssert.equal(inspection.claimValid, true);
    NodeAssert.equal(inspection.gitMetadataState, "ownership_claim_without_side_effect");
    await manager.discardAllocationClaim(input);
    await NodeAssert.rejects(() => NodeFSP.lstat(value.ownershipClaimPath));
    NodeAssert.equal((await manager.inspect(input)).gitMetadataState, "absent");
  });

  it("records a dirty primary checkout but does not copy its change", async () => {
    const fixture = await makeRepository();
    await NodeFSP.writeFile(NodePath.join(fixture.repository, "README.md"), "dirty primary\n");
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    NodeAssert.equal(value.primaryCheckoutDirty, true);
    NodeAssert.equal(
      await NodeFSP.readFile(NodePath.join(allocated.canonicalWorktreePath, "README.md"), "utf8"),
      "primary\n",
    );
  });

  it("disables repository-controlled hooks during worktree allocation", async () => {
    const fixture = await makeRepository();
    const hook = NodePath.join(fixture.repository, ".git", "hooks", "post-checkout");
    await NodeFSP.writeFile(hook, "#!/bin/sh\ntouch hook-ran\n", { mode: 0o755 });
    await NodeFSP.chmod(hook, 0o755);
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    await NodeAssert.rejects(() =>
      NodeFSP.stat(NodePath.join(allocated.canonicalWorktreePath, "hook-ran")),
    );
    await NodeAssert.rejects(() => NodeFSP.stat(NodePath.join(fixture.repository, "hook-ran")));
  });

  it("rejects missing base refs, non-Git directories, and symlinked repositories", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    await NodeAssert.rejects(
      () => plan(manager, fixture, { requestedBaseBranch: "missing" }),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "base_ref_missing",
    );
    const nonGit = NodePath.join(fixture.root, "non-git");
    await NodeFSP.mkdir(nonGit);
    await NodeAssert.rejects(
      () => plan(manager, fixture, { sourceRepositoryPath: nonGit }),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "repository_not_git",
    );
    const missing = NodePath.join(fixture.root, "missing");
    await NodeAssert.rejects(
      () => plan(manager, fixture, { sourceRepositoryPath: missing }),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "repository_not_found",
    );
    const file = NodePath.join(fixture.root, "file");
    await NodeFSP.writeFile(file, "not a repository\n");
    await NodeAssert.rejects(
      () => plan(manager, fixture, { sourceRepositoryPath: file }),
      (cause) =>
        cause instanceof WorkspaceManagerError && cause.code === "repository_not_directory",
    );
    const linked = NodePath.join(fixture.root, "linked-repository");
    await NodeFSP.symlink(fixture.repository, linked);
    await NodeAssert.rejects(
      () => plan(manager, fixture, { sourceRepositoryPath: linked }),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "repository_symlink",
    );
    const linkedWorktree = NodePath.join(fixture.root, "linked-worktree");
    await git(fixture.repository, "worktree", "add", "-b", "linked-test", linkedWorktree, "main");
    await NodeAssert.rejects(
      () => plan(manager, fixture, { sourceRepositoryPath: linkedWorktree }),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "repository_not_git",
    );
  });

  it("blocks allocation while the primary repository has a dangerous Git operation", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    await NodeFSP.writeFile(NodePath.join(fixture.repository, ".git", "MERGE_HEAD"), "deadbeef\n");
    await NodeAssert.rejects(
      () => plan(manager, fixture),
      (cause) =>
        cause instanceof WorkspaceManagerError && cause.code === "repository_operation_in_progress",
    );
  });

  it("rejects repository-local execution-capable Git configuration", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    await git(fixture.repository, "config", "filter.mkcode-test.smudge", "touch should-not-run");
    await NodeAssert.rejects(
      () => plan(manager, fixture),
      (cause) =>
        cause instanceof WorkspaceManagerError && cause.code === "repository_unsafe_config",
    );
    await NodeAssert.rejects(() =>
      NodeFSP.stat(NodePath.join(fixture.repository, "should-not-run")),
    );
  });

  it("rechecks repository-local filters immediately before worktree creation", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    await NodeFSP.writeFile(
      NodePath.join(fixture.repository, ".gitattributes"),
      "*.txt filter=probe\n",
    );
    await NodeFSP.writeFile(NodePath.join(fixture.repository, "payload.txt"), "payload\n");
    await git(fixture.repository, "add", ".gitattributes", "payload.txt");
    await git(
      fixture.repository,
      "-c",
      "user.name=MK Code Test",
      "-c",
      "user.email=mkcode@example.invalid",
      "commit",
      "-m",
      "add filter fixture",
    );
    const value = await plan(manager, fixture);
    const sentinel = NodePath.join(fixture.root, "filter-executed");
    await git(fixture.repository, "config", "filter.probe.smudge", `touch '${sentinel}'; cat`);

    await NodeAssert.rejects(
      () => manager.allocate(value),
      (cause) =>
        cause instanceof WorkspaceManagerError && cause.code === "repository_unsafe_config",
    );
    await NodeAssert.rejects(() => NodeFSP.lstat(sentinel));
    await NodeAssert.rejects(() => NodeFSP.lstat(value.worktreePath));
  });

  it("rejects execution-capable filters before inspecting worktree status", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    await NodeFSP.writeFile(
      NodePath.join(fixture.repository, ".gitattributes"),
      "*.txt filter=probe\n",
    );
    await NodeFSP.writeFile(NodePath.join(fixture.repository, "payload.txt"), "payload\n");
    await git(fixture.repository, "add", ".gitattributes", "payload.txt");
    await git(
      fixture.repository,
      "-c",
      "user.name=MK Code Test",
      "-c",
      "user.email=mkcode@example.invalid",
      "commit",
      "-m",
      "add inspection filter fixture",
    );
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    const sentinel = NodePath.join(fixture.root, "inspection-filter-executed");
    await git(fixture.repository, "config", "filter.probe.clean", `touch '${sentinel}'; cat`);

    await NodeAssert.rejects(
      () => manager.inspect(inspectionInput(value, allocated)),
      (cause) =>
        cause instanceof WorkspaceManagerError && cause.code === "repository_unsafe_config",
    );
    await NodeAssert.rejects(() => NodeFSP.lstat(sentinel));
  });

  it("does not discard a claim when branch absence cannot be verified", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const input = {
      workspaceId: value.workspaceId,
      workflowRunId: value.workflowRunId,
      projectId: value.projectId,
      canonicalSourceRepositoryPath: value.canonicalSourceRepositoryPath,
      gitCommonDirectory: value.gitCommonDirectory,
      canonicalWorktreePath: value.worktreePath,
      branchName: value.branchName,
      resolvedBaseCommit: value.resolvedBaseCommit,
      ownershipClaimPath: value.ownershipClaimPath,
      ownershipMarkerDigest: value.markerDigest,
    };
    await NodeFSP.mkdir(NodePath.dirname(value.ownershipClaimPath), {
      recursive: true,
      mode: 0o700,
    });
    await NodeFSP.writeFile(value.ownershipClaimPath, `${JSON.stringify(value.marker)}\n`, {
      mode: 0o600,
    });
    const packedRefs = NodePath.join(value.gitCommonDirectory, "packed-refs");
    await NodeFSP.writeFile(packedRefs, "not a packed ref\n");
    try {
      await NodeAssert.rejects(
        () => manager.inspect(input),
        (cause) => cause instanceof WorkspaceManagerError && cause.code === "git_failed",
      );
      NodeAssert.equal((await NodeFSP.lstat(value.ownershipClaimPath)).isFile(), true);
    } finally {
      await NodeFSP.rm(packedRefs, { force: true });
    }
  });

  it("rejects path and branch collisions without force-resetting either", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    await NodeFSP.mkdir(value.worktreePath);
    await NodeAssert.rejects(
      () => manager.allocate(value),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "path_collision",
    );
    await NodeFSP.rmdir(value.worktreePath);
    await git(fixture.repository, "branch", value.branchName, value.resolvedBaseCommit);
    await NodeAssert.rejects(
      () => manager.allocate(value),
      (cause) => cause instanceof WorkspaceManagerError && cause.code === "branch_collision",
    );
    NodeAssert.equal(
      (await git(fixture.repository, "rev-parse", value.branchName)).stdout.trim(),
      value.resolvedBaseCommit,
    );
  });

  it("refuses cleanup when the worktree is dirty or ownership evidence changes", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    const input = inspectionInput(value, allocated);
    const wrongOwner = { ...input, workspaceId: "different-workspace" };
    NodeAssert.equal((await manager.inspect(wrongOwner)).state, "ownership_mismatch");
    NodeAssert.deepEqual(await manager.remove(wrongOwner), {
      removed: false,
      branchRetained: true,
      reason: "ownership_mismatch",
    });
    await NodeFSP.writeFile(
      NodePath.join(allocated.canonicalWorktreePath, "generated.txt"),
      "deliberate\n",
    );
    NodeAssert.deepEqual(await manager.remove(input), {
      removed: false,
      branchRetained: true,
      reason: "modified",
    });
    await NodeFSP.rm(NodePath.join(allocated.canonicalWorktreePath, "generated.txt"));
    await NodeFSP.writeFile(allocated.ownershipMarkerPath, "{}\n");
    NodeAssert.deepEqual(await manager.remove(input), {
      removed: false,
      branchRetained: true,
      reason: "ownership_mismatch",
    });
    NodeAssert.equal(
      await NodeFSP.realpath(allocated.canonicalWorktreePath),
      allocated.canonicalWorktreePath,
    );
  });

  it("refuses cleanup for symlinked ownership evidence and locked worktrees", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    const input = inspectionInput(value, allocated);
    const externalMarker = NodePath.join(fixture.root, "external-marker.json");
    await NodeFSP.writeFile(externalMarker, "{}\n");
    await NodeFSP.rm(allocated.ownershipMarkerPath);
    await NodeFSP.symlink(externalMarker, allocated.ownershipMarkerPath);
    NodeAssert.equal((await manager.inspect(input)).state, "ownership_mismatch");
    NodeAssert.equal((await manager.remove(input)).reason, "ownership_mismatch");

    await NodeFSP.rm(allocated.ownershipMarkerPath);
    await NodeFSP.writeFile(allocated.ownershipMarkerPath, `${JSON.stringify(value.marker)}\n`, {
      mode: 0o600,
    });
    await git(fixture.repository, "worktree", "lock", allocated.canonicalWorktreePath);
    NodeAssert.equal((await manager.remove(input)).reason, "locked");
    NodeAssert.equal(
      await NodeFSP.realpath(allocated.canonicalWorktreePath),
      allocated.canonicalWorktreePath,
    );
  });

  it("detects detached HEAD and refuses a persisted marker path outside Git administration", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    const input = inspectionInput(value, allocated);
    await git(allocated.canonicalWorktreePath, "checkout", "--detach");
    NodeAssert.equal((await manager.inspect(input)).state, "detached_head");

    const forgedPath = NodePath.join(fixture.root, "forged-marker.json");
    await NodeFSP.writeFile(forgedPath, `${JSON.stringify(value.marker)}\n`);
    NodeAssert.equal(
      (
        await manager.inspect({
          ...input,
          ownershipMarkerPath: forgedPath,
        })
      ).state,
      "ownership_mismatch",
    );
  });

  it("reports a moved source repository as ambiguous instead of throwing during reconciliation", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const allocated = await manager.allocate(value);
    const moved = NodePath.join(fixture.root, "moved-primary");
    await NodeFSP.rename(fixture.repository, moved);
    const inspection = await manager.inspect(inspectionInput(value, allocated));
    NodeAssert.equal(inspection.state, "wrong_repository");
    NodeAssert.equal(inspection.gitMetadataState, "source_repository_unavailable");
  });

  it("removes only a clean owned worktree and retains its branch and primary checkout", async () => {
    const fixture = await makeRepository();
    const manager = new GitWorktreeWorkspaceManager();
    const value = await plan(manager, fixture);
    const primaryHead = (await git(fixture.repository, "rev-parse", "HEAD")).stdout.trim();
    const allocated = await manager.allocate(value);
    const result = await manager.remove(inspectionInput(value, allocated));
    NodeAssert.deepEqual(result, { removed: true, branchRetained: true });
    await NodeAssert.rejects(() => NodeFSP.realpath(allocated.canonicalWorktreePath));
    NodeAssert.equal(
      (await git(fixture.repository, "rev-parse", value.branchName)).stdout.trim(),
      primaryHead,
    );
    NodeAssert.equal(
      (await git(fixture.repository, "branch", "--show-current")).stdout.trim(),
      "main",
    );
    NodeAssert.equal((await git(fixture.repository, "status", "--porcelain")).stdout, "");
  });
});
