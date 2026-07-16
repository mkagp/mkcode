import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { parseDocument } from "yaml";

import {
  ProjectConfigError,
  type ProjectConfigIssue,
  ProjectConfigurationFile,
  type ProjectConfigurationFile as ProjectConfigurationFileType,
  type ProjectCommandDefinition,
  type ProjectCheckDefinition,
  type ResolvedProjectArtifact,
  type ResolvedProjectCommand,
  type ResolvedProjectCheck,
  type ResolvedProjectConfiguration,
} from "./schema.ts";

export const PROJECT_CONFIG_RELATIVE_PATH = ".mkcode/project.yaml";
export const PROJECT_CONFIG_VERSION = 1 as const;
export const DEFAULT_COMMAND_TIMEOUT_SECONDS = 300;
const FILESYSTEM_VALIDATION_CONCURRENCY = 8;

const PROJECT_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const isGitBranchReference = (value: string): boolean => {
  if (
    !REFERENCE_PATTERN.test(value) ||
    value === "@" ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("//") ||
    value.includes("..") ||
    value.includes("@{")
  ) {
    return false;
  }
  return value
    .split("/")
    .every(
      (component) =>
        component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock"),
    );
};
const decodeProjectConfigurationFile = Schema.decodeUnknownEffect(ProjectConfigurationFile, {
  onExcessProperty: "error",
  errors: "all",
});
const formatSchemaIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const formatIssuePath = (segments: ReadonlyArray<unknown>): string =>
  segments.reduce<string>((result, segment) => {
    const key =
      typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment;
    return typeof key === "number"
      ? `${result}[${key}]`
      : result.length === 0
        ? String(key)
        : `${result}.${String(key)}`;
  }, "");

