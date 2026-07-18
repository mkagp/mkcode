// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { AgentRuntimeError, type BuilderTaskEnvelope } from "./contracts.ts";

const IDENTIFIER = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const MAXIMUM_RUNTIME_SECONDS = 86_400;
const MAX_SCOPE_PATTERN_LENGTH = 512;
const MAX_SCOPE_PATH_LENGTH = 4096;
const MAX_SCOPE_WILDCARDS = 32;

export const DEFAULT_FORBIDDEN_PATHS = [".git/**", ".mkcode/**"] as const;

const assertText = (value: string, name: string): void => {
  if (value.trim().length === 0) {
    throw new AgentRuntimeError("invalid_configuration", `${name} must not be empty.`);
  }
};

export const validateScopePattern = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").trim().replace(/^\.\//u, "");
  const wildcardCount = [...normalized].filter((character) => character === "*").length;
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SCOPE_PATTERN_LENGTH ||
    wildcardCount > MAX_SCOPE_WILDCARDS ||
    normalized.includes("\0") ||
    NodePath.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new AgentRuntimeError(
      "invalid_configuration",
      "Agent path patterns must be safe project-relative paths.",
    );
  }
  return normalized;
};

const normalizeScopePath = (value: string): string => {
  // Observed Git paths are filesystem identities. Whitespace is significant and must not
  // be normalized away before policy matching.
  const normalized = value.replace(/^\.\//u, "");
  if (
    normalized.length === 0 ||
    normalized.length > MAX_SCOPE_PATH_LENGTH ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    NodePath.posix.isAbsolute(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new AgentRuntimeError(
      "invalid_configuration",
      "Agent changed paths must be safe project-relative paths.",
    );
  }
  return normalized;
};

const invalidShape = (): never => {
  throw new AgentRuntimeError("invalid_configuration", "Builder task envelope shape is invalid.");
};

const stringArray = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string") ? value : invalidShape();

const decodeEnvelope = (value: unknown): BuilderTaskEnvelope => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalidShape();
  const input = value as Record<string, unknown>;
  const task = input.task;
  const scope = input.scope;
  const completionOutput = input.completionOutput;
  if (
    task === null ||
    typeof task !== "object" ||
    Array.isArray(task) ||
    scope === null ||
    typeof scope !== "object" ||
    Array.isArray(scope) ||
    completionOutput === null ||
    typeof completionOutput !== "object" ||
    Array.isArray(completionOutput)
  )
    return invalidShape();
  const taskRecord = task as Record<string, unknown>;
  const scopeRecord = scope as Record<string, unknown>;
  const completionRecord = completionOutput as Record<string, unknown>;
  const textFields = [
    "workItemId",
    "workflowRunId",
    "agentRunId",
    "projectId",
    "objective",
    "worktreePathReference",
    "validationCheckId",
  ];
  if (
    input.version !== 1 ||
    input.role !== "single-builder" ||
    textFields.some((key) => typeof input[key] !== "string") ||
    typeof taskRecord.title !== "string" ||
    typeof taskRecord.description !== "string" ||
    typeof input.maximumRuntimeSeconds !== "number" ||
    input.cancellationPolicy !== "interrupt_then_kill" ||
    completionRecord.structuredResultRequired !== true
  )
    return invalidShape();
  return {
    version: 1,
    role: "single-builder",
    workItemId: input.workItemId as string,
    workflowRunId: input.workflowRunId as string,
    agentRunId: input.agentRunId as string,
    projectId: input.projectId as string,
    objective: input.objective as string,
    task: { title: taskRecord.title, description: taskRecord.description },
    acceptanceCriteria: stringArray(input.acceptanceCriteria),
    scope: {
      allowedPaths: stringArray(scopeRecord.allowedPaths),
      forbiddenPaths: stringArray(scopeRecord.forbiddenPaths),
    },
    worktreePathReference: input.worktreePathReference as string,
    contextFileReferences: stringArray(input.contextFileReferences),
    ...(typeof input.implementationPlanArtifactReference === "string"
      ? { implementationPlanArtifactReference: input.implementationPlanArtifactReference }
      : input.implementationPlanArtifactReference === undefined
        ? {}
        : invalidShape()),
    validationCheckId: input.validationCheckId as string,
    maximumRuntimeSeconds: input.maximumRuntimeSeconds,
    cancellationPolicy: "interrupt_then_kill",
    completionOutput: { structuredResultRequired: true },
  };
};

export const validateBuilderTaskEnvelope = (value: unknown): BuilderTaskEnvelope => {
  const input = decodeEnvelope(value);
  if (input.version !== 1 || input.role !== "single-builder") {
    throw new AgentRuntimeError(
      "invalid_configuration",
      "Builder task version or role is unsupported.",
    );
  }
  for (const [name, value] of [
    ["Work-item ID", input.workItemId],
    ["Workflow-run ID", input.workflowRunId],
    ["Agent-run ID", input.agentRunId],
    ["Project ID", input.projectId],
    ["Objective", input.objective],
    ["Task title", input.task.title],
    ["Task description", input.task.description],
    ["Validation check ID", input.validationCheckId],
  ] as const) {
    assertText(value, name);
  }
  if (!IDENTIFIER.test(input.projectId)) {
    throw new AgentRuntimeError("invalid_configuration", "Project ID is invalid.");
  }
  if (
    input.acceptanceCriteria.length === 0 ||
    input.acceptanceCriteria.some((item) => item.trim().length === 0)
  ) {
    throw new AgentRuntimeError(
      "invalid_configuration",
      "At least one acceptance criterion is required.",
    );
  }
  if (input.scope.allowedPaths.length === 0) {
    throw new AgentRuntimeError("invalid_configuration", "At least one allowed path is required.");
  }
  const allowedPaths = input.scope.allowedPaths.map(validateScopePattern);
  const forbiddenPaths = [...DEFAULT_FORBIDDEN_PATHS, ...input.scope.forbiddenPaths]
    .map(validateScopePattern)
    .filter((value, index, values) => values.indexOf(value) === index);
  if (
    allowedPaths.some((allowed) =>
      forbiddenPaths.some((forbidden) => patternsOverlap(allowed, forbidden)),
    )
  ) {
    throw new AgentRuntimeError(
      "invalid_configuration",
      "Allowed and forbidden path scopes must not overlap.",
    );
  }
  if (
    !Number.isSafeInteger(input.maximumRuntimeSeconds) ||
    input.maximumRuntimeSeconds < 1 ||
    input.maximumRuntimeSeconds > MAXIMUM_RUNTIME_SECONDS
  ) {
    throw new AgentRuntimeError(
      "invalid_configuration",
      `Maximum runtime must be between 1 and ${MAXIMUM_RUNTIME_SECONDS} seconds.`,
    );
  }
  if (!NodePath.isAbsolute(input.worktreePathReference)) {
    throw new AgentRuntimeError(
      "invalid_configuration",
      "Worktree path reference must be absolute.",
    );
  }
  const contextFileReferences = input.contextFileReferences.map(validateScopePattern);
  return {
    ...input,
    objective: input.objective.trim(),
    task: { title: input.task.title.trim(), description: input.task.description.trim() },
    acceptanceCriteria: input.acceptanceCriteria.map((item) => item.trim()),
    scope: { allowedPaths, forbiddenPaths },
    contextFileReferences,
  };
};

type ScopeToken =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "segment_wildcard" }
  | { readonly kind: "recursive_wildcard" };

