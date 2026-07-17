# ADR 0013: Factory worktree ownership

- **Status:** Accepted

## Context

Deterministic commands previously used the registered repository path as their
execution root. That risks changing the operator's primary checkout and leaves
the factory without durable evidence for safe recovery or cleanup. Interactive
thread worktrees exist, but their lifecycle and persistence are not factory
workflow truth.

## Decision

Each new command-backed WorkflowRun owns at most one durable `git_worktree`
Workspace. The worker resolves the snapshotted base branch to an immutable commit
and persists that commit, generated branch, expected path, and ownership digest
before Git side effects. `GitWorktreeWorkspaceManager` creates the branch and
worktree from that exact commit under factory-owned state. Commands receive the
canonical worktree path; the registered primary checkout is never their
execution root.

Before `git worktree add`, the worker writes the same nonsecret ownership data
as a `0600` allocation claim under the private factory worktree root. The claim
path and digest are persisted before Git creation, so an interrupted allocation
can be resumed only when the claim, branch, path, Git identity, and base commit
all agree. After creation, the marker is finalized as `mkcode-workspace.json`
in Git's per-worktree administrative directory and the transient claim is
removed. It includes run/workspace/project/source/branch/base identities and a
random nonce.

## Consequences

- Primary-checkout branch, HEAD, index, and files remain independent from
  factory command side effects.
- Allocation is an external effect and therefore uses a durable allocation job
  plus a persisted intent/confirmation fence.
- Worktree directories use private factory state rather than a checked-in or
  browser-supplied machine path.
- Worktrees isolate changes but do not sandbox filesystem, network, or process
  authority.

## Alternatives considered

- **Run in the primary checkout:** rejected because concurrent and destructive
  effects cannot be isolated or safely attributed.
- **Reuse interactive worktree records:** rejected because interactive threads
  cannot become factory workflow truth.
- **Place a marker in the checked-out tree:** rejected because it appears as an
  ordinary untracked project change and may enter a commit.
