# ADR 0014: Workspace retention and cleanup

- **Status:** Accepted

## Context

Completed, rejected, cancelled, and human-review runs need inspectable workspace
evidence, while abandoned worktrees consume disk. A path alone cannot prove
factory ownership, and forced removal can destroy unrelated or valuable changes.

## Decision

Workspaces are retained while active, awaiting human review, rejected, failed,
or requiring operator attention. Approval and rejection do not remove them.
Successful terminal runs require an explicit authenticated cleanup request by
workflow/workspace ID and idempotency key. Cancellation schedules cleanup only
after running command work has settled.

Immediately before removal, the manager requires agreement among the durable
Workspace/run relationship, canonical source and worktree paths, Git common
directory and worktree metadata, generated branch, and administrative marker
digest. It invokes `git worktree remove` without force. Dirty, locked, detached,
missing-evidence, or mismatched worktrees are not deleted. The generated branch
is retained after worktree removal.

## Consequences

- Review and failure evidence remains available until an operator requests safe
  cleanup.
- Disk usage requires monitoring and a future retention policy.
- Cleanup cannot target an arbitrary browser path or branch.
- A dirty or ambiguously owned directory requires operator action instead of
  automated deletion.

## Alternatives considered

- **Always delete at terminal state:** rejected because it destroys review and
  diagnosis evidence.
- **Force-remove dirty worktrees:** rejected because factory ownership does not
  prove changes are disposable.
- **Delete the generated branch with the worktree:** deferred until branch
  publication/retention policy exists.
