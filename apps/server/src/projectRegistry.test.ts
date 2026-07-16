import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "./config.ts";
import * as ProjectRegistryModule from "./projectRegistry.ts";

const configuration = (name = "Registered Project") => `version: 1
project:
  id: registered-project
  name: ${name}
repository:
  baseBranch: main
setup:
  - id: install
    executable: pnpm
    args: [install, --frozen-lockfile]
checks:
  - id: test
    executable: pnpm
    args: [exec, vitest, run]
workflows:
  allowed: [feature]
execution:
  defaultProfile: coding-workhorse
`;

const makeRegistryLayer = (baseDir: string) =>
  ProjectRegistryModule.layer.pipe(
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), baseDir))),
  );

const makeRepository = (input?: { readonly git?: boolean; readonly config?: string | null }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-project-registry-repo-" });
    if (input?.git !== false) yield* fs.makeDirectory(path.join(root, ".git"));
    if (input?.config !== null) {
      yield* fs.makeDirectory(path.join(root, ".mkcode"), { recursive: true });
      yield* fs.writeFileString(
        path.join(root, ".mkcode", "project.yaml"),
        input?.config ?? configuration(),
      );
    }
    return root;
  });

const withRegistry = <A, E, R>(
  run: Effect.Effect<A, E, R | ProjectRegistryModule.ProjectRegistry>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "mkcode-project-registry-state-" });
    return yield* run.pipe(Effect.provide(makeRegistryLayer(baseDir)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("project registry", () => {
  it.effect("registers a valid local Git repository and persists a resolved snapshot", () =>
    withRegistry(
      Effect.gen(function* () {
        const root = yield* makeRepository();
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const registered = yield* registry.register({ repositoryPath: root });

        assert.equal(registered.projectId, "registered-project");
        assert.equal(registered.validationStatus, "valid");
        assert.equal(registered.resolvedConfiguration.setup.length, 1);
        assert.equal(registered.resolvedConfiguration.checks.length, 1);
        assert.equal(registered.validationErrors.length, 0);
        assert.deepEqual(yield* registry.list, [registered]);
      }),
    ),
  );

  it.effect("rejects a nonexistent directory without creating it", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fs.makeTempDirectoryScoped({
          prefix: "mkcode-project-registry-missing-",
        });
        const missing = path.join(parent, "does-not-exist");
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const error = yield* Effect.flip(registry.register({ repositoryPath: missing }));
        assert.equal(error.failure, "repository_not_found");
        assert.isFalse(yield* fs.exists(missing));
      }),
    ),
  );

  it.effect("rejects a non-Git directory", () =>
    withRegistry(
      Effect.gen(function* () {
        const root = yield* makeRepository({ git: false });
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const error = yield* Effect.flip(registry.register({ repositoryPath: root }));
        assert.equal(error.failure, "repository_not_git");
      }),
    ),
  );

  it.effect("reports a missing checked-in configuration as a structured registration error", () =>
    withRegistry(
      Effect.gen(function* () {
        const root = yield* makeRepository({ config: null });
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const error = yield* Effect.flip(registry.register({ repositoryPath: root }));
        assert.equal(error.failure, "configuration_invalid");
        assert.equal(error.validationErrors[0]?.code, "file_missing");
        assert.deepEqual(yield* registry.list, []);
      }),
    ),
  );

  it.effect("updates the snapshot and digest when configuration changes", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeRepository();
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const initial = yield* registry.register({ repositoryPath: root });
        yield* fs.writeFileString(
          path.join(root, ".mkcode", "project.yaml"),
          configuration("Renamed Project"),
        );

        const revalidated = yield* registry.validate("registered-project");
        assert.equal(revalidated.displayName, "Renamed Project");
        assert.notEqual(revalidated.configurationDigest, initial.configurationDigest);
        assert.equal(revalidated.validationStatus, "valid");
      }),
    ),
  );

  it.effect("retains the last valid snapshot and records errors after invalid revalidation", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeRepository();
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const initial = yield* registry.register({ repositoryPath: root });
        yield* fs.writeFileString(path.join(root, ".mkcode", "project.yaml"), "version: [broken\n");

        const revalidated = yield* registry.validate("registered-project");
        assert.equal(revalidated.validationStatus, "invalid");
        assert.equal(revalidated.configurationDigest, initial.configurationDigest);
        assert.equal(revalidated.validationErrors[0]?.code, "yaml_malformed");
      }),
    ),
  );

  it.effect(
    "reports a moved repository before configuration discovery and recovers after restore",
    () =>
      withRegistry(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const root = yield* makeRepository();
          const moved = `${root}-moved`;
          const registry = yield* ProjectRegistryModule.ProjectRegistry;
          const initial = yield* registry.register({ repositoryPath: root });
          yield* fs.rename(root, moved);
          yield* Effect.gen(function* () {
            const unavailable = yield* registry.validate("registered-project");
            assert.equal(unavailable.validationStatus, "invalid");
            assert.equal(unavailable.validationErrors[0]?.code, "repository_not_found");
            assert.equal(unavailable.configurationDigest, initial.configurationDigest);
            assert.equal((yield* registry.read("registered-project")).validationStatus, "invalid");
            assert.equal((yield* registry.list).length, 1);
            assert.isFalse(yield* fs.exists(root));
          }).pipe(Effect.ensuring(fs.rename(moved, root).pipe(Effect.orDie)));

          const restored = yield* registry.validate("registered-project");
          assert.equal(restored.validationStatus, "valid");
          assert.equal(restored.validationErrors.length, 0);
        }),
      ),
  );

  it.effect("reports a deleted repository while retaining the last valid snapshot", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* makeRepository();
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const initial = yield* registry.register({ repositoryPath: root });
        yield* fs.remove(root, { recursive: true });
        yield* Effect.gen(function* () {
          const unavailable = yield* registry.validate("registered-project");
          assert.equal(unavailable.validationStatus, "invalid");
          assert.equal(unavailable.validationErrors[0]?.code, "repository_not_found");
          assert.equal(unavailable.configurationDigest, initial.configurationDigest);
          assert.isFalse(yield* fs.exists(root));
        }).pipe(Effect.ensuring(fs.makeDirectory(root).pipe(Effect.orDie)));
      }),
    ),
  );

  it.effect("reports when a registered repository path is replaced by a file", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* makeRepository();
        const moved = `${root}-moved`;
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const initial = yield* registry.register({ repositoryPath: root });
        yield* fs.rename(root, moved);
        yield* fs.writeFileString(root, "not a directory");

        const unavailable = yield* registry.validate("registered-project");
        assert.equal(unavailable.validationStatus, "invalid");
        assert.equal(unavailable.validationErrors[0]?.code, "repository_not_directory");
        assert.equal(unavailable.configurationDigest, initial.configurationDigest);

        yield* fs.remove(root);
        yield* fs.rename(moved, root);
        assert.equal((yield* registry.validate("registered-project")).validationStatus, "valid");
      }),
    ),
  );

  it.effect("reports when a registered repository path is replaced by a non-Git directory", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* makeRepository();
        const moved = `${root}-moved`;
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const initial = yield* registry.register({ repositoryPath: root });
        yield* fs.rename(root, moved);
        yield* fs.makeDirectory(root);

        const unavailable = yield* registry.validate("registered-project");
        assert.equal(unavailable.validationStatus, "invalid");
        assert.equal(unavailable.validationErrors[0]?.code, "repository_not_git");
        assert.equal(unavailable.configurationDigest, initial.configurationDigest);

        yield* fs.remove(root, { recursive: true });
        yield* fs.rename(moved, root);
        assert.equal((yield* registry.validate("registered-project")).validationStatus, "valid");
      }),
    ),
  );

  it.effect("rejects a registered repository replaced by a symlink", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* makeRepository();
        const replacement = yield* makeRepository();
        const moved = `${root}-moved`;
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const initial = yield* registry.register({ repositoryPath: root });
        yield* fs.rename(root, moved);
        yield* fs.symlink(replacement, root);

        const unavailable = yield* registry.validate("registered-project");
        assert.equal(unavailable.validationStatus, "invalid");
        assert.equal(unavailable.validationErrors[0]?.code, "path_symlink_escape");
        assert.equal(unavailable.configurationDigest, initial.configurationDigest);

        yield* fs.remove(root);
        yield* fs.rename(moved, root);
        assert.equal((yield* registry.validate("registered-project")).validationStatus, "valid");
      }),
    ),
  );

  it.effect("reports a missing configuration only after confirming the repository is valid", () =>
    withRegistry(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* makeRepository();
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        const initial = yield* registry.register({ repositoryPath: root });
        const configurationPath = path.join(root, ".mkcode", "project.yaml");
        const moved = `${root}-moved`;
        yield* fs.remove(configurationPath);
        yield* fs.rename(root, moved);

        const unavailable = yield* registry.validate("registered-project");
        assert.equal(unavailable.validationStatus, "invalid");
        assert.equal(unavailable.validationErrors[0]?.code, "repository_not_found");
        assert.equal(unavailable.configurationDigest, initial.configurationDigest);

        yield* fs.rename(moved, root);
        const missingConfiguration = yield* registry.validate("registered-project");
        assert.equal(missingConfiguration.validationStatus, "invalid");
        assert.equal(missingConfiguration.validationErrors[0]?.code, "file_missing");
        assert.equal(missingConfiguration.configurationDigest, initial.configurationDigest);
        assert.isFalse(yield* fs.exists(configurationPath));
      }),
    ),
  );

  it.effect("keeps disabled projects disabled across validation and revalidates on enable", () =>
    withRegistry(
      Effect.gen(function* () {
        const root = yield* makeRepository();
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        yield* registry.register({ repositoryPath: root });
        const disabled = yield* registry.disable("registered-project");
        assert.isFalse(disabled.enabled);
        assert.equal(disabled.validationStatus, "disabled");
        const validated = yield* registry.validate("registered-project");
        assert.equal(validated.validationStatus, "disabled");
        const enabled = yield* registry.enable("registered-project");
        assert.isTrue(enabled.enabled);
        assert.equal(enabled.validationStatus, "valid");
      }),
    ),
  );

  it.effect("reloads registrations from the isolated atomic store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "mkcode-project-registry-reload-",
      });
      const root = yield* makeRepository();
      yield* Effect.gen(function* () {
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        yield* registry.register({ repositoryPath: root });
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      const persisted = yield* fs.stat(paths.projectRegistrationsPath);
      assert.equal(persisted.mode & 0o777, 0o600);
      yield* fs.chmod(paths.projectRegistrationsPath, 0o664);
      const loaded = yield* Effect.gen(function* () {
        const registry = yield* ProjectRegistryModule.ProjectRegistry;
        return yield* registry.read("registered-project");
      }).pipe(Effect.provide(makeRegistryLayer(baseDir)));
      assert.equal(loaded.repositoryPath, root);
      assert.equal((yield* fs.stat(paths.projectRegistrationsPath)).mode & 0o777, 0o600);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects an empty existing registration store as invalid", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "mkcode-project-registry-empty-store-",
      });
      const paths = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
      yield* fs.makeDirectory(paths.stateDir, { recursive: true });
      yield* fs.writeFileString(paths.projectRegistrationsPath, "\n");

      const error = yield* Effect.flip(
        Effect.gen(function* () {
          const registry = yield* ProjectRegistryModule.ProjectRegistry;
          return yield* registry.list;
        }).pipe(
          Effect.provide(makeRegistryLayer(baseDir)),
          Effect.catchTags({ PlatformError: (cause) => Effect.die(cause) }),
        ),
      );

      assert.equal(error.failure, "persistence_failed");
      assert.equal(yield* fs.readFileString(paths.projectRegistrationsPath), "\n");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
