// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const nodeErrorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
    ? cause.code
    : undefined;

const platformError = (method: string, path: string, cause: unknown) => {
  const code = nodeErrorCode(cause);
  if (code === "ELOOP" || code === "ENOTDIR") {
    return PlatformError.badArgument({
      module: "FileSystem",
      method,
      description: `Server-owned state path '${path}' must not contain a symbolic link or non-directory ancestor.`,
      cause,
    });
  }
  return PlatformError.systemError({
    _tag:
      code === "ENOENT"
        ? "NotFound"
        : code === "EACCES" || code === "EPERM"
          ? "PermissionDenied"
          : "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    cause,
  });
};

interface EnsurePathModeInput {
  readonly path: string;
  readonly expectedType: "Directory" | "File";
  readonly mode: number;
  readonly allowMissing: boolean;
  readonly createDirectory: boolean;
}

const openScoped = (openPath: string, flags: number, reportedPath: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => NodeFSP.open(openPath, flags),
      catch: (cause) => platformError("open", reportedPath, cause),
    }),
    (handle) => Effect.promise(() => handle.close()).pipe(Effect.ignore),
  );

const openLinuxPathWithoutSymlinks = Effect.fn("StatePermissions.openLinuxPathWithoutSymlinks")(
  function* (input: EnsurePathModeInput) {
    if (!NodePath.isAbsolute(input.path)) {
      return yield* PlatformError.badArgument({
        module: "FileSystem",
        method: "open",
        description: "Server-owned state paths must be absolute.",
      });
    }

    const normalizedPath = NodePath.normalize(input.path);
    const parsedPath = NodePath.parse(normalizedPath);
    const components = normalizedPath
      .slice(parsedPath.root.length)
      .split(NodePath.sep)
      .filter((component) => component.length > 0);
    let currentHandle = yield* openScoped(
      parsedPath.root,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_DIRECTORY,
      input.path,
    );

    for (const [index, component] of components.entries()) {
      const isFinalComponent = index === components.length - 1;
      const flags =
        NodeFS.constants.O_RDONLY |
        NodeFS.constants.O_NOFOLLOW |
        (isFinalComponent && input.expectedType === "File" ? NodeFS.constants.O_NONBLOCK : 0) |
        (!isFinalComponent || input.expectedType === "Directory"
          ? NodeFS.constants.O_DIRECTORY
          : 0);
      let result = yield* Effect.result(
        openScoped(`/proc/self/fd/${currentHandle.fd}/${component}`, flags, input.path),
      );
      if (
        result._tag === "Failure" &&
        input.createDirectory &&
        result.failure.reason._tag === "NotFound"
      ) {
        const createResult = yield* Effect.result(
          Effect.tryPromise({
            try: () =>
              NodeFSP.mkdir(`/proc/self/fd/${currentHandle.fd}/${component}`, {
                mode: input.mode,
              }),
            catch: (cause) => platformError("mkdir", input.path, cause),
          }),
        );
        if (createResult._tag === "Failure") return yield* createResult.failure;
        result = yield* Effect.result(
          openScoped(`/proc/self/fd/${currentHandle.fd}/${component}`, flags, input.path),
        );
      }
      if (result._tag === "Failure") {
        if (input.allowMissing && isFinalComponent && result.failure.reason._tag === "NotFound") {
          return undefined;
        }
        return yield* result.failure;
      }
      currentHandle = result.success;
    }

    return currentHandle;
  },
);

const openPortablePath = Effect.fn("StatePermissions.openPortablePath")(function* (
  input: EnsurePathModeInput,
) {
  const flags =
    NodeFS.constants.O_RDONLY |
    NodeFS.constants.O_NOFOLLOW |
    (input.expectedType === "Directory" ? NodeFS.constants.O_DIRECTORY : 0);
  const result = yield* Effect.result(openScoped(input.path, flags, input.path));
  if (result._tag === "Failure") {
    if (input.allowMissing && result.failure.reason._tag === "NotFound") return undefined;
    return yield* result.failure;
  }
  return result.success;
});

const ensurePathModeLive = Effect.fn("StatePermissions.ensurePathModeLive")(function* (
  input: EnsurePathModeInput,
) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* NodeProcess.platform === "linux"
        ? openLinuxPathWithoutSymlinks(input)
        : openPortablePath(input);
      if (handle === undefined) return;

      const info = yield* Effect.tryPromise({
        try: () => handle.stat(),
        catch: (cause) => platformError("fstat", input.path, cause),
      });
      const matchesExpectedType =
        input.expectedType === "Directory" ? info.isDirectory() : info.isFile();
      if (!matchesExpectedType) {
        return yield* PlatformError.badArgument({
          module: "FileSystem",
          method: "fchmod",
          description: `Server-owned state path '${input.path}' must be a real ${input.expectedType.toLowerCase()}.`,
        });
      }
      yield* Effect.tryPromise({
        try: () => handle.chmod(input.mode),
        catch: (cause) => platformError("fchmod", input.path, cause),
      });
    }),
  );
});

export const StatePermissionEnforcer = Context.Reference<{
  readonly ensurePathMode: (
    input: EnsurePathModeInput,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>;
}>("t3/statePermissions/StatePermissionEnforcer", {
  defaultValue: () => ({ ensurePathMode: ensurePathModeLive }),
});

export const ensurePrivateDirectory = Effect.fn("StatePermissions.ensurePrivateDirectory")(
  function* (directoryPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const enforcer = yield* StatePermissionEnforcer;
    if (NodeProcess.platform !== "linux") {
      yield* fs.makeDirectory(directoryPath, {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      });
    }
    yield* enforcer.ensurePathMode({
      path: directoryPath,
      expectedType: "Directory",
      mode: PRIVATE_DIRECTORY_MODE,
      allowMissing: false,
      createDirectory: true,
    });
  },
);

export const ensurePrivateFile = Effect.fn("StatePermissions.ensurePrivateFile")(function* (
  filePath: string,
  mode = PRIVATE_FILE_MODE,
) {
  const enforcer = yield* StatePermissionEnforcer;
  yield* enforcer.ensurePathMode({
    path: filePath,
    expectedType: "File",
    mode,
    allowMissing: true,
    createDirectory: false,
  });
});
