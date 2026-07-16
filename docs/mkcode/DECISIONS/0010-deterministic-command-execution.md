# ADR 0010: Deterministic command execution

- **Status:** Accepted

## Context

Validation cannot depend on an agent's claim of success, and accepting an
executable from a browser would bypass checked-in project policy. Active runs
already retain an immutable resolved project snapshot.

## Decision

The validating stage accepts only a check ID selected at workflow creation.
Factory code resolves that ID from the stored snapshot and invokes its
executable and ordered arguments directly with no shell. Migration 2 stores a
durable CommandRun and output metadata. Exit zero passes and advances to human
review; nonzero, timeout, spawn failure, or signal termination is an explicit
deterministic failure. Setup/check resolution is category-aware, although this
phase schedules only one validation check.

## Consequences

- API callers cannot inject executables or arguments.
- Active runs do not reread project registration or `.mkcode/project.yaml`.
- Project command failure is evidence, not an infrastructure retry or agent
  decision.
- A later worktree phase can replace the execution root without changing the
  command contract.

## Alternatives considered

- **Accept executable/args in the worker API:** rejected as a policy bypass.
- **Ask an agent to run and report validation:** rejected as nondeterministic.
- **Reread project configuration at launch:** rejected because active runs must
  not change silently.
