# ADR 0008: Transactional job intents

- **Status:** Accepted

## Context

Committing a workflow transition and enqueueing its next work in separate steps
creates a crash window: state can advance without durable work, or work can be
duplicated without its state transition. An in-memory queue cannot close this
gap across process restarts.

## Decision

Every factory transition stores current state, its next `JobIntent`, workflow
events, and relevant idempotency receipt in one SQLite transaction. Claims use
an immediate transaction, expiring owner leases, and materialized Attempts.
Completion validates lease ownership and the expected stage version before
committing the next stage/job/events. Unique idempotency keys prevent duplicate
intents.

## Consequences

- A worker crash leaves either the complete transition or none of it.
- Expired claims can be reclaimed and audited as later attempts.
- Handlers must remain outside the transaction and report results through
  explicit completion/failure operations.
- Future irreversible integrations still need remote reconciliation keys.

## Alternatives considered

- **In-memory work queue:** rejected because work disappears on restart.
- **Write state then enqueue:** rejected because of the durable side-effect gap.
- **External queue now:** deferred; SQLite is sufficient for one worker and one
  host.