const allowedKeys = new Map<string, ReadonlySet<string>>([
  ["", new Set(["version", "project", "repository", "setup", "checks", "workflows", "execution"])],
  ["project", new Set(["id", "name", "description"])],
  ["repository", new Set(["baseBranch", "worktreeRoot", "contextFiles"])],
  [
    "setup[]",
    new Set([
      "id",
      "executable",
      "args",
      "workingDirectory",
      "timeoutSeconds",
      "environment",
      "artifacts",
    ]),
  ],
  [
    "checks[]",
    new Set([
      "id",
      "executable",
      "args",
      "workingDirectory",
      "timeoutSeconds",
      "environment",
      "artifacts",
      "failureBehavior",
    ]),
  ],
  ["setup[].environment[]", new Set(["name", "source"])],
  ["checks[].environment[]", new Set(["name", "source"])],
  ["setup[].artifacts[]", new Set(["path", "optional"])],
  ["checks[].artifacts[]", new Set(["path", "optional"])],
  ["workflows", new Set(["allowed"])],
  ["execution", new Set(["defaultProfile"])],
]);
const requiredKeys = new Map<string, ReadonlySet<string>>([
  ["", new Set(["version", "project", "repository", "execution"])],
  ["project", new Set(["id", "name"])],
  ["repository", new Set(["baseBranch"])],
  ["setup[]", new Set(["id", "executable", "args"])],
  ["checks[]", new Set(["id", "executable", "args"])],
  ["setup[].environment[]", new Set(["name", "source"])],
  ["checks[].environment[]", new Set(["name", "source"])],
  ["setup[].artifacts[]", new Set(["path"])],
  ["checks[].artifacts[]", new Set(["path"])],
  ["execution", new Set(["defaultProfile"])],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function collectStructuralIssues(value: unknown): ReadonlyArray<ProjectConfigIssue> {
  const issues: Array<ProjectConfigIssue> = [];
  const inspect = (current: unknown, shape: string, displayPath: string): void => {
    if (!isRecord(current)) return;
    const keys = allowedKeys.get(shape);
    if (keys) {
      for (const key of Object.keys(current)) {
        if (!keys.has(key)) {
          issues.push({
            code: "unknown_key",
            path: displayPath ? `${displayPath}.${key}` : key,
            message: `Unknown configuration key '${key}'.`,
          });
        }
      }
    }
    const required = requiredKeys.get(shape);
    if (required) {
      for (const key of required) {
        if (!(key in current)) {
          const path = displayPath ? `${displayPath}.${key}` : key;
          issues.push({
            code: "schema_invalid",
            path,
            message: `Required configuration key '${path}' is missing.`,
          });
        }
      }
    }
    if (shape === "") {
      inspect(current.project, "project", "project");
      inspect(current.repository, "repository", "repository");
      inspect(current.workflows, "workflows", "workflows");
      inspect(current.execution, "execution", "execution");
      for (const section of ["setup", "checks"] as const) {
        const entries = current[section];
        if (!Array.isArray(entries)) continue;
        entries.forEach((entry, index) => {
          const itemShape = `${section}[]`;
          const itemPath = `${section}[${index}]`;
          inspect(entry, itemShape, itemPath);
          if (!isRecord(entry)) return;
          for (const nested of ["environment", "artifacts"] as const) {
            const nestedEntries = entry[nested];
            if (!Array.isArray(nestedEntries)) continue;
            nestedEntries.forEach((nestedEntry, nestedIndex) =>
              inspect(
                nestedEntry,
                `${itemShape}.${nested}[]`,
                `${itemPath}.${nested}[${nestedIndex}]`,
              ),
            );
          }
        });
      }
    }
  };
  inspect(value, "", "");
  return issues;
}

const failConfig = (sourcePath: string, issues: ReadonlyArray<ProjectConfigIssue>) =>
  Effect.fail(
    new ProjectConfigError({
      sourcePath,
      issues: [...issues],
      message: `Project configuration at '${sourcePath}' is invalid.`,
    }),
  );

export const parseProjectConfiguration = (input: {
  readonly sourcePath: string;
  readonly contents: string;
}): Effect.Effect<ProjectConfigurationFileType, ProjectConfigError> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.sync(() => {
      try {
        const document = parseDocument(input.contents, {
          prettyErrors: false,
          strict: true,
          uniqueKeys: true,
        });
        if (document.errors.length > 0) {
          const first = document.errors[0];
          const position = first?.linePos?.[0];
          return {
            issue: {
              code: "yaml_malformed" as const,
              path: "$",
              message: `Malformed YAML${position ? ` at line ${position.line}, column ${position.col}` : ""}.`,
            },
          };
        }
        return { value: document.toJS({ maxAliasCount: 0 }) as unknown };
      } catch {
        return {
          issue: {
            code: "yaml_malformed" as const,
            path: "$",
            message: "Malformed YAML.",
          },
        };
      }
    });
    if ("issue" in parsed) return yield* failConfig(input.sourcePath, [parsed.issue]);

    if (isRecord(parsed.value) && parsed.value.version !== PROJECT_CONFIG_VERSION) {
      return yield* failConfig(input.sourcePath, [
        {
          code: "unsupported_version",
          path: "version",
          message: `Only project configuration version ${PROJECT_CONFIG_VERSION} is supported.`,
        },
      ]);
    }

    const structuralIssues = collectStructuralIssues(parsed.value);
    if (structuralIssues.length > 0) return yield* failConfig(input.sourcePath, structuralIssues);

    return yield* decodeProjectConfigurationFile(parsed.value).pipe(
      Effect.mapError((cause) => {
        const formatted = formatSchemaIssues(cause.issue);
        return new ProjectConfigError({
          sourcePath: input.sourcePath,
          issues: formatted.issues.map((issue) => {
            const path = formatIssuePath(issue.path ?? []);
            return {
              code: "schema_invalid" as const,
              path: path || "$",
              message: path
                ? `Configuration value at '${path}' does not match the version 1 schema.`
                : "Configuration does not match the version 1 schema.",
            };
          }),
          message: `Project configuration at '${input.sourcePath}' is invalid.`,
        });
      }),
    );
  });

