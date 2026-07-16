// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { WorkflowEngineError } from "./errors.ts";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
// Linux defines O_PATH as 010000000, but Node does not currently expose it.
const LINUX_O_PATH = 0o10_000_000;

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

const closePreservingCause = async (handle: NodeFSP.FileHandle, cause: unknown) => {
  await handle.close().catch(() => undefined);
  throw cause;
};

const nodeErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const openLinuxDirectory = async (path: string, create: boolean): Promise<NodeFSP.FileHandle> => {
  const normalized = NodePath.normalize(path);
  const parsed = NodePath.parse(normalized);
  const components = normalized.slice(parsed.root.length).split(NodePath.sep).filter(Boolean);
  let current = await NodeFSP.open(
    parsed.root,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY,
  );
  try {
    for (const [index, component] of components.entries()) {
      const isFinal = index === components.length - 1;
      const scopedPath = `/proc/self/fd/${current.fd}/${component}`;
      const flags =
        (isFinal ? NodeFS.constants.O_RDONLY : LINUX_O_PATH) |
        NodeFS.constants.O_NOFOLLOW |
        NodeFS.constants.O_DIRECTORY;
      let next: NodeFSP.FileHandle;
      try {
        next = await NodeFSP.open(scopedPath, flags);
      } catch (cause) {
        if (!create || nodeErrorCode(cause) !== "ENOENT") throw cause;
        try {
          await NodeFSP.mkdir(scopedPath, { mode: PRIVATE_DIRECTORY_MODE });
        } catch (mkdirCause) {
          if (nodeErrorCode(mkdirCause) !== "EEXIST") throw mkdirCause;
        }
        next = await NodeFSP.open(scopedPath, flags);
      }
      try {
        await current.close();
      } catch (cause) {
        await next.close().catch(() => undefined);
        return closePreservingCause(current, cause);
      }
      current = next;
    }
    return current;
  } catch (cause) {
    return closePreservingCause(current, cause);
  }
};

export async function ensurePrivateDirectory(path: string): Promise<void> {
  assertAbsoluteManagedPath(path);
  let handle: NodeFSP.FileHandle;
  if (NodeProcess.platform === "linux") {
    handle = await openLinuxDirectory(path, true);
  } else {
    await assertNoSymlinkComponents(path);
    await NodeFSP.mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await assertNoSymlinkComponents(path);
    handle = await openWithoutFollowing(path, true);
  }
  try {
    const info = await handle.stat();
    if (!info.isDirectory()) {
      throw new WorkflowEngineError("invalid_request", "Factory state path is not a directory.");
    }
    await handle.chmod(PRIVATE_DIRECTORY_MODE);
  } catch (cause) {
    return closePreservingCause(handle, cause);
  }
  await handle.close();
}

export async function ensurePrivateFile(path: string, create: boolean): Promise<void> {
  const handle = await openPrivateFile(path, create);
  await handle?.close();
}

export async function openPrivateFile(
  path: string,
  create: boolean,
): Promise<NodeFSP.FileHandle | undefined> {
  assertAbsoluteManagedPath(path);
  const parentPath = NodePath.dirname(path);
  let parentHandle: NodeFSP.FileHandle | undefined;
  let openPath = path;
  if (NodeProcess.platform === "linux") {
    parentHandle = await openLinuxDirectory(parentPath, false);
    openPath = `/proc/self/fd/${parentHandle.fd}/${NodePath.basename(path)}`;
  } else {
    await assertNoSymlinkComponents(parentPath);
  }
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(
      openPath,
      NodeFS.constants.O_RDWR |
        NodeFS.constants.O_NOFOLLOW |
        (create ? NodeFS.constants.O_CREAT : 0),
      PRIVATE_FILE_MODE,
    );
  } catch (cause) {
    await parentHandle?.close().catch(() => undefined);
    if (!create && nodeErrorCode(cause) === "ENOENT") {
      return;
    }
    throw cause;
  }
  if (parentHandle) {
    try {
      await parentHandle.close();
    } catch (cause) {
      return closePreservingCause(handle, cause);
    }
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new WorkflowEngineError("invalid_request", "Factory state file is not a regular file.");
    }
    await handle.chmod(PRIVATE_FILE_MODE);
    return handle;
  } catch (cause) {
    return closePreservingCause(handle, cause);
  }
}
