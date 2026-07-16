# ADR 0005: Herdr as a ProcessHost integration

- **Status:** Accepted

## Context

Herdr can provide persistent processes, PTYs, raw output, remote attachment,
manual intervention, and restoration metadata. These capabilities are valuable
for monitoring long-running agent sessions, but process state is not equivalent
to workflow state. Depending on Herdr for retries, approvals, or stage history
would make the factory unrecoverable when the integration is unavailable or its
terminal history is incomplete.

## Decision

Define a provider-neutral ProcessHost port for start, input, interrupt, stop,
status, and cursor-based output. Implement a local child-process host first. Add
Herdr later as `HerdrProcessHost` behind the same contract.

Factory persistence remains authoritative for workflow stages, retries,
approvals, validation, WorkItems, agent hierarchy, integration state, and event
history. Herdr identifiers and terminal/process status are observational
metadata used during reconciliation.

## Consequences

- Workflows can continue to reason about durable state during Herdr outages.
- Local hosting remains a fallback or initial implementation.
- Manual terminal intervention must be audited and may force reconciliation or
  revalidation.
- Output redaction and tailnet-only access are required because raw sessions may
  expose source and credentials.

## Alternatives considered

- **Make Herdr the workflow engine/store:** rejected because process hosting does
  not provide the required domain, transactional, and policy guarantees.
- **Integrate Herdr directly into every runtime adapter:** creates coupling and
  prevents local or future process hosts.
- **Do not expose raw processes:** simpler, but loses a central operational and
  intervention capability of MK Code.