function semanticIssues(config: ProjectConfigurationFileType): ReadonlyArray<ProjectConfigIssue> {
  const issues: Array<ProjectConfigIssue> = [];
  const requireText = (
    value: string,
    path: string,
    code: ProjectConfigIssue["code"] = "invalid_reference",
  ) => {
    if (value.trim().length === 0)
      issues.push({ code, path, message: `${path} must not be empty.` });
  };
  if (!PROJECT_ID_PATTERN.test(config.project.id) || config.project.id.length > 64) {
    issues.push({
      code: "invalid_project_id",
      path: "project.id",
      message: "project.id must be a lowercase kebab-case identifier of at most 64 characters.",
    });
  }
  requireText(config.project.name, "project.name");
  requireText(config.repository.baseBranch, "repository.baseBranch");
  if (!isGitBranchReference(config.repository.baseBranch)) {
    issues.push({
      code: "invalid_reference",
      path: "repository.baseBranch",
      message: "repository.baseBranch is not a supported branch reference.",
    });
  }
  requireText(config.execution.defaultProfile, "execution.defaultProfile");
  if (!REFERENCE_PATTERN.test(config.execution.defaultProfile)) {
    issues.push({
      code: "invalid_reference",
      path: "execution.defaultProfile",
      message: "execution.defaultProfile is not a valid opaque reference.",
    });
  }
  const ids = new Set<string>();
  const inspectCommand = (
    command: ProjectCommandDefinition | ProjectCheckDefinition,
    path: string,
  ) => {
    requireText(command.id, `${path}.id`);
    if (ids.has(command.id))
      issues.push({
        code: "duplicate_id",
        path: `${path}.id`,
        message: `Command or check id '${command.id}' is duplicated.`,
      });
    ids.add(command.id);
    requireText(command.executable, `${path}.executable`, "empty_executable");
    if (command.executable.includes("\0"))
      issues.push({
        code: "empty_executable",
        path: `${path}.executable`,
        message: "Executable names must not contain NUL characters.",
      });
    const timeout = command.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86_400) {
      issues.push({
        code: "invalid_timeout",
        path: `${path}.timeoutSeconds`,
        message: "timeoutSeconds must be an integer between 1 and 86400.",
      });
    }
    for (const [index, reference] of (command.environment ?? []).entries()) {
      if (
        !ENVIRONMENT_NAME_PATTERN.test(reference.name) ||
        !ENVIRONMENT_NAME_PATTERN.test(reference.source)
      ) {
        issues.push({
          code: "invalid_reference",
          path: `${path}.environment[${index}]`,
          message: "Environment names and sources must be variable-name references, not values.",
        });
      }
    }
  };
  (config.setup ?? []).forEach((command, index) => inspectCommand(command, `setup[${index}]`));
  (config.checks ?? []).forEach((check, index) => inspectCommand(check, `checks[${index}]`));
  const workflowIds = new Set<string>();
  for (const [index, workflow] of (config.workflows?.allowed ?? []).entries()) {
    if (!REFERENCE_PATTERN.test(workflow) || workflowIds.has(workflow)) {
      issues.push({
        code: "invalid_reference",
        path: `workflows.allowed[${index}]`,
        message: "Workflow references must be valid and unique.",
      });
    }
    workflowIds.add(workflow);
  }
  return issues;
}

const toPosix = (value: string): string => value.replaceAll("\\", "/");

