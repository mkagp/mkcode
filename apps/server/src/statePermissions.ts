// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

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
  if (code === "ELOOP") {
    return PlatformError.badArgument({
      module: "FileSystem",
      method,
      description: `Server-owned state path '${path}' must not be a symbolic link.`,
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
}

const ensurePathModeLive = Effect.fn("StatePermissions.ensurePathModeLive")(function* (
  input: EnsurePathModeInput,
) {
  const flags =
    NodeFS.constants.O_RDONLY |
    NodeFS.constants.O_NOFOLLOW |
    (input.expectedType === "Directory" ? NodeFS.constants.O_DIRECTORY : 0);
  const openResult = yield* Effect.result(
    Effect.tryPromise({
      try: () => NodeFSP.open(input.path, flags),
      catch: (cause) => platformError("open", input.path, cause),
    }),
  );
  if (openResult._tag === "Failure") {
    if (input.allowMissing && openResult.failure.reason._tag === "NotFound") return;
    return yield* openResult.failure;
  }
  const handle = openResult.success;
  yield* Effect.acquireUseRelease(
    Effect.succeed(handle),
    (opened) =>
      Effect.gen(function* () {
        const info = yield* Effect.tryPromise({
          try: () => opened.stat(),
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
          try: () => opened.chmod(input.mode),
          catch: (cause) => platformError("fchmod", input.path, cause),
        });
      }),
    (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore),
  );
});

export const StatePermissionEnforcer = Context.Reference<{
  readonly ensurePathMode: (
    input: EnsurePathModeInput,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
}>("t3/statePermissions/StatePermissionEnforcer", {
  defaultValue: () => ({ ensurePathMode: ensurePathModeLive }),
});

export const ensurePrivateDirectory = Effect.fn("StatePermissions.ensurePrivateDirectory")(
  function* (directoryPath: string) {
    const fs = yield* FileSystem.FileSystem;
    const enforcer = yield* StatePermissionEnforcer;
    yield* fs.makeDirectory(directoryPath, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    });
    yield* enforcer.ensurePathMode({
      path: directoryPath,
      expectedType: "Directory",
      mode: PRIVATE_DIRECTORY_MODE,
      allowMissing: false,
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
  });
});
