// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { WorkflowEngineError } from "./errors.ts";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const assertAbsoluteManagedPath = (path: string) => {
  if (!NodePath.isAbsolute(path) || NodePath.parse(path).root === NodePath.normalize(path)) {
    throw new WorkflowEngineError(
      "invalid_request",
      "Factory state paths must be absolute and must not be the filesystem root.",
    );
  }
};

const assertNoSymlinkComponents = async (path: string) => {
  const normalized = NodePath.normalize(path);
  const parsed = NodePath.parse(normalized);
  const components = normalized.slice(parsed.root.length).split(NodePath.sep).filter(Boolean);
  let current = parsed.root;

  for (const component of components) {
    current = NodePath.join(current, component);
    try {
      const info = await NodeFSP.lstat(current);
      if (info.isSymbolicLink()) {
        throw new WorkflowEngineError(
          "invalid_request",
          "Factory state paths must not contain symbolic links.",
        );
      }
    } catch (cause) {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      ) {
        return;
      }
      throw cause;
    }
  }
};

const openWithoutFollowing = async (path: string, directory: boolean) =>
  NodeFSP.open(
    path,
    NodeFS.constants.O_RDONLY |
      NodeFS.constants.O_NOFOLLOW |
      (directory ? NodeFS.constants.O_DIRECTORY : 0),
  );

export async function ensurePrivateDirectory(path: string): Promise<void> {
  assertAbsoluteManagedPath(path);
  await assertNoSymlinkComponents(path);
  await NodeFSP.mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertNoSymlinkComponents(path);
  const handle = await openWithoutFollowing(path, true);
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new WorkflowEngineError("invalid_request", "Factory state path is not a directory.");
    }
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
  } finally {
    await handle.close();
  }
}

export async function ensurePrivateFile(path: string, create: boolean): Promise<void> {
  assertAbsoluteManagedPath(path);
  await assertNoSymlinkComponents(NodePath.dirname(path));
  let handle;
  try {
    handle = await NodeFSP.open(
      path,
      NodeFS.constants.O_RDWR |
        NodeFS.constants.O_NOFOLLOW |
        (create ? NodeFS.constants.O_CREAT : 0),
      PRIVATE_FILE_MODE,
    );
  } catch (cause) {
    if (
      !create &&
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return;
    }
    throw cause;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new WorkflowEngineError("invalid_request", "Factory state file is not a regular file.");
    }
    await handle.chmod(PRIVATE_FILE_MODE);
  } finally {
    await handle.close();
  }
}
