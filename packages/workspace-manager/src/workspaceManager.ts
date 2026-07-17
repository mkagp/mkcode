// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off -- Git subprocesses have bounded wall-clock deadlines.
// @effect-diagnostics globalDate:off -- Durable resolution evidence uses an ISO wall-clock timestamp.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const GIT_TIMEOUT_MILLISECONDS = 30_000;
const MAX_GIT_OUTPUT_BYTES = 131_072;
const MARKER_FILE_NAME = "mkcode-workspace.json";
const CLAIMS_DIRECTORY_NAME = ".claims";
const SHA = /^[0-9a-f]{40,64}$/u;
const SAFE_COMPONENT = /[^a-z0-9-]+/gu;

export type WorkspaceManagerErrorCode =
  | "repository_not_found"
  | "repository_not_directory"
  | "repository_not_git"
  | "repository_symlink"
  | "repository_operation_in_progress"
  | "repository_unsafe_config"
  | "base_ref_missing"
  | "path_collision"
  | "branch_collision"
  | "permission_denied"
  | "git_failed"
  | "git_timeout"
  | "ownership_ambiguous"
  | "ownership_mismatch"
  | "workspace_missing"
  | "workspace_modified"
  | "workspace_locked"
  | "unsafe_path";

export class WorkspaceManagerError extends Error {
  readonly code: WorkspaceManagerErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: WorkspaceManagerErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>,
  ) {
    super(message);
    this.name = "WorkspaceManagerError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export interface WorkspaceOwnershipMarker {
  readonly schemaVersion: 1;
  readonly workspaceId: string;
  readonly workflowRunId: string;
  readonly projectId: string;
  readonly sourceRepositoryIdentity: string;
  readonly baseCommit: string;
  readonly branchName: string;
  readonly createdAt: string;
  readonly ownershipNonce: string;
}

export interface WorkspaceAllocationPlan {
  readonly workspaceId: string;
  readonly workflowRunId: string;
  readonly projectId: string;
  readonly sourceRepositoryPath: string;
  readonly canonicalSourceRepositoryPath: string;
  readonly gitCommonDirectory: string;
  readonly requestedBaseBranch: string;
  readonly resolvedBaseReference?: string;
  readonly resolvedBaseCommit: string;
  readonly baseResolvedAt: string;
  readonly branchName: string;
  readonly configuredWorktreeRoot: string;
  readonly effectiveWorktreeRoot: string;
  readonly gitHooksPath: string;
  readonly worktreePath: string;
  readonly ownershipClaimPath: string;
  readonly primaryCheckoutPath: string;
  readonly primaryCheckoutDirty: boolean;
  readonly marker: WorkspaceOwnershipMarker;
  readonly markerDigest: string;
}

export interface AllocatedWorkspace {
  readonly canonicalWorktreePath: string;
  readonly ownershipMarkerPath: string;
  readonly ownershipMarkerDigest: string;
  readonly gitCommonDirectory: string;
  readonly head: string;
  readonly branchName: string;
  readonly dirty: boolean;
  readonly gitMetadataState: "registered";
}

export interface InspectWorkspaceInput {
  readonly workspaceId: string;
  readonly workflowRunId: string;
  readonly projectId: string;
  readonly canonicalSourceRepositoryPath: string;
  readonly gitCommonDirectory: string;
  readonly canonicalWorktreePath: string;
  readonly branchName: string;
  readonly resolvedBaseCommit: string;
  readonly ownershipMarkerPath?: string;
  readonly ownershipClaimPath?: string;
  readonly ownershipMarkerDigest: string;
}

export type WorkspaceInspectionState =
  | "matching"
  | "missing"
  | "path_collision"
  | "wrong_repository"
  | "wrong_branch"
  | "allocation_incomplete"
  | "ownership_mismatch"
  | "detached_head";

export interface WorkspaceInspection {
  readonly state: WorkspaceInspectionState;
  readonly canonicalPath?: string;
  readonly gitMetadataPresent: boolean;
  readonly markerValid: boolean;
  readonly claimValid?: boolean;
  readonly ownershipMarkerPath?: string;
  readonly observedHead?: string;
  readonly observedBranch?: string;
  readonly dirty?: boolean;
  readonly locked?: boolean;
  readonly gitMetadataState: string;
  readonly reason?: string;
}

export interface WorkspaceRemovalResult {
  readonly removed: boolean;
  readonly branchRetained: boolean;
  readonly reason?: "already_removed" | "modified" | "locked" | "ownership_mismatch";
}

