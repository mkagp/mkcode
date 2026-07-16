import type { ResolvedProjectConfiguration } from "@mkcode/project-config";
import type { WorkflowCreateRequest } from "@mkcode/factory-contracts";

export const makeProjectSnapshot = (repositoryRoot: string): ResolvedProjectConfiguration => ({
  version: 1,
  project: {
    id: "factory-test-project",
    name: "Factory Test Project",
    description: "A resolved snapshot used only by durable workflow tests.",
  },
  repository: {
    baseBranch: "main",
    root: repositoryRoot,
    worktreeRoot: `${repositoryRoot}/.mkcode-worktrees`,
    contextFiles: [],
  },
  setup: [],
  checks: [],
  workflows: { allowed: ["feature"] },
  execution: { defaultProfile: "coding-workhorse" },
  sourcePath: `${repositoryRoot}/.mkcode/project.yaml`,
  contentDigest: "project-config-digest",
});

export const makeCreateRequest = (
  repositoryRoot: string,
  idempotencyKey = "create-test-workflow",
): WorkflowCreateRequest => ({
  idempotencyKey,
  workItem: {
    projectId: "factory-test-project",
    title: "Prove durable workflow state",
    description: "Run the deterministic simulation to human review.",
    source: "manual",
  },
  workflowType: "feature",
  requestedBy: "test-operator",
  projectSnapshot: makeProjectSnapshot(repositoryRoot),
});