const compileScopePattern = (pattern: string): ReadonlyArray<ScopeToken> => {
  const result: Array<ScopeToken> = [];
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern[index] === "*" && pattern[index + 1] === "*") {
      result.push({ kind: "recursive_wildcard" });
      index += 1;
    } else if (pattern[index] === "*") result.push({ kind: "segment_wildcard" });
    else result.push({ kind: "literal", value: pattern[index]! });
  }
  return result;
};

const closeWildcardStates = (
  input: ReadonlySet<number>,
  tokens: ReadonlyArray<ScopeToken>,
): Set<number> => {
  const states = new Set(input);
  const pending = [...input];
  while (pending.length > 0) {
    const position = pending.pop()!;
    const token = tokens[position];
    const previousToken = tokens[position - 1];
    const nextToken = tokens[position + 1];
    if (
      token &&
      (token.kind === "segment_wildcard" || token.kind === "recursive_wildcard") &&
      !states.has(position + 1)
    ) {
      states.add(position + 1);
      pending.push(position + 1);
    }
    if (
      token?.kind === "recursive_wildcard" &&
      (position === 0 || (previousToken?.kind === "literal" && previousToken.value === "/")) &&
      nextToken?.kind === "literal" &&
      nextToken.value === "/" &&
      !states.has(position + 2)
    ) {
      states.add(position + 2);
      pending.push(position + 2);
    }
  }
  return states;
};

const advanceScopeStates = (
  input: ReadonlySet<number>,
  tokens: ReadonlyArray<ScopeToken>,
  character: string,
): Set<number> => {
  const next = new Set<number>();
  for (const position of closeWildcardStates(input, tokens)) {
    const token = tokens[position];
    if (!token) continue;
    if (token.kind === "literal" && token.value === character) next.add(position + 1);
    if (token.kind === "segment_wildcard" && character !== "/") next.add(position);
    if (token.kind === "recursive_wildcard") next.add(position);
  }
  return closeWildcardStates(next, tokens);
};

const scopeStateKey = (states: ReadonlySet<number>): string =>
  [...states].sort((a, b) => a - b).join(",");

const patternsOverlap = (left: string, right: string): boolean => {
  const leftTokens = compileScopePattern(left);
  const rightTokens = compileScopePattern(right);
  const alphabet = new Set<string>(["/", "\u0001"]);
  for (const token of [...leftTokens, ...rightTokens]) {
    if (token.kind === "literal") alphabet.add(token.value);
  }
  const initialLeft = closeWildcardStates(new Set([0]), leftTokens);
  const initialRight = closeWildcardStates(new Set([0]), rightTokens);
  const pending: Array<readonly [Set<number>, Set<number>]> = [[initialLeft, initialRight]];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const [leftStates, rightStates] = pending.pop()!;
    const key = `${scopeStateKey(leftStates)}|${scopeStateKey(rightStates)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (leftStates.has(leftTokens.length) && rightStates.has(rightTokens.length)) return true;
    // Fail closed on pathological inputs even though individual pattern size is already bounded.
    if (seen.size > 10_000) return true;
    for (const character of alphabet) {
      const nextLeft = advanceScopeStates(leftStates, leftTokens, character);
      const nextRight = advanceScopeStates(rightStates, rightTokens, character);
      if (nextLeft.size > 0 && nextRight.size > 0) pending.push([nextLeft, nextRight]);
    }
  }
  return false;
};

export const scopePatternMatches = (pattern: string, path: string): boolean => {
  const normalizedPattern = validateScopePattern(pattern);
  const normalizedPath = normalizeScopePath(path);
  const tokens = compileScopePattern(normalizedPattern);
  let states = closeWildcardStates(new Set([0]), tokens);
  for (const character of normalizedPath) {
    states = advanceScopeStates(states, tokens, character);
    if (states.size === 0) return false;
  }
  return closeWildcardStates(states, tokens).has(tokens.length);
};
