# ADR 0019: Independent post-agent worktree policy enforcement

- **Status:** Accepted

## Context

Prompt instructions and runtime sandboxing cannot prove that an agent stayed
within its assignment. The primary checkout, factory ownership evidence, branch,
HEAD, Git configuration, and forbidden paths must remain protected before
deterministic validation is allowed to run.

## Decision

Capture durable Git evidence immediately before and after the AgentRun. Require
the same owned worktree, branch, HEAD, ownership digest, and Git-local config;
classify changed/untracked paths against versioned allowed/forbidden patterns;
and resolve every changed path through each existing parent component so a
symlink anywhere in the path cannot escape the worktree. If containment cannot
be proven, treat it as a violation. Any violation stops automatic progress,
retains the workspace, and routes the workflow to operator attention. No
automatic revert occurs.

## Consequences

Agent completion is distinct from policy acceptance and deterministic success.
The primary checkout is never the builder working directory. A legitimate but
out-of-scope edit also requires operator review. This narrows risk but does not
turn worktrees into security sandboxes or eliminate filesystem TOCTOU limits.

## Alternatives considered

- Trust the result envelope: rejected because it is self-reported evidence.
- Rely only on Codex sandbox mode: rejected because semantic path permissions
  and Git invariants still require independent verification.
- Automatically revert violations: rejected because it can destroy evidence.