export interface WorkspaceManager {
  plan(input: {
    readonly workspaceId: string;
    readonly workflowRunId: string;
    readonly projectId: string;
    readonly sourceRepositoryPath: string;
    readonly requestedBaseBranch: string;
    readonly configuredWorktreeRoot: string;
    readonly factoryStateRoot: string;
    readonly createdAt: string;
    readonly ownershipNonce: string;
  }): Promise<WorkspaceAllocationPlan>;
  allocate(plan: WorkspaceAllocationPlan): Promise<AllocatedWorkspace>;
  resume(input: InspectWorkspaceInput): Promise<AllocatedWorkspace>;
  inspect(input: InspectWorkspaceInput): Promise<WorkspaceInspection>;
  discardAllocationClaim(input: InspectWorkspaceInput): Promise<void>;
  retain(input: InspectWorkspaceInput): Promise<WorkspaceInspection>;
  remove(input: InspectWorkspaceInput): Promise<WorkspaceRemovalResult>;
}

interface WorkspaceManagerHooks {
  readonly afterWorktreeAdded?: () => void | Promise<void>;
  readonly beforeOwnershipMarkerPublished?: () => void | Promise<void>;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

const redactGitOutput = (value: string): string =>
  value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "[REDACTED]")
    .replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, "[REDACTED]")
    .slice(0, 4_096);

const gitEnvironment = (hooksPath?: string): NodeJS.ProcessEnv => {
  const emptyConfigPath = NodeProcess.platform === "win32" ? "NUL" : "/dev/null";
  const environment: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfigPath,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooksPath ?? emptyConfigPath,
    GIT_CONFIG_KEY_1: "core.fsmonitor",
    GIT_CONFIG_VALUE_1: "false",
  };
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL"] as const) {
    const value = NodeProcess.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const runGit = async (
  args: ReadonlyArray<string>,
  options: { readonly hooksPath?: string } = {},
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", [...args], {
      shell: false,
      detached: NodeProcess.platform === "linux",
      env: gitEnvironment(options.hooksPath),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const append = (target: Array<Buffer>, chunk: Buffer, bytes: number): number => {
      const remaining = MAX_GIT_OUTPUT_BYTES - bytes;
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      return bytes + chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (NodeProcess.platform === "linux" && child.pid) NodeProcess.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {
          reject(cause);
          return;
        }
      }
      reject(new WorkspaceManagerError("git_timeout", "Git operation exceeded its deadline."));
    }, GIT_TIMEOUT_MILLISECONDS);
    timer.unref();
    child.once("error", (cause: NodeJS.ErrnoException) => {
      settled = true;
      clearTimeout(timer);
      reject(
        new WorkspaceManagerError(
          cause.code === "EACCES" ? "permission_denied" : "git_failed",
          "Git could not be started.",
        ),
      );
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdoutTruncated: stdoutBytes > MAX_GIT_OUTPUT_BYTES,
        stderrTruncated: stderrBytes > MAX_GIT_OUTPUT_BYTES,
      };
      if (exitCode === 0) resolve(result);
      else {
        reject(
          new WorkspaceManagerError("git_failed", "Git operation failed.", {
            exitCode: exitCode ?? -1,
            stderr: redactGitOutput(result.stderr),
          }),
        );
      }
    });
  });

const exists = async (path: string): Promise<boolean> =>
  NodeFSP.lstat(path).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return false;
      throw cause;
    },
  );

const ensurePrivateDirectory = async (path: string): Promise<void> => {
  await NodeFSP.mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await NodeFSP.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceManagerError("unsafe_path", "Workspace root must be a real directory.");
  }
  await NodeFSP.chmod(path, 0o700);
};

const contained = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
};

const canonicalGitPath = async (base: string, value: string): Promise<string> =>
  NodeFSP.realpath(NodePath.isAbsolute(value) ? value : NodePath.resolve(base, value));

const digestMarker = (marker: WorkspaceOwnershipMarker): string =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(marker)).digest("hex");

const markerJson = (marker: WorkspaceOwnershipMarker): string => `${JSON.stringify(marker)}\n`;

