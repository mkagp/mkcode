# ADR 0003: Separate factory-worker process and persistence

- **Status:** Accepted

## Context

The current server composes browser WebSocket handling, provider lifecycle,
interactive orchestration, SQLite, VCS, checkpoints, terminals, previews, auth,
cloud, and Tailscale (`apps/server/src/server.ts:159-355`). Several side-effect
reactors consume hot streams into in-memory queues, and provider callbacks may be
process-local. This is useful interactive behavior but cannot guarantee durable
long-running workflow execution.

## Decision

Factory execution runs in a separate `apps/factory-worker` process. It
exclusively opens, migrates, reads, and writes a separate factory SQLite
database. The browser server communicates through a narrow authenticated
loopback API and a cursor-based event feed. The browser server never opens the
factory database.

The worker atomically persists workflow transitions with JobIntents/outbox
records, claims jobs with expiring leases, uses idempotency records, and
reconciles state/processes after restart. The server remains the browser-facing
control plane and owner of existing interactive persistence.

## Consequences

- Process/API/schema compatibility becomes an explicit operational concern.
- The first deployment runs two services and two SQLite databases.
- Some persistence techniques may be duplicated instead of prematurely shared.
- Interactive chat can remain available when the worker is stopped.
- Scaling beyond one worker requires a later database/queue decision.

## Alternatives considered

- **Run workflows in WebSocket/request handlers:** rejected because request and
  browser lifetimes are not job lifetimes.
- **Add more in-process reactors:** does not solve the process-local failure gap
  or ownership concentration.
- **Use a distributed workflow service immediately:** deferred because version
  one has one trusted operator and one host.
