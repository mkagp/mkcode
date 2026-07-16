import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import { PRIVATE_FILE_MODE } from "./statePermissions.ts";

const permissionBits = (mode: number) => mode & 0o777;

describe("atomic state writes", () => {
  it.effect("uses mode 0600 for the temporary file and final replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-atomic-write-" });
      const filePath = path.join(root, "project-registrations.json");
      const temporaryModes: Array<number> = [];
      const observingFileSystem = {
        ...fs,
        rename: (oldPath, newPath) =>
          Effect.gen(function* () {
            temporaryModes.push(permissionBits((yield* fs.stat(oldPath)).mode));
            yield* fs.rename(oldPath, newPath);
          }),
      } satisfies FileSystem.FileSystem;

      yield* writeFileStringAtomically({
        filePath,
        contents: "first\n",
        mode: PRIVATE_FILE_MODE,
      }).pipe(Effect.provideService(FileSystem.FileSystem, observingFileSystem));

      assert.deepEqual(temporaryModes, [PRIVATE_FILE_MODE]);
      assert.equal(permissionBits((yield* fs.stat(filePath)).mode), PRIVATE_FILE_MODE);
      assert.equal(yield* fs.readFileString(filePath), "first\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("corrects an overly broad destination and preserves atomic replacement behavior", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-atomic-replace-" });
      const filePath = path.join(root, "project-registrations.json");
      yield* fs.writeFileString(filePath, "old\n", { mode: 0o666 });
      yield* fs.chmod(filePath, 0o666);

      yield* writeFileStringAtomically({
        filePath,
        contents: "new\n",
        mode: PRIVATE_FILE_MODE,
      });

      assert.equal(yield* fs.readFileString(filePath), "new\n");
      assert.equal(permissionBits((yield* fs.stat(filePath)).mode), PRIVATE_FILE_MODE);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces a symlink without changing the target permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-atomic-symlink-" });
      const targetPath = path.join(root, "target.json");
      const filePath = path.join(root, "project-registrations.json");
      yield* fs.writeFileString(targetPath, "target\n", { mode: 0o644 });
      yield* fs.chmod(targetPath, 0o644);
      yield* fs.symlink(targetPath, filePath);

      yield* writeFileStringAtomically({
        filePath,
        contents: "replacement\n",
        mode: PRIVATE_FILE_MODE,
      });

      assert.equal(yield* fs.readFileString(targetPath), "target\n");
      assert.equal(permissionBits((yield* fs.stat(targetPath)).mode), 0o644);
      assert.equal(yield* fs.readFileString(filePath), "replacement\n");
      assert.equal(permissionBits((yield* fs.stat(filePath)).mode), PRIVATE_FILE_MODE);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
