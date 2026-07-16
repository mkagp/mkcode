import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  loadProjectConfiguration,
  parseProjectConfiguration,
  PROJECT_CONFIG_RELATIVE_PATH,
  resolveProjectConfiguration,
} from "./projectConfig.ts";
import { ProjectConfigurationFile } from "./schema.ts";

const decodeProjectConfigurationFile = Schema.decodeUnknownEffect(ProjectConfigurationFile);

const validConfiguration = `version: 1
project:
  id: example-typescript-project
  name: Example TypeScript Project
repository:
  baseBranch: main
setup:
  - id: install
    executable: pnpm
    args: [install, --frozen-lockfile]
    workingDirectory: .
    timeoutSeconds: 900
checks:
  - id: lint
    executable: pnpm
    args: [exec, biome, check, .]
    workingDirectory: .
    timeoutSeconds: 300
  - id: typecheck
    executable: pnpm
    args: [exec, tsc, --noEmit]
    workingDirectory: .
    timeoutSeconds: 300
  - id: test
    executable: pnpm
    args: [exec, vitest, run]
    workingDirectory: .
    timeoutSeconds: 900
workflows:
  allowed: [feature, bug, chore]
execution:
  defaultProfile: coding-workhorse
`;

const withNode = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const makeRepository = (contents = validConfiguration) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-project-config-test-" });
    yield* fs.makeDirectory(path.join(root, ".git"), { recursive: true });
    yield* fs.makeDirectory(path.join(root, ".mkcode"), { recursive: true });
    const sourcePath = path.join(root, PROJECT_CONFIG_RELATIVE_PATH);
    yield* fs.writeFileString(sourcePath, contents);
    return { root, sourcePath };
  });

const resolveFixture = (contents = validConfiguration) =>
  Effect.gen(function* () {
    const repository = yield* makeRepository(contents);
    return yield* resolveProjectConfiguration({
      ...repository,
      repositoryRoot: repository.root,
      contents,
    });
  });

const expectIssue = (contents: string, code: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveFixture(contents).pipe(
        Effect.catchTags({ PlatformError: (cause) => Effect.die(cause) }),
      ),
    );
    assert.isTrue(error.issues.some((issue) => issue.code === code));
  });

const expectIssueAt = (contents: string, code: string, path: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveFixture(contents).pipe(
        Effect.catchTags({ PlatformError: (cause) => Effect.die(cause) }),
      ),
    );
    assert.isTrue(error.issues.some((issue) => issue.code === code && issue.path === path));
  });