export const resolveProjectConfiguration = (input: {
  readonly repositoryRoot: string;
  readonly sourcePath: string;
  readonly contents: string;
}): Effect.Effect<
  ResolvedProjectConfiguration,
  ProjectConfigError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const config = yield* parseProjectConfiguration(input);
    const issues = [...semanticIssues(config)];
    const fileSystemIssue = (
      cause: PlatformError.PlatformError,
      details: {
        readonly path: string;
        readonly missingCode: ProjectConfigIssue["code"];
        readonly missingMessage: string;
        readonly readMessage: string;
      },
    ): ProjectConfigIssue => ({
      code: cause.reason._tag === "NotFound" ? details.missingCode : "read_failed",
      path: details.path,
      message: cause.reason._tag === "NotFound" ? details.missingMessage : details.readMessage,
    });

    const repositoryRoot = yield* fs.realPath(input.repositoryRoot).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectConfigError({
            sourcePath: input.sourcePath,
            issues: [
              fileSystemIssue(cause, {
                path: "repositoryRoot",
                missingCode: "path_missing",
                missingMessage: "The registered repository root does not exist.",
                readMessage: "The registered repository root could not be inspected.",
              }),
            ],
            message: `Project configuration at '${input.sourcePath}' could not be resolved.`,
          }),
      ),
    );
    const insideRoot = (candidate: string): boolean => {
      const relative = toPosix(path.relative(repositoryRoot, candidate));
      return (
        relative === "" ||
        relative === "." ||
        (!relative.startsWith("../") && relative !== ".." && !path.isAbsolute(relative))
      );
    };
    const lexicalPath = (
      relativePath: string,
      issuePath: string,
      allowRoot = false,
    ): { relative: string; absolute: string } | undefined => {
      const trimmed = relativePath.trim();
      if (trimmed.length === 0 || path.isAbsolute(relativePath)) {
        issues.push({
          code: "unsafe_path",
          path: issuePath,
          message: "Path must be repository-relative.",
        });
        return undefined;
      }
      const absolute = path.resolve(repositoryRoot, relativePath);
      if (!insideRoot(absolute) || (!allowRoot && absolute === repositoryRoot)) {
        issues.push({
          code: "unsafe_path",
          path: issuePath,
          message: "Path must not escape the registered repository.",
        });
        return undefined;
      }
      const relative = toPosix(path.relative(repositoryRoot, absolute)) || ".";
      return { relative, absolute };
    };
    const existingPath = (
      relativePath: string,
      issuePath: string,
      expected: "Directory" | "File",
      allowRoot = false,
    ) =>
      Effect.gen(function* () {
        const candidate = lexicalPath(relativePath, issuePath, allowRoot);
        if (!candidate) return undefined;
        const canonical = yield* Effect.result(fs.realPath(candidate.absolute));
        if (canonical._tag === "Failure") {
          issues.push(
            fileSystemIssue(canonical.failure, {
              path: issuePath,
              missingCode: "path_missing",
              missingMessage: "Referenced path does not exist.",
              readMessage: "Referenced path could not be inspected.",
            }),
          );
          return undefined;
        }
        if (!insideRoot(canonical.success)) {
          issues.push({
            code: "path_symlink_escape",
            path: issuePath,
            message: "Referenced path resolves outside the registered repository.",
          });
          return undefined;
        }
        const info = yield* Effect.result(fs.stat(canonical.success));
        if (info._tag === "Failure") {
          issues.push(
            fileSystemIssue(info.failure, {
              path: issuePath,
              missingCode: "path_missing",
              missingMessage: "Referenced path does not exist.",
              readMessage: "Referenced path could not be inspected.",
            }),
          );
          return undefined;
        }
        if (info.success.type !== expected) {
          issues.push({
            code: expected === "Directory" ? "path_not_directory" : "path_not_file",
            path: issuePath,
            message: `Referenced path must be a ${expected.toLowerCase()}.`,
          });
          return undefined;
        }
        return { relative: candidate.relative, absolute: canonical.success };
      });

    const sourceResult = yield* Effect.result(fs.realPath(input.sourcePath));
    let sourceCanonical: string | undefined;
    if (sourceResult._tag === "Failure") {
      issues.push(
        fileSystemIssue(sourceResult.failure, {
          path: "$",
          missingCode: "file_missing",
          missingMessage: "Project configuration file does not exist.",
          readMessage: "Project configuration file could not be inspected.",
        }),
      );
    } else if (!insideRoot(sourceResult.success)) {
      issues.push({
        code: "path_symlink_escape",
        path: "$",
        message: "Project configuration resolves outside the registered repository.",
      });
    } else {
      sourceCanonical = sourceResult.success;
    }

    const futurePath = (relativePath: string, issuePath: string, expectedTarget?: "Directory") =>
      Effect.gen(function* () {
        const candidate = lexicalPath(relativePath, issuePath);
        if (!candidate) return undefined;
        let probe = candidate.absolute;

        while (true) {
          const canonical = yield* Effect.result(fs.realPath(probe));
          if (canonical._tag === "Failure") {
            if (canonical.failure.reason._tag !== "NotFound") {
              issues.push(
                fileSystemIssue(canonical.failure, {
                  path: issuePath,
                  missingCode: "path_missing",
                  missingMessage: "Referenced path does not exist.",
                  readMessage: "Referenced path could not be inspected.",
                }),
              );
              return undefined;
            }
            const symbolicLink = yield* Effect.result(fs.readLink(probe));
            if (symbolicLink._tag === "Success") {
              issues.push({
                code: "path_symlink_escape",
                path: issuePath,
                message: "Referenced path contains a dangling symbolic-link ancestor.",
              });
              return undefined;
            }
            if (symbolicLink.failure.reason._tag !== "NotFound") {
              issues.push(
                fileSystemIssue(symbolicLink.failure, {
                  path: issuePath,
                  missingCode: "path_missing",
                  missingMessage: "Referenced path does not exist.",
                  readMessage: "Referenced path could not be inspected without following links.",
                }),
              );
              return undefined;
            }
            const parent = path.dirname(probe);
            if (parent === probe) {
              issues.push({
                code: "read_failed",
                path: issuePath,
                message: "Referenced path has no inspectable existing ancestor.",
              });
              return undefined;
            }
            probe = parent;
            continue;
          }

          if (!insideRoot(canonical.success)) {
            issues.push({
              code: "path_symlink_escape",
              path: issuePath,
              message: "Referenced path has an ancestor outside the registered repository.",
            });
            return undefined;
          }
          const info = yield* Effect.result(fs.stat(canonical.success));
          if (info._tag === "Failure") {
            issues.push(
              fileSystemIssue(info.failure, {
                path: issuePath,
                missingCode: "path_missing",
                missingMessage: "Referenced path does not exist.",
                readMessage: "Referenced path could not be inspected.",
              }),
            );
            return undefined;
          }
          const targetExists = probe === candidate.absolute;
          if (
            (!targetExists || expectedTarget === "Directory") &&
            info.success.type !== "Directory"
          ) {
            issues.push({
              code: "path_not_directory",
              path: issuePath,
              message: "Referenced path or its existing ancestor must be a directory.",
            });
            return undefined;
          }
          const suffix = path.relative(probe, candidate.absolute);
          const absolute = path.resolve(canonical.success, suffix);
          if (!insideRoot(absolute)) {
            issues.push({
              code: "path_symlink_escape",
              path: issuePath,
              message: "Referenced path resolves outside the registered repository.",
            });
            return undefined;
          }
          return { relative: candidate.relative, absolute };
        }
      });

    const normalizeArtifacts = (
      artifacts: ProjectCommandDefinition["artifacts"],
      basePath: string,
    ) =>
      Effect.all(
        (artifacts ?? []).map((artifact, index) =>
          futurePath(artifact.path, `${basePath}.artifacts[${index}].path`).pipe(
            Effect.map((resolved) =>
              resolved
                ? ({
                    path: resolved.relative,
                    optional: artifact.optional ?? false,
                  } satisfies ResolvedProjectArtifact)
                : undefined,
            ),
          ),
        ),
        // Commands are already validated with bounded parallelism. Keep each
        // command's artifact walk sequential so nested configuration cannot
        // multiply the filesystem concurrency limit.
        { concurrency: 1 },
      ).pipe(
        Effect.map((resolved) =>
          resolved.filter((value): value is ResolvedProjectArtifact => value !== undefined),
        ),
      );
    const normalizeCommand = (
      command: ProjectCommandDefinition,
      basePath: string,
    ): Effect.Effect<
      ResolvedProjectCommand | undefined,
      never,
      FileSystem.FileSystem | Path.Path
    > =>
      Effect.gen(function* () {
        const working = yield* existingPath(
          command.workingDirectory ?? ".",
          `${basePath}.workingDirectory`,
          "Directory",
          true,
        );
        if (!working) return undefined;
        const artifacts = yield* normalizeArtifacts(command.artifacts, basePath);
        return {
          id: command.id,
          executable: command.executable.trim(),
          args: [...command.args],
          workingDirectory: working.relative,
          resolvedWorkingDirectory: working.absolute,
          timeoutSeconds: command.timeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS,
          environment: [...(command.environment ?? [])],
          artifacts,
        };
      });
    const setup = (yield* Effect.all(
      (config.setup ?? []).map((command, index) => normalizeCommand(command, `setup[${index}]`)),
      { concurrency: FILESYSTEM_VALIDATION_CONCURRENCY },
    )).filter((value): value is ResolvedProjectCommand => value !== undefined);
    const checks = (yield* Effect.all(
      (config.checks ?? []).map((check, index) =>
        normalizeCommand(check, `checks[${index}]`).pipe(
          Effect.map((command) =>
            command
              ? ({
                  ...command,
                  failureBehavior: check.failureBehavior ?? "fail",
                } satisfies ResolvedProjectCheck)
              : undefined,
          ),
        ),
      ),
      { concurrency: FILESYSTEM_VALIDATION_CONCURRENCY },
    )).filter((value): value is ResolvedProjectCheck => value !== undefined);
    const contextFiles = (yield* Effect.all(
      (config.repository.contextFiles ?? []).map((reference, index) =>
        existingPath(reference, `repository.contextFiles[${index}]`, "File"),
      ),
      { concurrency: FILESYSTEM_VALIDATION_CONCURRENCY },
    ))
      .filter((value): value is { relative: string; absolute: string } => value !== undefined)
      .map((value) => ({ path: value.relative, resolvedPath: value.absolute }));

    const worktree = yield* futurePath(
      config.repository.worktreeRoot ?? ".mkcode/worktrees",
      "repository.worktreeRoot",
      "Directory",
    );
    if (issues.length > 0 || !worktree) return yield* failConfig(input.sourcePath, issues);
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(input.contents)).pipe(
      Effect.map(Encoding.encodeHex),
      Effect.mapError(
        () =>
          new ProjectConfigError({
            sourcePath: input.sourcePath,
            issues: [
              {
                code: "digest_failed",
                path: "$",
                message: "Could not compute the configuration digest.",
              },
            ],
            message: `Project configuration at '${input.sourcePath}' could not be resolved.`,
          }),
      ),
    );
    return {
      version: PROJECT_CONFIG_VERSION,
      project: {
        id: config.project.id,
        name: config.project.name.trim(),
        ...(config.project.description === undefined
          ? {}
          : { description: config.project.description.trim() }),
      },
      repository: {
        baseBranch: config.repository.baseBranch.trim(),
        root: repositoryRoot,
        worktreeRoot: worktree.absolute,
        contextFiles,
      },
      setup,
      checks,
      workflows: { allowed: [...(config.workflows?.allowed ?? [])] },
      execution: { defaultProfile: config.execution.defaultProfile.trim() },
      sourcePath: sourceCanonical ?? input.sourcePath,
      contentDigest: digest,
    };
  });

