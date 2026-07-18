import type { BuilderTaskEnvelope } from "./contracts.ts";

export interface BuilderPromptInput {
  readonly task: BuilderTaskEnvelope;
  readonly projectContext: ReadonlyArray<{ readonly path: string; readonly content: string }>;
  readonly repositoryContext: {
    readonly branch: string;
    readonly baseCommit: string;
  };
  readonly runtimeAppendix?: string;
}

const FACTORY_RULES = `You are executing one bounded MK Code factory assignment.
The factory database, not this session, owns workflow state. Deterministic checks run after you exit.`;

const ROLE_RULES = `Role: single-builder.
- Work only in the supplied worktree.
- Do not commit, push, merge, switch branches, detach HEAD, or modify Git configuration.
- Do not modify files outside the allowed paths or inside any forbidden path.
- Do not weaken lint, tests, type safety, authentication, or authorization to make validation pass.
- Do not run or create native subagents.
- Do not alter .mkcode project configuration or factory ownership evidence.
- Do not claim deterministic checks passed; MK Code runs them independently.`;

export const composeBuilderPrompt = (input: BuilderPromptInput): string => {
  const context = input.projectContext
    .map((entry) => `--- ${entry.path} ---\n${entry.content}`)
    .join("\n\n");
  return [
    FACTORY_RULES,
    ROLE_RULES,
    `Immutable task envelope:\n${JSON.stringify(input.task, null, 2)}`,
    `Repository evidence:\n- branch: ${input.repositoryContext.branch}\n- base commit: ${input.repositoryContext.baseCommit}`,
    context.length > 0 ? `Project context:\n${context}` : "Project context: none supplied.",
    input.runtimeAppendix ?? "",
    "Return only the structured result requested by the runtime output schema.",
  ]
    .filter((part) => part.length > 0)
    .join("\n\n");
};
