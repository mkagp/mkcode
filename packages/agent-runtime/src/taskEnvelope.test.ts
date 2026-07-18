import * as NodeAssert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import type { BuilderTaskEnvelope } from "./contracts.ts";
import { composeBuilderPrompt } from "./prompt.ts";
import {
  scopePatternMatches,
  validateBuilderTaskEnvelope,
  validateScopePattern,
} from "./taskEnvelope.ts";

const task = (overrides: Partial<BuilderTaskEnvelope> = {}): BuilderTaskEnvelope => ({
  version: 1,
  role: "single-builder",
  workItemId: "work-1",
  workflowRunId: "run-1",
  agentRunId: "agent-1",
  projectId: "fixture-project",
  objective: "Add the bounded fixture change",
  task: { title: "Add status", description: "Create src/status.txt with the expected value." },
  acceptanceCriteria: ["src/status.txt contains ready"],
  scope: { allowedPaths: ["src/**"], forbiddenPaths: [] },
  worktreePathReference: "/tmp/factory/worktree",
  contextFileReferences: ["README.md"],
  validationCheckId: "verify",
  maximumRuntimeSeconds: 300,
  cancellationPolicy: "interrupt_then_kill",
  completionOutput: { structuredResultRequired: true },
  ...overrides,
});

describe("builder task envelope", () => {
  it("normalizes a bounded task and adds factory forbidden paths", () => {
    const result = validateBuilderTaskEnvelope(task());
    NodeAssert.deepEqual(result.scope.forbiddenPaths, [".git/**", ".mkcode/**"]);
  });

  it("rejects missing objectives and acceptance criteria", () => {
    NodeAssert.throws(() => validateBuilderTaskEnvelope(task({ objective: " " })), /Objective/u);
    NodeAssert.throws(
      () => validateBuilderTaskEnvelope(task({ acceptanceCriteria: [] })),
      /acceptance criterion/u,
    );
  });

  it("normalizes malformed persisted shapes into structured runtime errors", () => {
    NodeAssert.throws(
      () => validateBuilderTaskEnvelope({ version: 1, role: "single-builder" }),
      (cause) =>
        cause instanceof Error &&
        cause.name === "AgentRuntimeError" &&
        /shape is invalid/u.test(cause.message),
    );
    NodeAssert.throws(
      () =>
        validateBuilderTaskEnvelope({
          ...task(),
          cancellationPolicy: "ignore",
        }),
      /shape is invalid/u,
    );
  });

  it("rejects absolute and escaping path patterns", () => {
    NodeAssert.throws(() => validateScopePattern("../outside"), /project-relative/u);
    NodeAssert.throws(() => validateScopePattern("/tmp/outside"), /project-relative/u);
  });

  it("bounds scope pattern size and wildcard complexity", () => {
    NodeAssert.throws(() => validateScopePattern("a".repeat(513)), /project-relative/u);
    NodeAssert.throws(() => validateScopePattern("src/" + "*".repeat(33)), /project-relative/u);
  });

  it("rejects allowed paths that overlap protected paths", () => {
    NodeAssert.throws(
      () =>
        validateBuilderTaskEnvelope(
          task({ scope: { allowedPaths: [".mkcode/**"], forbiddenPaths: [] } }),
        ),
      /must not overlap/u,
    );
  });

  it("accepts disjoint wildcard scopes that share a directory prefix", () => {
    const result = validateBuilderTaskEnvelope(
      task({
        scope: { allowedPaths: ["src/*.ts"], forbiddenPaths: ["src/*.md"] },
      }),
    );
    NodeAssert.deepEqual(result.scope.allowedPaths, ["src/*.ts"]);
  });

  it("matches bounded glob patterns without matching sibling paths", () => {
    NodeAssert.equal(scopePatternMatches("src/**", "src/status.txt"), true);
    NodeAssert.equal(scopePatternMatches("src/*.ts", "src/status.ts"), true);
    NodeAssert.equal(scopePatternMatches("src/*.ts", "src/nested/status.ts"), false);
    NodeAssert.equal(scopePatternMatches("src/**", "tests/status.test.ts"), false);
    NodeAssert.equal(scopePatternMatches("src/?.ts", "src/a.ts"), false);
    NodeAssert.equal(scopePatternMatches("src/__DOUBLE_STAR__", "src/x"), false);
    NodeAssert.equal(scopePatternMatches("**/status.*", "src/nested/status.ts"), true);
    NodeAssert.equal(scopePatternMatches("**/*.ts", "index.ts"), true);
  });

  it("composes explicit prompt layers without runtime credentials", () => {
    const value = composeBuilderPrompt({
      task: task(),
      projectContext: [{ path: "README.md", content: "fixture context" }],
      repositoryContext: { branch: "mkcode/run-1", baseCommit: "a".repeat(40) },
      runtimeAppendix: "Codex runtime appendix.",
    });
    NodeAssert.match(value, /single-builder/u);
    NodeAssert.match(value, /Do not commit/u);
    NodeAssert.match(value, /fixture context/u);
    NodeAssert.match(value, /Codex runtime appendix/u);
    NodeAssert.doesNotMatch(value, /MKCODE_FACTORY_TOKEN/u);
  });
});
