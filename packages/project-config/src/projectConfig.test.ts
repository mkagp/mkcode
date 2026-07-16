import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  loadProjectConfiguration,
  parseProjectConfiguration,
  PROJECT_CONFIG_RELATIVE_PATH,
  resolveProjectConfiguration,
} from "./projectConfig.ts";

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
      resolveFixture(contents).pipe(Effect.catchTag("PlatformError", (cause) => Effect.die(cause))),
    );
    assert.isTrue(error.issues.some((issue) => issue.code === code));
  });

const expectIssueAt = (contents: string, code: string, path: string) =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveFixture(contents).pipe(Effect.catchTag("PlatformError", (cause) => Effect.die(cause))),
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
});
