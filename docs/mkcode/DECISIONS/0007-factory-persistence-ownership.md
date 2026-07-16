# ADR 0007: Factory persistence ownership

- **Status:** Accepted

## Context

Interactive SQLite owns conversations, sessions, authentication, events, and
projections. Durable factory work has different migration, lease, retry,
approval, backup, and recovery lifecycles. Sharing the database would let the
browser server bypass the worker's state machine and make process ownership
ambiguous.

## Decision

`apps/factory-worker` exclusively opens and migrates
`<factory-state>/factory.sqlite` through `packages/workflow-engine`. The
existing server communicates only through the authenticated worker API and may
import factory contracts, but it must not depend on the workflow engine or
worker application. Interactive and factory migrations remain separate.

## Consequences

- The deployment runs two services and backs up two databases.
- The worker can restart or be disabled without corrupting interactive state.
- Cross-domain operations require explicit API/idempotency behavior.
- Some SQLite lifecycle code is duplicated instead of creating a premature
  shared persistence owner.

## Alternatives considered

- **Add factory tables to interactive SQLite:** rejected because ownership and
  failure domains would remain coupled.
- **Let the server open factory SQLite read-only:** rejected because it bypasses
  API compatibility and makes schema ownership porous.
- **Use a distributed database now:** deferred until multiple workers or HA is a
  committed requirement.
