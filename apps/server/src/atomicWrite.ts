import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensurePrivateDirectory, ensurePrivateFile } from "./statePermissions.ts";

export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
  readonly mode?: number;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const targetDirectory = path.dirname(input.filePath);

      if (input.mode === undefined) {
        yield* fs.makeDirectory(targetDirectory, { recursive: true });
      } else {
        yield* ensurePrivateDirectory(targetDirectory);
      }
      const tempDirectory = yield* fs.makeTempDirectoryScoped({
        directory: targetDirectory,
        prefix: `${path.basename(input.filePath)}.`,
      });
      const tempPath = path.join(tempDirectory, "contents.tmp");

      if (input.mode === undefined) {
        yield* fs.writeFileString(tempPath, input.contents);
      } else {
        yield* ensurePrivateDirectory(tempDirectory);
        yield* fs.writeFileString(tempPath, input.contents, { mode: input.mode });
        yield* ensurePrivateFile(tempPath, input.mode);
      }
      yield* fs.rename(tempPath, input.filePath);
      if (input.mode !== undefined) yield* ensurePrivateFile(input.filePath, input.mode);
    }),
  );