export const loadProjectConfiguration = (repositoryRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const canonicalRepository = yield* fs.realPath(repositoryRoot).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectConfigError({
            sourcePath: path.join(repositoryRoot, PROJECT_CONFIG_RELATIVE_PATH),
            issues: [
              {
                code: cause.reason._tag === "NotFound" ? "path_missing" : "read_failed",
                path: "repositoryRoot",
                message:
                  cause.reason._tag === "NotFound"
                    ? "The registered repository root does not exist."
                    : "The registered repository root could not be inspected.",
              },
            ],
            message: "Project configuration could not be loaded.",
          }),
      ),
    );
    const sourcePath = path.join(canonicalRepository, PROJECT_CONFIG_RELATIVE_PATH);
    const sourceCanonical = yield* fs.realPath(sourcePath).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectConfigError({
            sourcePath,
            issues: [
              {
                code: cause.reason._tag === "NotFound" ? "file_missing" : "read_failed",
                path: "$",
                message:
                  cause.reason._tag === "NotFound"
                    ? "Project configuration file does not exist."
                    : "Project configuration file could not be inspected.",
              },
            ],
            message: `Project configuration at '${sourcePath}' could not be loaded.`,
          }),
      ),
    );
    const relativeSource = toPosix(path.relative(canonicalRepository, sourceCanonical));
    if (
      relativeSource.startsWith("../") ||
      relativeSource === ".." ||
      path.isAbsolute(relativeSource)
    ) {
      return yield* failConfig(sourcePath, [
        {
          code: "path_symlink_escape",
          path: "$",
          message: "Project configuration resolves outside the registered repository.",
        },
      ]);
    }
    const contents = yield* fs.readFileString(sourceCanonical).pipe(
      Effect.mapError(
        () =>
          new ProjectConfigError({
            sourcePath,
            issues: [
              {
                code: "read_failed",
                path: "$",
                message: "Project configuration file could not be read.",
              },
            ],
            message: `Project configuration at '${sourcePath}' could not be loaded.`,
          }),
      ),
    );
    return yield* resolveProjectConfiguration({
      repositoryRoot: canonicalRepository,
      sourcePath: sourceCanonical,
      contents,
    });
  });
