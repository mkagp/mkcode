# ADR 0015: Workspace reconciliation

- **Status:** Accepted

## Context

Git worktree creation and removal cannot occur inside the SQLite transaction
that records workflow intent. The worker can crash before a Git effect, after
the effect but before confirmation, or during cleanup. Blind retries can create
collisions or delete the wrong directory.

## Decision

Worker startup reconciles every nonterminal Workspace against Git and ownership
evidence before polling jobs. A pending record ensures an allocation job exists.
An allocating record is retried only when the path, metadata entry, and generated
branch are all absent. A worktree created before a crash is resumed only when
its private pre-allocation claim, path, Git metadata, branch, repository identity,
and base commit exactly match; the administrative marker is then finalized
before transactional confirmation. Any claim/path/metadata/branch/marker
ambiguity becomes operator attention. Ready or retained workspaces are observed
but never silently recreated. Cleanup retries only while ownership remains fully
proven; a confirmed absent cleanup target is recorded removed idempotently.

Reconciliation records observed HEAD, branch, dirty state, Git metadata state,
and a structured reason. It never fabricates successful allocation or cleanup.

## Consequences

- Restart after a committed Git effect can recover without duplicating a
  validation command.
- Missing, moved, replaced, detached, or marker-mismatched workspaces stop
  automated progress.
- Targeted operator repair remains necessary for ambiguous Git metadata.
- Broad `git worktree prune`, force reset, and directory deletion are excluded.

## Alternatives considered

- **Retry every incomplete allocation:** rejected because Git may already have
  created the branch or worktree.
- **Trust SQLite without inspecting Git:** rejected because external state can
  move independently.
- **Trust Git path/name only:** rejected because it cannot prove run ownership.
