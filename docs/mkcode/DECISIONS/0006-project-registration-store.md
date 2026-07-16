# 0006: Server-owned project registration store

- **Status:** Accepted

## Context

MK Code needs durable machine-local mappings from stable project IDs to trusted
absolute repository paths before factory persistence exists. Interactive SQLite
owns threads, turns, authentication, and projections; `settings.json` is an
operator settings surface and includes browser-updatable concerns. The future
factory database must be owned exclusively by the separate worker.

## Decision

Use a versioned, server-owned `project-registrations.json` file under the derived
server state directory. `apps/server/src/projectRegistry.ts` is its sole owner
and replaces it atomically under an in-process write lock. Store validated,
browser-safe registration records and the latest resolved configuration
snapshot. Do not store workflow/run data or resolved secret values.

Keep project registration RPCs in the explicit `projectRegistry.*` namespace,
separate from inherited interactive `projects.*` workspace operations. A future
factory worker consumes project snapshots through a typed server/worker
boundary; it does not take ownership of this registration file implicitly.

## Consequences

- Registration is durable and reversible without a database migration.
- Interactive SQLite and future factory persistence retain clear ownership.
- Atomic replacement and a single-process lock are sufficient for the
  version-one single-server assumption, but this file is not a multi-writer
  store.
- A later move to another control-plane store requires an explicit migration of
  the new persisted identifier and fallback/rollback handling.
- Invalid revalidation can retain the last valid snapshot while exposing current
  structured errors.

## Alternatives considered

- **Interactive SQLite:** rejected because it would mix project-control-plane
  configuration with the interactive aggregate and complicate future ownership.
- **`settings.json`:** rejected because registration records have a separate
  lifecycle, contain canonical machine paths and snapshots, and should not be
  accepted as arbitrary browser settings patches.
- **A factory SQLite database now:** rejected because the factory worker and its
  exclusive persistence ownership are deliberately out of scope.
- **In-memory registration only:** rejected because project paths and validation
  state must survive server restart.
