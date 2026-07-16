import {
  loadProjectConfiguration,
  type ResolvedProjectConfiguration,
} from "@mkcode/project-config";
import {
  type ProjectRegisterInput,
  ProjectRegistration as ProjectRegistrationSchema,
  type ProjectRegistration as ProjectRegistrationType,
  ProjectRegistrationError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "./atomicWrite.ts";
import * as ServerConfig from "./config.ts";

const ProjectRegistrationStore = Schema.Struct({
  version: Schema.Literal(1),
  projects: Schema.Array(ProjectRegistrationSchema),
});
type ProjectRegistrationStore = typeof ProjectRegistrationStore.Type;

const decodeStore = Schema.decodeUnknownEffect(Schema.fromJsonString(ProjectRegistrationStore), {
  onExcessProperty: "error",
  errors: "all",
});
const encodeStore = Schema.encodeUnknownEffect(Schema.fromJsonString(ProjectRegistrationStore));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const registrationError = (input: ConstructorParameters<typeof ProjectRegistrationError>[0]) =>
  new ProjectRegistrationError(input);

export class ProjectRegistry extends Context.Service<
  ProjectRegistry,
  {
    readonly register: (
      input: ProjectRegisterInput,
    ) => Effect.Effect<ProjectRegistrationType, ProjectRegistrationError>;
    readonly list: Effect.Effect<ReadonlyArray<ProjectRegistrationType>, ProjectRegistrationError>;
    readonly read: (
      projectId: string,
    ) => Effect.Effect<ProjectRegistrationType, ProjectRegistrationError>;
    readonly validate: (
      projectId: string,
    ) => Effect.Effect<ProjectRegistrationType, ProjectRegistrationError>;
    readonly disable: (
      projectId: string,
    ) => Effect.Effect<ProjectRegistrationType, ProjectRegistrationError>;
    readonly enable: (
      projectId: string,
    ) => Effect.Effect<ProjectRegistrationType, ProjectRegistrationError>;
  }
>()("t3/projectRegistry") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const lock = yield* Semaphore.make(1);
  const loadConfiguration = (repositoryRoot: string) =>
    loadProjectConfiguration(repositoryRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(Crypto.Crypto, crypto),
    );

  const readStore = Effect.fn("ProjectRegistry.readStore")(function* () {
    const raw = yield* fs.readFileString(config.projectRegistrationsPath).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                registrationError({
                  failure: "persistence_failed",
                  message: "Could not read the project registration store.",
                  validationErrors: [],
                }),
              ),
        onSuccess: (value) => Effect.succeed(Option.some(value)),
      }),
    );
    if (Option.isNone(raw) || raw.value.trim().length === 0) {
      return { version: 1 as const, projects: [] };
    }
    return yield* decodeStore(raw.value).pipe(
      Effect.mapError(() =>
        registrationError({
          failure: "persistence_failed",
          message: "The project registration store is invalid.",
          validationErrors: [],
        }),
      ),
    );
  });

  const writeStore = Effect.fn("ProjectRegistry.writeStore")(function* (
    store: ProjectRegistrationStore,
  ) {
    const encoded = yield* encodeStore({
      version: 1,
      projects: [...store.projects].sort((left, right) =>
        left.projectId.localeCompare(right.projectId),
      ),
    }).pipe(
      Effect.mapError(() =>
        registrationError({
          failure: "persistence_failed",
          message: "Could not serialize the project registration store.",
          validationErrors: [],
        }),
      ),
    );
    yield* writeFileStringAtomically({
      filePath: config.projectRegistrationsPath,
      contents: `${encoded}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(() =>
        registrationError({
          failure: "persistence_failed",
          message: "Could not persist project registrations.",
          validationErrors: [],
        }),
      ),
    );
  });

  const canonicalRepository = Effect.fn("ProjectRegistry.canonicalRepository")(function* (
    repositoryPath: string,
  ) {
    const requestedPath = repositoryPath.trim();
    if (!path.isAbsolute(requestedPath)) {
      return yield* registrationError({
        failure: "repository_not_found",
        message: "Project registration requires an absolute local repository path.",
        repositoryPath: requestedPath,
        validationErrors: [],
      });
    }
    const canonical = yield* fs.realPath(requestedPath).pipe(
      Effect.mapError(() =>
        registrationError({
          failure: "repository_not_found",
          message: "The registered repository path does not exist.",
          repositoryPath: requestedPath,
          validationErrors: [],
        }),
      ),
    );
    const info = yield* fs.stat(canonical).pipe(
      Effect.mapError(() =>
        registrationError({
          failure: "repository_not_found",
          message: "The registered repository path could not be inspected.",
          repositoryPath: canonical,
          validationErrors: [],
        }),
      ),
    );
    if (info.type !== "Directory") {
      return yield* registrationError({
        failure: "repository_not_directory",
        message: "The registered repository path must be a directory.",
        repositoryPath: canonical,
        validationErrors: [],
      });
    }
    const gitMarker = path.join(canonical, ".git");
    const gitInfo = yield* fs.stat(gitMarker).pipe(Effect.option);
    if (
      Option.isNone(gitInfo) ||
      (gitInfo.value.type !== "Directory" && gitInfo.value.type !== "File")
    ) {
      return yield* registrationError({
        failure: "repository_not_git",
        message: "The registered directory is not a Git repository.",
        repositoryPath: canonical,
        validationErrors: [],
      });
    }
    return canonical;
  });

  const registrationFromSnapshot = (input: {
    readonly snapshot: ResolvedProjectConfiguration;
    readonly repositoryPath: string;
    readonly addedAt: string;
    readonly validatedAt: string;
    readonly enabled: boolean;
    readonly displayOverride?: string;
  }): ProjectRegistrationType => ({
    projectId: input.snapshot.project.id,
    repositoryPath: input.repositoryPath,
    enabled: input.enabled,
    displayName: input.displayOverride ?? input.snapshot.project.name,
    ...(input.displayOverride === undefined ? {} : { displayOverride: input.displayOverride }),
    addedAt: input.addedAt,
    lastValidatedAt: input.validatedAt,
    validationStatus: input.enabled ? "valid" : "disabled",
    configurationFileLocation: input.snapshot.sourcePath,
    configurationDigest: input.snapshot.contentDigest,
    resolvedConfiguration: input.snapshot,
    validationErrors: [],
  });

  const findProject = (store: ProjectRegistrationStore, projectId: string) => {
    const project = store.projects.find((candidate) => candidate.projectId === projectId);
    return project
      ? Effect.succeed(project)
      : Effect.fail(
          registrationError({
            failure: "project_not_found",
            message: `Registered project '${projectId}' was not found.`,
            projectId,
            validationErrors: [],
          }),
        );
  };

  const replaceProject = (
    store: ProjectRegistrationStore,
    next: ProjectRegistrationType,
  ): ProjectRegistrationStore => ({
    version: 1,
    projects: [...store.projects.filter((project) => project.projectId !== next.projectId), next],
  });

  const register = (input: ProjectRegisterInput) =>
    lock.withPermit(
      Effect.gen(function* () {
        const repositoryPath = yield* canonicalRepository(input.repositoryPath);
        const snapshot = yield* loadConfiguration(repositoryPath).pipe(
          Effect.mapError((error) =>
            registrationError({
              failure: "configuration_invalid",
              message: "The repository project configuration is invalid.",
              repositoryPath,
              validationErrors: [...error.issues],
            }),
          ),
        );
        const store = yield* readStore();
        const idConflict = store.projects.find(
          (project) =>
            project.projectId === snapshot.project.id && project.repositoryPath !== repositoryPath,
        );
        if (idConflict) {
          return yield* registrationError({
            failure: "project_id_conflict",
            message: `Project id '${snapshot.project.id}' is already registered to another repository.`,
            projectId: snapshot.project.id,
            repositoryPath,
            validationErrors: [],
          });
        }
        const repositoryConflict = store.projects.find(
          (project) =>
            project.repositoryPath === repositoryPath && project.projectId !== snapshot.project.id,
        );
        if (repositoryConflict) {
          return yield* registrationError({
            failure: "repository_conflict",
            message: "This repository is already registered with a different stable project id.",
            projectId: repositoryConflict.projectId,
            repositoryPath,
            validationErrors: [],
          });
        }
        const existing = store.projects.find(
          (project) => project.projectId === snapshot.project.id,
        );
        const validatedAt = yield* nowIso;
        const next = registrationFromSnapshot({
          snapshot,
          repositoryPath,
          addedAt: existing?.addedAt ?? validatedAt,
          validatedAt,
          enabled: existing?.enabled ?? true,
          ...(input.displayOverride !== undefined
            ? { displayOverride: input.displayOverride }
            : existing?.displayOverride !== undefined
              ? { displayOverride: existing.displayOverride }
              : {}),
        });
        yield* writeStore(replaceProject(store, next));
        return next;
      }),
    );

  const read = (projectId: string) =>
    lock.withPermit(readStore().pipe(Effect.flatMap((store) => findProject(store, projectId))));

  const list = lock.withPermit(
    readStore().pipe(
      Effect.map((store) =>
        [...store.projects].sort((left, right) => left.projectId.localeCompare(right.projectId)),
      ),
    ),
  );

  const validateUnlocked = Effect.fn("ProjectRegistry.validateUnlocked")(function* (
    store: ProjectRegistrationStore,
    existing: ProjectRegistrationType,
    forceEnabled?: boolean,
  ) {
    const enabled = forceEnabled ?? existing.enabled;
    const validatedAt = yield* nowIso;
    const result = yield* Effect.result(loadConfiguration(existing.repositoryPath));
    let next: ProjectRegistrationType;
    if (result._tag === "Success" && result.success.project.id === existing.projectId) {
      next = registrationFromSnapshot({
        snapshot: result.success,
        repositoryPath: existing.repositoryPath,
        addedAt: existing.addedAt,
        validatedAt,
        enabled,
        ...(existing.displayOverride === undefined
          ? {}
          : { displayOverride: existing.displayOverride }),
      });
    } else {
      const validationErrors =
        result._tag === "Failure"
          ? [...result.failure.issues]
          : [
              {
                code: "invalid_project_id" as const,
                path: "project.id",
                message:
                  "A registered project's stable project id cannot change during revalidation.",
              },
            ];
      next = {
        ...existing,
        enabled,
        lastValidatedAt: validatedAt,
        validationStatus: enabled ? "invalid" : "disabled",
        validationErrors,
      };
    }
    yield* writeStore(replaceProject(store, next));
    return next;
  });

  const validate = (projectId: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const store = yield* readStore();
        const existing = yield* findProject(store, projectId);
        return yield* validateUnlocked(store, existing);
      }),
    );

  const disable = (projectId: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const store = yield* readStore();
        const existing = yield* findProject(store, projectId);
        const next = { ...existing, enabled: false, validationStatus: "disabled" as const };
        yield* writeStore(replaceProject(store, next));
        return next;
      }),
    );

  const enable = (projectId: string) =>
    lock.withPermit(
      Effect.gen(function* () {
        const store = yield* readStore();
        const existing = yield* findProject(store, projectId);
        return yield* validateUnlocked(store, existing, true);
      }),
    );

  return ProjectRegistry.of({ register, list, read, validate, disable, enable });
});

export const layer = Layer.effect(ProjectRegistry, make);