describe("project configuration", () => {
  it.effect("parses and resolves the documented version 1 example", () =>
    withNode(
      Effect.gen(function* () {
        const resolved = yield* resolveFixture();
        assert.equal(resolved.project.id, "example-typescript-project");
        assert.equal(resolved.setup.length, 1);
        assert.equal(resolved.checks.length, 3);
        assert.deepEqual(resolved.workflows.allowed, ["feature", "bug", "chore"]);
        assert.equal(resolved.execution.defaultProfile, "coding-workhorse");
      }),
    ),
  );

  it.effect("reports a missing configuration file", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "mkcode-project-config-missing-",
        });
        const error = yield* Effect.flip(loadProjectConfiguration(root));
        assert.equal(error.issues[0]?.code, "file_missing");
      }),
    ),
  );

  it.effect("reports malformed YAML without returning source values", () =>
    withNode(
      Effect.gen(function* () {
        const secret = "credential=do-not-log";
        const error = yield* Effect.flip(
          parseProjectConfiguration({
            sourcePath: "/repo/.mkcode/project.yaml",
            contents: `version: 1\nproject: ${secret}\n  broken: true\n`,
          }),
        );
        assert.equal(error.issues[0]?.code, "yaml_malformed");
        assert.notInclude(error.message, secret);
        assert.notInclude(error.issues[0]?.message ?? "", secret);
      }),
    ),
  );

  it.effect("rejects unsupported versions before schema decoding", () =>
    withNode(
      expectIssue(validConfiguration.replace("version: 1", "version: 2"), "unsupported_version"),
    ),
  );

  it.effect("rejects an invalid stable project id", () =>
    withNode(
      expectIssue(
        validConfiguration.replace("id: example-typescript-project", "id: Example Project"),
        "invalid_project_id",
      ),
    ),
  );

  it.effect("requires a base branch", () =>
    withNode(
      expectIssueAt(
        validConfiguration.replace("  baseBranch: main", "  contextFiles: []"),
        "schema_invalid",
        "repository.baseBranch",
      ),
    ),
  );

  it.effect("rejects Git-invalid base branch references", () =>
    withNode(
      Effect.gen(function* () {
        for (const baseBranch of ["foo..bar", "foo/", "foo//bar"]) {
          yield* expectIssueAt(
            validConfiguration.replace("baseBranch: main", `baseBranch: ${baseBranch}`),
            "invalid_reference",
            "repository.baseBranch",
          );
        }
      }),
    ),
  );

  it.effect("exports a version 1-only project configuration schema", () =>
    withNode(
      Effect.gen(function* () {
        const valid = yield* decodeProjectConfigurationFile({
          version: 1,
          project: { id: "schema-version", name: "Schema Version" },
          repository: { baseBranch: "main" },
          execution: { defaultProfile: "coding-workhorse" },
        });
        assert.equal(valid.version, 1);

        const decoded = yield* Effect.flip(
          decodeProjectConfigurationFile({
            version: 999,
            project: { id: "schema-version", name: "Schema Version" },
            repository: { baseBranch: "main" },
            execution: { defaultProfile: "coding-workhorse" },
          }),
        );
        assert.isDefined(decoded);
      }),
    ),
  );

  it.effect("requires a default execution-profile reference", () =>
    withNode(
      expectIssueAt(
        validConfiguration.replace("execution:\n  defaultProfile: coding-workhorse\n", ""),
        "schema_invalid",
        "execution",
      ),
    ),
  );

  it.effect("rejects unknown keys", () =>
    withNode(
      expectIssue(
        validConfiguration.replace(
          "  name: Example TypeScript Project",
          "  name: Example TypeScript Project\n  modle: typo",
        ),
        "unknown_key",
      ),
    ),
  );

  it.effect("rejects duplicate command and check identifiers", () =>
    withNode(
      expectIssue(validConfiguration.replace("  - id: lint", "  - id: install"), "duplicate_id"),
    ),
  );

  it.effect("rejects empty executables", () =>
    withNode(
      expectIssue(
        validConfiguration.replace("    executable: pnpm", "    executable: ' '"),
        "empty_executable",
      ),
    ),
  );

  it.effect("rejects non-array arguments", () =>
    withNode(
      expectIssueAt(
        validConfiguration.replace(
          "    args: [install, --frozen-lockfile]",
          "    args: pnpm install",
        ),
        "schema_invalid",
        "setup[0].args",
      ),
    ),
  );

  it.effect("rejects invalid timeouts", () =>
    withNode(
      expectIssue(
        validConfiguration.replace("    timeoutSeconds: 900", "    timeoutSeconds: 0"),
        "invalid_timeout",
      ),
    ),
  );

  it.effect("rejects working-directory traversal", () =>
    withNode(
      expectIssue(
        validConfiguration.replace("    workingDirectory: .", "    workingDirectory: ../outside"),
        "unsafe_path",
      ),
    ),
  );

  it.effect("rejects context paths that escape the repository", () =>
    withNode(
      expectIssue(
        validConfiguration.replace(
          "  baseBranch: main",
          "  baseBranch: main\n  contextFiles: [../secret.md]",
        ),
        "unsafe_path",
      ),
    ),
  );

  it.effect("normalizes the repository root and applies deterministic defaults", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repository = yield* makeRepository(
          validConfiguration.replace("    timeoutSeconds: 900\nchecks:", "checks:"),
        );
        const resolved = yield* resolveProjectConfiguration({
          repositoryRoot: path.join(repository.root, ".", "nested", ".."),
          sourcePath: repository.sourcePath,
          contents: validConfiguration.replace("    timeoutSeconds: 900\nchecks:", "checks:"),
        });
        assert.equal(resolved.repository.root, yield* fs.realPath(repository.root));
        assert.equal(resolved.setup[0]?.timeoutSeconds, 300);
        assert.equal(
          resolved.repository.worktreeRoot,
          path.join(resolved.repository.root, ".mkcode", "worktrees"),
        );
      }),
    ),
  );

  it.effect("produces a stable digest for identical content and registration inputs", () =>
    withNode(
      Effect.gen(function* () {
        const repository = yield* makeRepository();
        const first = yield* resolveProjectConfiguration({
          repositoryRoot: repository.root,
          sourcePath: repository.sourcePath,
          contents: validConfiguration,
        });
        const second = yield* resolveProjectConfiguration({
          repositoryRoot: repository.root,
          sourcePath: repository.sourcePath,
          contents: validConfiguration,
        });
        assert.equal(first.contentDigest, second.contentDigest);
        assert.deepEqual(first, second);
      }),
    ),
  );

  it.effect("rejects a context-file symlink that resolves outside the repository", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const contents = validConfiguration.replace(
          "  baseBranch: main",
          "  baseBranch: main\n  contextFiles: [linked-context.md]",
        );
        const repository = yield* makeRepository(contents);
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "mkcode-project-config-outside-file-",
        });
        const outsideFile = path.join(outside, "secret.md");
        yield* fs.writeFileString(outsideFile, "outside\n");
        yield* fs.symlink(outsideFile, path.join(repository.root, "linked-context.md"));
        const error = yield* Effect.flip(
          resolveProjectConfiguration({
            repositoryRoot: repository.root,
            sourcePath: repository.sourcePath,
            contents,
          }),
        );
        assert.isTrue(
          error.issues.some(
            (issue) =>
              issue.code === "path_symlink_escape" && issue.path === "repository.contextFiles[0]",
          ),
        );
      }),
    ),
  );

  it.effect("rejects a working-directory symlink that resolves outside the repository", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const contents = validConfiguration.replace(
          "    workingDirectory: .",
          "    workingDirectory: linked-outside",
        );
        const repository = yield* makeRepository(contents);
        const outside = yield* fs.makeTempDirectoryScoped({
          prefix: "mkcode-project-config-outside-",
        });
        yield* fs.symlink(outside, path.join(repository.root, "linked-outside"));
        const error = yield* Effect.flip(
          resolveProjectConfiguration({
            repositoryRoot: repository.root,
            sourcePath: repository.sourcePath,
            contents,
          }),
        );
        assert.isTrue(error.issues.some((issue) => issue.code === "path_symlink_escape"));
      }),
    ),
  );

  it.effect(
    "rejects an artifact path with an existing symlink ancestor outside the repository",
    () =>
      withNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const contents = validConfiguration.replace(
            "timeoutSeconds: 900",
            "timeoutSeconds: 900\n    artifacts:\n      - path: generated/report.json",
          );
          const repository = yield* makeRepository(contents);
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-artifact-outside-" });
          yield* fs.symlink(outside, path.join(repository.root, "generated"));

          const error = yield* Effect.flip(
            resolveProjectConfiguration({
              repositoryRoot: repository.root,
              sourcePath: repository.sourcePath,
              contents,
            }),
          );

          assert.isTrue(
            error.issues.some(
              (issue) => issue.code === "path_symlink_escape" && issue.path.includes("artifacts"),
            ),
          );
        }),
      ),
  );

  it.effect("rejects an artifact path with a dangling symlink ancestor", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const contents = validConfiguration.replace(
          "timeoutSeconds: 900",
          "timeoutSeconds: 900\n    artifacts:\n      - path: linked/report.json",
        );
        const repository = yield* makeRepository(contents);
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-artifact-dangling-" });
        yield* fs.symlink(path.join(outside, "not-created"), path.join(repository.root, "linked"));

        const error = yield* Effect.flip(
          resolveProjectConfiguration({
            repositoryRoot: repository.root,
            sourcePath: repository.sourcePath,
            contents,
          }),
        );

        assert.isTrue(
          error.issues.some(
            (issue) => issue.code === "path_symlink_escape" && issue.path.includes("artifacts"),
          ),
        );
      }),
    ),
  );

  it.effect(
    "rejects a worktree root with an existing symlink ancestor outside the repository",
    () =>
      withNode(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const contents = validConfiguration.replace(
            "baseBranch: main",
            "baseBranch: main\n  worktreeRoot: linked/worktrees",
          );
          const repository = yield* makeRepository(contents);
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-worktree-outside-" });
          yield* fs.symlink(outside, path.join(repository.root, "linked"));

          const error = yield* Effect.flip(
            resolveProjectConfiguration({
              repositoryRoot: repository.root,
              sourcePath: repository.sourcePath,
              contents,
            }),
          );

          assert.isTrue(
            error.issues.some(
              (issue) =>
                issue.code === "path_symlink_escape" && issue.path === "repository.worktreeRoot",
            ),
          );
        }),
      ),
  );

  it.effect("rejects an existing non-directory worktree root", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const contents = validConfiguration.replace(
          "baseBranch: main",
          "baseBranch: main\n  worktreeRoot: worktree-file",
        );
        const repository = yield* makeRepository(contents);
        yield* fs.writeFileString(path.join(repository.root, "worktree-file"), "not a directory");

        const error = yield* Effect.flip(
          resolveProjectConfiguration({
            repositoryRoot: repository.root,
            sourcePath: repository.sourcePath,
            contents,
          }),
        );

        assert.isTrue(
          error.issues.some(
            (issue) =>
              issue.code === "path_not_directory" && issue.path === "repository.worktreeRoot",
          ),
        );
      }),
    ),
  );

  it.effect("checks configuration containment before reading a symlink target", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const repository = yield* makeRepository();
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-config-outside-" });
        const outsideConfig = path.join(outside, "outside.yaml");
        yield* fs.writeFileString(outsideConfig, "version: [malformed\n");
        yield* fs.remove(repository.sourcePath);
        yield* fs.symlink(outsideConfig, repository.sourcePath);

        const error = yield* Effect.flip(loadProjectConfiguration(repository.root));

        assert.equal(error.issues[0]?.code, "path_symlink_escape");
        assert.isFalse(error.issues.some((issue) => issue.code === "yaml_malformed"));
      }),
    ),
  );

  it.effect("reports permission failures as read failures rather than missing paths", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const contents = validConfiguration.replace(
          "baseBranch: main",
          "baseBranch: main\n  contextFiles: [blocked/context.md]",
        );
        const repository = yield* makeRepository(contents);
        const blocked = path.join(repository.root, "blocked");
        const blockedContext = path.join(blocked, "context.md");
        yield* fs.makeDirectory(blocked);
        yield* fs.writeFileString(blockedContext, "context");
        const permissionDeniedFileSystem = {
          ...fs,
          realPath: (target) =>
            target === blockedContext
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                    description: "Test PermissionDenied realPath failure.",
                  }),
                )
              : fs.realPath(target),
        } satisfies FileSystem.FileSystem;

        const error = yield* Effect.flip(
          resolveProjectConfiguration({
            repositoryRoot: repository.root,
            sourcePath: repository.sourcePath,
            contents,
          }).pipe(Effect.provideService(FileSystem.FileSystem, permissionDeniedFileSystem)),
        );

        assert.isTrue(
          error.issues.some(
            (issue) => issue.code === "read_failed" && issue.path === "repository.contextFiles[0]",
          ),
        );
      }),
    ),
  );

  it.effect("bounds configuration-controlled filesystem validation concurrency", () =>
    withNode(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const contextFiles = Array.from({ length: 24 }, (_, index) => `context-${index}.md`);
        const contents = validConfiguration.replace(
          "baseBranch: main",
          `baseBranch: main\n  contextFiles: [${contextFiles.join(", ")}]`,
        );
        const repository = yield* makeRepository(contents);
        for (const contextFile of contextFiles) {
          yield* fs.writeFileString(path.join(repository.root, contextFile), contextFile);
        }
        let active = 0;
        let maximum = 0;
        const observingFileSystem = {
          ...fs,
          realPath: (target) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                active += 1;
                maximum = Math.max(maximum, active);
              }),
              () => Effect.sleep("5 millis").pipe(Effect.flatMap(() => fs.realPath(target))),
              () =>
                Effect.sync(() => {
                  active -= 1;
                }),
            ),
        } satisfies FileSystem.FileSystem;

        yield* resolveProjectConfiguration({
          repositoryRoot: repository.root,
          sourcePath: repository.sourcePath,
          contents,
        }).pipe(Effect.provideService(FileSystem.FileSystem, observingFileSystem));

        assert.isAtMost(maximum, 8);
      }),
    ).pipe(TestClock.withLive),
  );
});
