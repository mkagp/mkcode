// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { CommandCategory } from "@mkcode/factory-contracts";
import type {
  ResolvedProjectCheck,
  ResolvedProjectCommand,
  ResolvedProjectConfiguration,
} from "@mkcode/project-config/schema";

import { WorkflowEngineError } from "./errors.ts";

export type ResolvedSnapshotCommand = ResolvedProjectCommand | ResolvedProjectCheck;

const contained = (root: string, candidate: string): boolean => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    relative === "." ||
    (!NodePath.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`))
  );
};

export const resolveSnapshotCommand = (input: {
  readonly projectSnapshot: ResolvedProjectConfiguration;
  readonly category: CommandCategory;
  readonly commandId: string;
}): ResolvedSnapshotCommand => {
  if (input.projectSnapshot.version !== 1) {
    throw new WorkflowEngineError(
      "unsupported_schema",
      "The workflow project snapshot uses an unsupported command schema.",
    );
  }
  const commands =
    input.category === "setup" ? input.projectSnapshot.setup : input.projectSnapshot.checks;
  const matches = commands.filter((command) => command.id === input.commandId);
  if (matches.length !== 1) {
    throw new WorkflowEngineError(
      "invalid_request",
      matches.length === 0
        ? "The requested project command is not declared in the selected category."
        : "The requested project command is duplicated in the immutable snapshot.",
    );
  }
  const command = matches[0];
  if (!command) {
    throw new WorkflowEngineError("invalid_request", "The requested project command is missing.");
  }
  const root = NodePath.resolve(input.projectSnapshot.repository.root);
  const lexicalWorkingDirectory = NodePath.resolve(root, command.workingDirectory);
  const recordedWorkingDirectory = NodePath.resolve(command.resolvedWorkingDirectory);
  if (
    !NodePath.isAbsolute(input.projectSnapshot.repository.root) ||
    NodePath.isAbsolute(command.workingDirectory) ||
    !contained(root, lexicalWorkingDirectory) ||
    !NodePath.isAbsolute(command.resolvedWorkingDirectory) ||
    !contained(root, recordedWorkingDirectory) ||
    recordedWorkingDirectory !== lexicalWorkingDirectory ||
    command.executable.trim().length === 0 ||
    !Array.isArray(command.args) ||
    command.args.some((argument) => typeof argument !== "string") ||
    !Number.isSafeInteger(command.timeoutSeconds) ||
    command.timeoutSeconds < 1
  ) {
    throw new WorkflowEngineError(
      "invalid_request",
      "The requested project command is unsafe or malformed.",
    );
  }
  return command;
};
