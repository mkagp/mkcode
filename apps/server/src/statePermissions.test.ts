import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "./config.ts";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateFile,
} from "./statePermissions.ts";

const permissionBits = (mode: number) => mode & 0o777;

describe("server state permissions", () => {
  it.effect("creates server-owned state directories with mode 0700", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-state-permissions-" });
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);

      yield* ServerConfig.ensureServerDirectories(paths);

      const directories = new Set([
        paths.stateDir,
        paths.logsDir,
        paths.providerLogsDir,
        paths.terminalLogsDir,
        paths.attachmentsDir,
        paths.worktreesDir,
        paths.secretsDir,
        paths.providerStatusCacheDir,
        path.dirname(paths.keybindingsConfigPath),
        path.dirname(paths.settingsPath),
        path.dirname(paths.projectRegistrationsPath),
        path.dirname(paths.anonymousIdPath),
        path.dirname(paths.serverRuntimeStatePath),
      ]);
      for (const directory of directories) {
        assert.equal(permissionBits((yield* fs.stat(directory)).mode), PRIVATE_DIRECTORY_MODE);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("corrects an existing overly broad server-owned directory to mode 0700", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-state-permissions-" });
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(paths.stateDir, { recursive: true, mode: 0o777 });
      yield* fs.chmod(paths.stateDir, 0o777);

      yield* ServerConfig.ensureServerDirectories(paths);

      assert.equal(permissionBits((yield* fs.stat(paths.stateDir)).mode), PRIVATE_DIRECTORY_MODE);
      assert.equal(path.dirname(paths.projectRegistrationsPath), paths.stateDir);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("corrects an existing overly broad regular file to mode 0600", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-state-file-mode-" });
      const filePath = path.join(root, "project-registrations.json");
      yield* fs.writeFileString(filePath, "{}", { mode: 0o666 });
      yield* fs.chmod(filePath, 0o666);

      yield* ensurePrivateFile(filePath);

      assert.equal(permissionBits((yield* fs.stat(filePath)).mode), PRIVATE_FILE_MODE);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps an existing restrictive regular file at mode 0600", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-state-file-mode-" });
      const filePath = path.join(root, "project-registrations.json");
      yield* fs.writeFileString(filePath, "{}", { mode: PRIVATE_FILE_MODE });
      yield* fs.chmod(filePath, PRIVATE_FILE_MODE);

      yield* ensurePrivateFile(filePath);

      assert.equal(permissionBits((yield* fs.stat(filePath)).mode), PRIVATE_FILE_MODE);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a symlink without changing its target permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-state-symlink-" });
      const targetPath = path.join(root, "target.json");
      const linkPath = path.join(root, "project-registrations.json");
      yield* fs.writeFileString(targetPath, "{}", { mode: 0o644 });
      yield* fs.chmod(targetPath, 0o644);
      yield* fs.symlink(targetPath, linkPath);

      const error = yield* Effect.flip(ensurePrivateFile(linkPath));

      assert.instanceOf(error, PlatformError.PlatformError);
      assert.equal(permissionBits((yield* fs.stat(targetPath)).mode), 0o644);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
