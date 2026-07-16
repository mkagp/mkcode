# ADR 0012: Command output and redaction

- **Status:** Accepted

## Context

Command output is durable review evidence but can be large and can contain
resolved environment secrets. Copying raw output into SQLite events would bloat
the workflow database and persist secrets before filtering.

## Decision

Stdout and stderr are redacted as streams before persistence and stored in
`0600` files beneath the factory-owned state directory. Exact resolved values,
the worker credential, and common token patterns are redacted with cross-chunk
carry. Each stream persists at most 1 MiB while continuing to drain, records
observed/persisted byte counts, truncation, and SHA-256, and is returned only
through authenticated pages capped at 64 KiB. SQLite stores references and
metadata, not output bodies.

## Consequences

- Raw resolved secrets are never intentionally written before redaction.
- Output survives worker restart without bloating the event log.
- Stdout/stderr ordering is preserved per stream, not as a total combined order.
- Pattern redaction reduces risk but is not complete data-loss prevention.

## Alternatives considered

- **Store raw then redact on read:** rejected because secrets would already be
  persisted.
- **Store all chunks in SQLite:** rejected for database growth and hot-write
  amplification.
- **Discard output after limits:** rejected; the runner continues draining and
  marks evidence explicitly truncated.