const writeMarker = async (
  path: string,
  marker: WorkspaceOwnershipMarker,
  beforePublish?: () => void | Promise<void>,
): Promise<void> => {
  const temporaryPath = NodePath.join(
    NodePath.dirname(path),
    `.${NodePath.basename(path)}.${NodeCrypto.randomUUID()}.tmp`,
  );
  try {
    const handle = await NodeFSP.open(
      temporaryPath,
      NodeFS.constants.O_CREAT |
        NodeFS.constants.O_EXCL |
        NodeFS.constants.O_WRONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(markerJson(marker), "utf8");
      await handle.chmod(0o600);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforePublish?.();
    // A hard-link publish is atomic and, unlike rename, cannot replace existing evidence.
    await NodeFSP.link(temporaryPath, path);
    if (NodeProcess.platform !== "win32") {
      const directory = await NodeFSP.open(NodePath.dirname(path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    await NodeFSP.rm(temporaryPath, { force: true });
  }
};

const readMarker = async (
  path: string,
): Promise<{ readonly marker: WorkspaceOwnershipMarker; readonly digest: string } | undefined> => {
  try {
    const stat = await NodeFSP.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return undefined;
    const contents = await NodeFSP.readFile(path, "utf8");
    const parsed = JSON.parse(contents) as WorkspaceOwnershipMarker;
    return { marker: parsed, digest: digestMarker(parsed) };
  } catch {
    return undefined;
  }
};

const markerMatchesInspection = (
  marker: WorkspaceOwnershipMarker,
  input: InspectWorkspaceInput,
): boolean =>
  marker.schemaVersion === 1 &&
  marker.workspaceId === input.workspaceId &&
  marker.workflowRunId === input.workflowRunId &&
  marker.projectId === input.projectId &&
  marker.sourceRepositoryIdentity === input.gitCommonDirectory &&
  marker.baseCommit === input.resolvedBaseCommit &&
  marker.branchName === input.branchName;

const currentBranch = async (worktree: string): Promise<string | undefined> => {
  try {
    const result = await runGit(["-C", worktree, "symbolic-ref", "--quiet", "--short", "HEAD"]);
    return result.stdout.trim();
  } catch {
    return undefined;
  }
};

const localBranchExists = async (source: string, branchName: string): Promise<boolean> => {
  const reference = `refs/heads/${branchName}`;
  const result = await runGit(["-C", source, "for-each-ref", "--format=%(refname)", reference]);
  return result.stdout.split("\n").some((line) => line.trim() === reference);
};

const assertSafeRepositoryConfig = async (source: string): Promise<void> => {
  try {
    const unsafeConfig = await runGit([
      "-C",
      source,
      "config",
      "--local",
      "--includes",
      "--get-regexp",
      "^(core\\.fsmonitor|filter\\..*\\.(clean|smudge|process|required))$",
    ]);
    if (unsafeConfig.stdout.trim().length > 0) {
      throw new WorkspaceManagerError(
        "repository_unsafe_config",
        "Repository-local Git configuration contains execution-capable helpers.",
      );
    }
  } catch (cause) {
    if (cause instanceof WorkspaceManagerError && cause.code === "repository_unsafe_config") {
      throw cause;
    }
    if (
      !(cause instanceof WorkspaceManagerError) ||
      cause.code !== "git_failed" ||
      cause.details?.exitCode !== 1
    ) {
      throw cause;
    }
  }
};

const worktreeMetadata = async (
  sourceRepository: string,
  expectedPath: string,
): Promise<{ readonly present: boolean; readonly locked: boolean }> => {
  const result = await runGit(["-C", sourceRepository, "worktree", "list", "--porcelain"]);
  if (result.stdoutTruncated) {
    throw new WorkspaceManagerError(
      "ownership_ambiguous",
      "Git worktree metadata exceeded the safe inspection limit.",
    );
  }
  const records = result.stdout.split(/\n\n+/u);
  for (const record of records) {
    const lines = record.split("\n");
    const pathLine = lines.find((line) => line.startsWith("worktree "));
    if (!pathLine) continue;
    let listedPath: string;
    try {
      listedPath = await NodeFSP.realpath(pathLine.slice("worktree ".length));
    } catch {
      listedPath = NodePath.resolve(pathLine.slice("worktree ".length));
    }
    if (listedPath === expectedPath) {
      return { present: true, locked: lines.some((line) => line.startsWith("locked")) };
    }
  }
  return { present: false, locked: false };
};

export const generatedWorkspaceBranch = (workflowRunId: string): string => {
  const normalized = workflowRunId
    .toLowerCase()
    .replace(SAFE_COMPONENT, "-")
    .replace(/^-+|-+$/gu, "");
  const digest = NodeCrypto.createHash("sha256").update(workflowRunId).digest("hex").slice(0, 12);
  const prefix = normalized.slice(0, 72) || "run";
  return `mkcode/run-${prefix}-${digest}`;
};

export class GitWorktreeWorkspaceManager implements WorkspaceManager {
  readonly #hooks: WorkspaceManagerHooks;

  constructor(hooks: WorkspaceManagerHooks = {}) {
    this.#hooks = hooks;
  }

  async plan(input: Parameters<WorkspaceManager["plan"]>[0]): Promise<WorkspaceAllocationPlan> {
    const requestedSource = NodePath.resolve(input.sourceRepositoryPath);
    let sourceStat;
    try {
      sourceStat = await NodeFSP.lstat(requestedSource);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        throw new WorkspaceManagerError(
          "repository_not_found",
          "Registered repository is unavailable.",
        );
      }
      throw cause;
    }
    if (sourceStat.isSymbolicLink()) {
      throw new WorkspaceManagerError(
        "repository_symlink",
        "Registered repository path must not be a symlink.",
      );
    }
    if (!sourceStat.isDirectory()) {
      throw new WorkspaceManagerError(
        "repository_not_directory",
        "Registered repository path is not a directory.",
      );
    }
    const source = await NodeFSP.realpath(requestedSource);
    let topLevel: string;
    let gitDirectory: string;
    let commonDirectory: string;
    try {
      const top = await runGit(["-C", source, "rev-parse", "--show-toplevel"]);
      topLevel = await NodeFSP.realpath(top.stdout.trim());
      const git = await runGit(["-C", source, "rev-parse", "--git-dir"]);
      gitDirectory = await canonicalGitPath(source, git.stdout.trim());
      const common = await runGit(["-C", source, "rev-parse", "--git-common-dir"]);
      commonDirectory = await canonicalGitPath(source, common.stdout.trim());
    } catch (cause) {
      if (cause instanceof WorkspaceManagerError && cause.code === "git_failed") {
        throw new WorkspaceManagerError(
          "repository_not_git",
          "Registered path is not a Git working tree.",
        );
      }
      throw cause;
    }
    if (topLevel !== source || gitDirectory !== commonDirectory) {
      throw new WorkspaceManagerError(
        "repository_not_git",
        "Registered path must be the primary Git checkout root.",
      );
    }
    await assertSafeRepositoryConfig(source);
    for (const operationPath of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "BISECT_LOG",
      "rebase-merge",
      "rebase-apply",
    ]) {
      if (await exists(NodePath.join(commonDirectory, operationPath))) {
        throw new WorkspaceManagerError(
          "repository_operation_in_progress",
          "The source repository has an in-progress Git operation.",
          { operation: operationPath },
        );
      }
    }
    let resolvedBaseCommit: string;
    try {
      resolvedBaseCommit = (
        await runGit([
          "-C",
          source,
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${input.requestedBaseBranch}^{commit}`,
        ])
      ).stdout
        .trim()
        .toLowerCase();
    } catch (cause) {
      if (
        !(cause instanceof WorkspaceManagerError) ||
        cause.code !== "git_failed" ||
        cause.details?.exitCode !== 1
      ) {
        throw cause;
      }
      throw new WorkspaceManagerError(
        "base_ref_missing",
        "Configured base branch does not resolve to a commit.",
      );
    }
    if (!SHA.test(resolvedBaseCommit)) {
      throw new WorkspaceManagerError(
        "base_ref_missing",
        "Configured base branch did not resolve safely.",
      );
    }
    let resolvedBaseReference: string | undefined;
    try {
      resolvedBaseReference = (
        await runGit([
          "-C",
          source,
          "rev-parse",
          "--symbolic-full-name",
          "--end-of-options",
          input.requestedBaseBranch,
        ])
      ).stdout.trim();
      if (resolvedBaseReference.length === 0) resolvedBaseReference = undefined;
    } catch {
      resolvedBaseReference = undefined;
    }
    const stateRoot = await NodeFSP.realpath(input.factoryStateRoot);
    const gitHooksPath = NodePath.join(stateRoot, "git-hooks-disabled");
    await ensurePrivateDirectory(gitHooksPath);
    const safeProject =
      input.projectId.toLowerCase().replace(SAFE_COMPONENT, "-").slice(0, 80) || "project";
    const effectiveRoot = NodePath.join(stateRoot, "worktrees", safeProject);
    if (contained(source, effectiveRoot) || contained(effectiveRoot, source)) {
      throw new WorkspaceManagerError(
        "unsafe_path",
        "Factory worktree root must be separate from the source checkout.",
      );
    }
    await ensurePrivateDirectory(NodePath.join(stateRoot, "worktrees"));
    await ensurePrivateDirectory(effectiveRoot);
    const canonicalEffectiveRoot = await NodeFSP.realpath(effectiveRoot);
    const claimsRoot = NodePath.join(canonicalEffectiveRoot, CLAIMS_DIRECTORY_NAME);
    await ensurePrivateDirectory(claimsRoot);
    const worktreePath = NodePath.join(canonicalEffectiveRoot, input.workspaceId);
    if (!contained(canonicalEffectiveRoot, worktreePath)) {
      throw new WorkspaceManagerError(
        "unsafe_path",
        "Workspace path escapes the factory-owned root.",
      );
    }
    const branchName = generatedWorkspaceBranch(input.workflowRunId);
    try {
      await runGit(["check-ref-format", "--branch", branchName]);
    } catch {
      throw new WorkspaceManagerError(
        "unsafe_path",
        "Generated workspace branch is not a valid Git ref.",
      );
    }
    const primaryDirty =
      (await runGit(["-C", source, "status", "--porcelain=v1", "--untracked-files=all"])).stdout
        .length > 0;
    const marker: WorkspaceOwnershipMarker = {
      schemaVersion: 1,
      workspaceId: input.workspaceId,
      workflowRunId: input.workflowRunId,
      projectId: input.projectId,
      sourceRepositoryIdentity: commonDirectory,
      baseCommit: resolvedBaseCommit,
      branchName,
      createdAt: input.createdAt,
      ownershipNonce: input.ownershipNonce,
    };
    return {
      workspaceId: input.workspaceId,
      workflowRunId: input.workflowRunId,
      projectId: input.projectId,
      sourceRepositoryPath: requestedSource,
      canonicalSourceRepositoryPath: source,
      gitCommonDirectory: commonDirectory,
      requestedBaseBranch: input.requestedBaseBranch,
      ...(resolvedBaseReference ? { resolvedBaseReference } : {}),
      resolvedBaseCommit,
      baseResolvedAt: new Date().toISOString(),
      branchName,
      configuredWorktreeRoot: input.configuredWorktreeRoot,
      effectiveWorktreeRoot: canonicalEffectiveRoot,
      gitHooksPath,
      worktreePath,
      ownershipClaimPath: NodePath.join(claimsRoot, `${input.workspaceId}.json`),
      primaryCheckoutPath: topLevel,
      primaryCheckoutDirty: primaryDirty,
      marker,
      markerDigest: digestMarker(marker),
    };
  }

  async allocate(plan: WorkspaceAllocationPlan): Promise<AllocatedWorkspace> {
    const inspectionInput: InspectWorkspaceInput = {
      workspaceId: plan.workspaceId,
      workflowRunId: plan.workflowRunId,
      projectId: plan.projectId,
      canonicalSourceRepositoryPath: plan.canonicalSourceRepositoryPath,
      gitCommonDirectory: plan.gitCommonDirectory,
      canonicalWorktreePath: plan.worktreePath,
      branchName: plan.branchName,
      resolvedBaseCommit: plan.resolvedBaseCommit,
      ownershipClaimPath: plan.ownershipClaimPath,
      ownershipMarkerDigest: plan.markerDigest,
    };

    if (await exists(plan.worktreePath)) {
      const inspection = await this.inspect(inspectionInput);
      if (inspection.state === "matching" || inspection.state === "allocation_incomplete") {
        return this.resume(inspectionInput);
      }
      throw new WorkspaceManagerError(
        "path_collision",
        "Factory worktree path already exists without matching ownership evidence.",
      );
    }

    if (await localBranchExists(plan.canonicalSourceRepositoryPath, plan.branchName)) {
      throw new WorkspaceManagerError(
        "branch_collision",
        "Factory branch already exists without proven ownership.",
      );
    }

    const existingClaim = await readMarker(plan.ownershipClaimPath);
    if (await exists(plan.ownershipClaimPath)) {
      if (
        existingClaim?.digest !== plan.markerDigest ||
        !markerMatchesInspection(existingClaim.marker, inspectionInput)
      ) {
        throw new WorkspaceManagerError(
          "ownership_mismatch",
          "Workspace allocation claim does not match the persisted allocation plan.",
        );
      }
    } else {
      await writeMarker(plan.ownershipClaimPath, plan.marker);
    }

    try {
      await assertSafeRepositoryConfig(plan.canonicalSourceRepositoryPath);
      await runGit(
        [
          "-C",
          plan.canonicalSourceRepositoryPath,
          "worktree",
          "add",
          "-b",
          plan.branchName,
          plan.worktreePath,
          plan.resolvedBaseCommit,
        ],
        { hooksPath: plan.gitHooksPath },
      );
    } catch (cause) {
      if (cause instanceof WorkspaceManagerError && cause.code === "git_failed") {
        throw new WorkspaceManagerError(
          "git_failed",
          "Git could not create the factory worktree.",
          cause.details,
        );
      }
      throw cause;
    }
    await this.#hooks.afterWorktreeAdded?.();
    return this.resume(inspectionInput);
  }

  async resume(input: InspectWorkspaceInput): Promise<AllocatedWorkspace> {
    let inspection = await this.inspect(input);
    if (inspection.state === "allocation_incomplete") {
      if (!input.ownershipClaimPath) {
        throw new WorkspaceManagerError(
          "ownership_mismatch",
          "Incomplete allocation has no persisted ownership claim path.",
        );
      }
      const claim = await readMarker(input.ownershipClaimPath);
      if (
        claim?.digest !== input.ownershipMarkerDigest ||
        !markerMatchesInspection(claim.marker, input) ||
        !inspection.canonicalPath
      ) {
        throw new WorkspaceManagerError(
          "ownership_mismatch",
          "Incomplete allocation ownership claim does not match durable state.",
        );
      }
      await NodeFSP.chmod(inspection.canonicalPath, 0o700);
      const gitDirectory = await canonicalGitPath(
        inspection.canonicalPath,
        (await runGit(["-C", inspection.canonicalPath, "rev-parse", "--git-dir"])).stdout.trim(),
      );
      const markerPath = NodePath.join(gitDirectory, MARKER_FILE_NAME);
      try {
        await writeMarker(markerPath, claim.marker, this.#hooks.beforeOwnershipMarkerPublished);
      } catch (cause) {
        throw new WorkspaceManagerError(
          "ownership_ambiguous",
          "Worktree exists but factory ownership evidence could not be finalized.",
          { cause: cause instanceof Error ? cause.message : "unknown" },
        );
      }
      await NodeFSP.rm(input.ownershipClaimPath, { force: true });
      inspection = await this.inspect({ ...input, ownershipMarkerPath: markerPath });
    }
    if (
      inspection.state !== "matching" ||
      !inspection.canonicalPath ||
      !inspection.ownershipMarkerPath ||
      !inspection.observedHead ||
      inspection.observedHead !== input.resolvedBaseCommit
    ) {
      throw new WorkspaceManagerError(
        "ownership_ambiguous",
        "Created worktree did not match the persisted allocation plan.",
      );
    }
    if (input.ownershipClaimPath) {
      await NodeFSP.rm(input.ownershipClaimPath, { force: true });
    }
    return {
      canonicalWorktreePath: inspection.canonicalPath,
      ownershipMarkerPath: inspection.ownershipMarkerPath,
      ownershipMarkerDigest: input.ownershipMarkerDigest,
      gitCommonDirectory: input.gitCommonDirectory,
      head: inspection.observedHead,
      branchName: inspection.observedBranch ?? input.branchName,
      dirty: inspection.dirty ?? false,
      gitMetadataState: "registered",
    };
  }

  async inspect(input: InspectWorkspaceInput): Promise<WorkspaceInspection> {
    const expectedPath = NodePath.resolve(input.canonicalWorktreePath);
    let sourceStat: NodeFS.Stats;
    let canonicalSource: string;
    try {
      sourceStat = await NodeFSP.lstat(input.canonicalSourceRepositoryPath);
      canonicalSource = await NodeFSP.realpath(input.canonicalSourceRepositoryPath);
    } catch {
      return {
        state: "wrong_repository",
        gitMetadataPresent: false,
        markerValid: false,
        gitMetadataState: "source_repository_unavailable",
        reason: "The registered source repository is unavailable.",
      };
    }
    if (
      !sourceStat.isDirectory() ||
      sourceStat.isSymbolicLink() ||
      canonicalSource !== input.canonicalSourceRepositoryPath
    ) {
      return {
        state: "wrong_repository",
        gitMetadataPresent: false,
        markerValid: false,
        gitMetadataState: "source_repository_mismatch",
        reason: "The registered source repository no longer matches its durable identity.",
      };
    }
    let metadata: { readonly present: boolean; readonly locked: boolean };
    try {
      metadata = await worktreeMetadata(canonicalSource, expectedPath);
    } catch {
      return {
        state: "wrong_repository",
        gitMetadataPresent: false,
        markerValid: false,
        gitMetadataState: "source_git_metadata_unavailable",
        reason: "The registered source repository Git metadata is unavailable.",
      };
    }
    const branchPresent = await localBranchExists(canonicalSource, input.branchName);
    if (!(await exists(expectedPath))) {
      const claimPresent = input.ownershipClaimPath
        ? await exists(input.ownershipClaimPath)
        : false;
      const claim =
        claimPresent && input.ownershipClaimPath
          ? await readMarker(input.ownershipClaimPath)
          : undefined;
      const claimValid =
        !metadata.present &&
        !branchPresent &&
        claim?.digest === input.ownershipMarkerDigest &&
        markerMatchesInspection(claim.marker, input);
      if (claimPresent && !claimValid && !metadata.present && !branchPresent) {
        return {
          state: "ownership_mismatch",
          gitMetadataPresent: false,
          markerValid: false,
          gitMetadataState: "allocation_claim_mismatch",
          reason: "The pre-allocation ownership claim does not match durable workspace state.",
        };
      }
      return {
        state: "missing",
        gitMetadataPresent: metadata.present,
        markerValid: false,
        ...(claimValid ? { claimValid: true } : {}),
        locked: metadata.locked,
        gitMetadataState: claimValid
          ? "ownership_claim_without_side_effect"
          : metadata.present
            ? "registered_path_missing"
            : branchPresent
              ? "branch_without_worktree"
              : "absent",
        reason: branchPresent
          ? "The factory branch exists without its owned worktree."
          : "The factory worktree path is missing.",
      };
    }
    const pathStat = await NodeFSP.lstat(expectedPath);
    if (!pathStat.isDirectory() || pathStat.isSymbolicLink()) {
      return {
        state: "path_collision",
        gitMetadataPresent: metadata.present,
        markerValid: false,
        gitMetadataState: "path_not_real_directory",
        reason: "The workspace path is not a real directory.",
      };
    }
    let canonicalPath: string;
    let commonDirectory: string;
    let head: string;
    let branch: string | undefined;
    let dirty: boolean;
    let markerPath: string;
    try {
      canonicalPath = await NodeFSP.realpath(expectedPath);
      commonDirectory = await canonicalGitPath(
        canonicalPath,
        (await runGit(["-C", canonicalPath, "rev-parse", "--git-common-dir"])).stdout.trim(),
      );
      head = (await runGit(["-C", canonicalPath, "rev-parse", "--verify", "HEAD"])).stdout
        .trim()
        .toLowerCase();
      branch = await currentBranch(canonicalPath);
      await assertSafeRepositoryConfig(canonicalPath);
      dirty =
        (await runGit(["-C", canonicalPath, "status", "--porcelain=v1", "--untracked-files=all"]))
          .stdout.length > 0;
      const gitDirectory = await canonicalGitPath(
        canonicalPath,
        (await runGit(["-C", canonicalPath, "rev-parse", "--git-dir"])).stdout.trim(),
      );
      markerPath = NodePath.join(gitDirectory, MARKER_FILE_NAME);
    } catch (cause) {
      if (cause instanceof WorkspaceManagerError && cause.code === "repository_unsafe_config") {
        throw cause;
      }
      return {
        state: "path_collision",
        canonicalPath: expectedPath,
        gitMetadataPresent: metadata.present,
        markerValid: false,
        gitMetadataState: "not_git_worktree",
        reason: "The workspace path is not the expected Git worktree.",
      };
    }
    if (commonDirectory !== input.gitCommonDirectory) {
      return {
        state: "wrong_repository",
        canonicalPath,
        gitMetadataPresent: metadata.present,
        markerValid: false,
        ownershipMarkerPath: markerPath,
        observedHead: head,
        ...(branch ? { observedBranch: branch } : {}),
        dirty,
        locked: metadata.locked,
        gitMetadataState: "wrong_common_directory",
      };
    }
    const recordedMarkerMatches =
      input.ownershipMarkerPath === undefined ||
      NodePath.resolve(input.ownershipMarkerPath) === NodePath.resolve(markerPath);
    const markerPresent = await exists(markerPath);
    const recordedMarker = recordedMarkerMatches ? await readMarker(markerPath) : undefined;
    const markerValid =
      recordedMarker !== undefined &&
      recordedMarker.digest === input.ownershipMarkerDigest &&
      markerMatchesInspection(recordedMarker.marker, input);
    if (!markerValid) {
      const claim = input.ownershipClaimPath
        ? await readMarker(input.ownershipClaimPath)
        : undefined;
      const claimValid =
        !markerPresent &&
        claim?.digest === input.ownershipMarkerDigest &&
        markerMatchesInspection(claim.marker, input);
      if (
        claimValid &&
        metadata.present &&
        branch === input.branchName &&
        head === input.resolvedBaseCommit
      ) {
        return {
          state: "allocation_incomplete",
          canonicalPath,
          gitMetadataPresent: true,
          markerValid: false,
          claimValid: true,
          ownershipMarkerPath: markerPath,
          observedHead: head,
          observedBranch: branch,
          dirty,
          locked: metadata.locked,
          gitMetadataState: "ownership_claim_pending_marker",
          reason: "Git worktree exists with a matching pre-allocation ownership claim.",
        };
      }
      return {
        state: "ownership_mismatch",
        canonicalPath,
        gitMetadataPresent: metadata.present,
        markerValid: false,
        ...(claimValid ? { claimValid: true } : {}),
        ownershipMarkerPath: markerPath,
        observedHead: head,
        ...(branch ? { observedBranch: branch } : {}),
        dirty,
        locked: metadata.locked,
        gitMetadataState: "marker_mismatch",
      };
    }
    if (!branch) {
      return {
        state: "detached_head",
        canonicalPath,
        gitMetadataPresent: metadata.present,
        markerValid,
        ownershipMarkerPath: markerPath,
        observedHead: head,
        dirty,
        locked: metadata.locked,
        gitMetadataState: "detached_head",
      };
    }
    if (branch !== input.branchName) {
      return {
        state: "wrong_branch",
        canonicalPath,
        gitMetadataPresent: metadata.present,
        markerValid,
        ownershipMarkerPath: markerPath,
        observedHead: head,
        observedBranch: branch,
        dirty,
        locked: metadata.locked,
        gitMetadataState: "wrong_branch",
      };
    }
    if (!metadata.present) {
      return {
        state: "ownership_mismatch",
        canonicalPath,
        gitMetadataPresent: false,
        markerValid,
        ownershipMarkerPath: markerPath,
        observedHead: head,
        observedBranch: branch,
        dirty,
        locked: metadata.locked,
        gitMetadataState: "metadata_missing",
        reason: "Git no longer registers the durable workspace path.",
      };
    }
    return {
      state: "matching",
      canonicalPath,
      gitMetadataPresent: true,
      markerValid,
      ownershipMarkerPath: markerPath,
      observedHead: head,
      observedBranch: branch,
      dirty,
      locked: metadata.locked,
      gitMetadataState: "registered",
    };
  }

  async discardAllocationClaim(input: InspectWorkspaceInput): Promise<void> {
    if (!input.ownershipClaimPath) {
      throw new WorkspaceManagerError(
        "ownership_mismatch",
        "Workspace allocation has no durable ownership claim path.",
      );
    }
    const inspection = await this.inspect(input);
    if (
      inspection.state !== "missing" ||
      inspection.claimValid !== true ||
      inspection.gitMetadataPresent ||
      inspection.gitMetadataState !== "ownership_claim_without_side_effect"
    ) {
      throw new WorkspaceManagerError(
        "ownership_ambiguous",
        "Workspace allocation claim cannot be discarded after a possible Git side effect.",
      );
    }
    const claim = await readMarker(input.ownershipClaimPath);
    if (
      claim?.digest !== input.ownershipMarkerDigest ||
      !markerMatchesInspection(claim.marker, input)
    ) {
      throw new WorkspaceManagerError(
        "ownership_mismatch",
        "Workspace allocation claim changed before it could be discarded.",
      );
    }
    const stat = await NodeFSP.lstat(input.ownershipClaimPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new WorkspaceManagerError(
        "ownership_mismatch",
        "Workspace allocation claim is not a regular factory-owned file.",
      );
    }
    await NodeFSP.unlink(input.ownershipClaimPath);
  }

  retain(input: InspectWorkspaceInput): Promise<WorkspaceInspection> {
    return this.inspect(input);
  }

  async remove(input: InspectWorkspaceInput): Promise<WorkspaceRemovalResult> {
    const inspection = await this.inspect(input);
    if (inspection.state === "missing" && !inspection.gitMetadataPresent) {
      return { removed: true, branchRetained: true, reason: "already_removed" };
    }
    if (inspection.state !== "matching" || !inspection.markerValid) {
      return { removed: false, branchRetained: true, reason: "ownership_mismatch" };
    }
    if (inspection.locked) return { removed: false, branchRetained: true, reason: "locked" };
    if (inspection.dirty) return { removed: false, branchRetained: true, reason: "modified" };
    await runGit([
      "-C",
      input.canonicalSourceRepositoryPath,
      "worktree",
      "remove",
      input.canonicalWorktreePath,
    ]);
    const after = await worktreeMetadata(
      input.canonicalSourceRepositoryPath,
      input.canonicalWorktreePath,
    );
    if ((await exists(input.canonicalWorktreePath)) || after.present) {
      throw new WorkspaceManagerError(
        "ownership_ambiguous",
        "Git reported cleanup success but workspace evidence remains.",
      );
    }
    if (!(await exists(input.canonicalSourceRepositoryPath))) {
      throw new WorkspaceManagerError(
        "ownership_ambiguous",
        "Primary checkout disappeared during cleanup.",
      );
    }
    return { removed: true, branchRetained: true };
  }
}
