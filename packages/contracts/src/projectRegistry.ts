import { ProjectConfigIssue, ResolvedProjectConfiguration } from "@mkcode/project-config/schema";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectRegistrationValidationStatus = Schema.Literals([
  "valid",
  "invalid",
  "disabled",
]);
export type ProjectRegistrationValidationStatus = typeof ProjectRegistrationValidationStatus.Type;

export const ProjectRegistration = Schema.Struct({
  projectId: TrimmedNonEmptyString,
  repositoryPath: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  displayName: TrimmedNonEmptyString,
  displayOverride: Schema.optional(TrimmedNonEmptyString),
  addedAt: TrimmedNonEmptyString,
  lastValidatedAt: TrimmedNonEmptyString,
  validationStatus: ProjectRegistrationValidationStatus,
  configurationFileLocation: TrimmedNonEmptyString,
  configurationDigest: TrimmedNonEmptyString,
  resolvedConfiguration: ResolvedProjectConfiguration,
  validationErrors: Schema.Array(ProjectConfigIssue),
});
export type ProjectRegistration = typeof ProjectRegistration.Type;

export const ProjectRegisterInput = Schema.Struct({
  repositoryPath: TrimmedNonEmptyString,
  displayOverride: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectRegisterInput = typeof ProjectRegisterInput.Type;

export const ProjectRegistryProjectInput = Schema.Struct({
  projectId: TrimmedNonEmptyString,
});
export type ProjectRegistryProjectInput = typeof ProjectRegistryProjectInput.Type;

export const ProjectRegistrationList = Schema.Struct({
  projects: Schema.Array(ProjectRegistration),
});
export type ProjectRegistrationList = typeof ProjectRegistrationList.Type;

export const ProjectRegistrationFailure = Schema.Literals([
  "repository_not_found",
  "repository_not_directory",
  "repository_not_git",
  "configuration_invalid",
  "project_not_found",
  "project_id_conflict",
  "repository_conflict",
  "persistence_failed",
]);
export type ProjectRegistrationFailure = typeof ProjectRegistrationFailure.Type;

export class ProjectRegistrationError extends Schema.TaggedErrorClass<ProjectRegistrationError>()(
  "ProjectRegistrationError",
  {
    failure: ProjectRegistrationFailure,
    message: TrimmedNonEmptyString,
    projectId: Schema.optional(TrimmedNonEmptyString),
    repositoryPath: Schema.optional(TrimmedNonEmptyString),
    validationErrors: Schema.Array(ProjectConfigIssue),
  },
) {}
