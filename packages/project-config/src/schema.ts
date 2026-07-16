import * as Schema from "effect/Schema";

const StringArray = Schema.Array(Schema.String);

export const ProjectEnvironmentReference = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
});
export type ProjectEnvironmentReference = typeof ProjectEnvironmentReference.Type;

export const ProjectArtifactDeclaration = Schema.Struct({
  path: Schema.String,
  optional: Schema.optional(Schema.Boolean),
});
export type ProjectArtifactDeclaration = typeof ProjectArtifactDeclaration.Type;

export const ProjectCommandDefinition = Schema.Struct({
  id: Schema.String,
  executable: Schema.String,
  args: StringArray,
  workingDirectory: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number),
  environment: Schema.optional(Schema.Array(ProjectEnvironmentReference)),
  artifacts: Schema.optional(Schema.Array(ProjectArtifactDeclaration)),
});
export type ProjectCommandDefinition = typeof ProjectCommandDefinition.Type;

export const ProjectCheckDefinition = Schema.Struct({
  id: Schema.String,
  executable: Schema.String,
  args: StringArray,
  workingDirectory: Schema.optional(Schema.String),
  timeoutSeconds: Schema.optional(Schema.Number),
  environment: Schema.optional(Schema.Array(ProjectEnvironmentReference)),
  artifacts: Schema.optional(Schema.Array(ProjectArtifactDeclaration)),
  failureBehavior: Schema.optional(Schema.Literals(["fail", "continue"])),
});
export type ProjectCheckDefinition = typeof ProjectCheckDefinition.Type;

export const ProjectConfigurationFile = Schema.Struct({
  version: Schema.Literal(1),
  project: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  repository: Schema.Struct({
    baseBranch: Schema.String,
    worktreeRoot: Schema.optional(Schema.String),
    contextFiles: Schema.optional(StringArray),
  }),
  setup: Schema.optional(Schema.Array(ProjectCommandDefinition)),
  checks: Schema.optional(Schema.Array(ProjectCheckDefinition)),
  workflows: Schema.optional(
    Schema.Struct({
      allowed: Schema.optional(StringArray),
    }),
  ),
  execution: Schema.Struct({
    defaultProfile: Schema.String,
  }),
});
export type ProjectConfigurationFile = typeof ProjectConfigurationFile.Type;

export const ResolvedProjectArtifact = Schema.Struct({
  path: Schema.String,
  optional: Schema.Boolean,
});
export type ResolvedProjectArtifact = typeof ResolvedProjectArtifact.Type;

export const ResolvedProjectCommand = Schema.Struct({
  id: Schema.String,
  executable: Schema.String,
  args: StringArray,
  workingDirectory: Schema.String,
  resolvedWorkingDirectory: Schema.String,
  timeoutSeconds: Schema.Number,
  environment: Schema.Array(ProjectEnvironmentReference),
  artifacts: Schema.Array(ResolvedProjectArtifact),
});
export type ResolvedProjectCommand = typeof ResolvedProjectCommand.Type;

export const ResolvedProjectCheck = Schema.Struct({
  id: Schema.String,
  executable: Schema.String,
  args: StringArray,
  workingDirectory: Schema.String,
  resolvedWorkingDirectory: Schema.String,
  timeoutSeconds: Schema.Number,
  environment: Schema.Array(ProjectEnvironmentReference),
  artifacts: Schema.Array(ResolvedProjectArtifact),
  failureBehavior: Schema.Literals(["fail", "continue"]),
});
export type ResolvedProjectCheck = typeof ResolvedProjectCheck.Type;

export const ResolvedContextFile = Schema.Struct({
  path: Schema.String,
  resolvedPath: Schema.String,
});
export type ResolvedContextFile = typeof ResolvedContextFile.Type;

export const ResolvedProjectConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  project: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    description: Schema.optional(Schema.String),
  }),
  repository: Schema.Struct({
    baseBranch: Schema.String,
    root: Schema.String,
    worktreeRoot: Schema.String,
    contextFiles: Schema.Array(ResolvedContextFile),
  }),
  setup: Schema.Array(ResolvedProjectCommand),
  checks: Schema.Array(ResolvedProjectCheck),
  workflows: Schema.Struct({ allowed: StringArray }),
  execution: Schema.Struct({ defaultProfile: Schema.String }),
  sourcePath: Schema.String,
  contentDigest: Schema.String,
});
export type ResolvedProjectConfiguration = typeof ResolvedProjectConfiguration.Type;

export const ProjectConfigIssueCode = Schema.Literals([
  "file_missing",
  "yaml_malformed",
  "unsupported_version",
  "unknown_key",
  "schema_invalid",
  "invalid_project_id",
  "duplicate_id",
  "empty_executable",
  "invalid_timeout",
  "invalid_reference",
  "unsafe_path",
  "path_missing",
  "path_not_directory",
  "path_not_file",
  "path_symlink_escape",
  "repository_not_found",
  "repository_not_directory",
  "repository_not_git",
  "read_failed",
  "digest_failed",
]);
export type ProjectConfigIssueCode = typeof ProjectConfigIssueCode.Type;

export const ProjectConfigIssue = Schema.Struct({
  code: ProjectConfigIssueCode,
  path: Schema.String,
  message: Schema.String,
});
export type ProjectConfigIssue = typeof ProjectConfigIssue.Type;

export class ProjectConfigError extends Schema.TaggedErrorClass<ProjectConfigError>()(
  "ProjectConfigError",
  {
    sourcePath: Schema.String,
    issues: Schema.Array(ProjectConfigIssue),
    message: Schema.String,
  },
) {}
