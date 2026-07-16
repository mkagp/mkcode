# Security model

## Version-one trust boundary

Version one assumes one trusted operator, one Linux Mini PC, one MK Code server,
and one factory worker. It is not a multi-tenant isolation boundary. Agent input,
external issue content, repository content, and generated commands remain
untrusted even when the operator is trusted.

The MK Code server is exposed only through Tailscale and protected by MK Code
pairing/session authentication. The factory-worker API binds to loopback only
and authenticates every request from the server using a rotatable local secret
or equivalent service credential. The browser never connects directly to the
worker.

Herdr and browser terminal access must remain tailnet-only unless a stronger,
separately reviewed authentication and authorization model is implemented.

## Host and filesystem

- Run server and worker as separate systemd services, preferably under dedicated
  OS identities with only the filesystem permissions each needs.
- Restrict project registration and worktree allocation to configured roots.
- Mark workspace ownership durably before destructive cleanup.
- Reject symlink/path traversal that escapes approved roots.
- Use restrictive permissions for SQLite databases, event artifacts, logs,
  pairing secrets, runtime credentials, and integration tokens.
- Treat worktrees as change isolation, not security sandboxes. They share the
  host kernel, credentials, network, and any readable filesystem paths.
- Add container, namespace, or VM isolation only when threat requirements justify
  the operational cost; document the boundary accurately in the meantime.

## Commands and processes

- Represent commands as executable plus argument array.
- Resolve executables against an allow policy and reject forbidden paths or
  interpreters unless explicitly approved.
- Set working directory from an owned Workspace, not arbitrary task input.
- Apply timeout, cancellation, process-group termination, output limits, and
  orphan reconciliation.
- Distinguish exit code, terminating signal, timeout, cancellation, and host loss.
- Default network policy is project/profile controlled; sensitive workflows may
  require no network or an allowlist.
- Runtime processes and deterministic commands receive only required secret
  references and environment values.

The implemented deterministic runner (`packages/command-runner`) invokes the
snapshotted executable and argument array directly with `shell:false`. Its base
environment allowlist is `PATH`, `HOME`, `TMPDIR`, `TMP`, `TEMP`, `LANG`,
`LC_ALL`, and `LC_CTYPE`; declared environment references add only their target
names. `MKCODE_FACTORY_TOKEN` is neither inherited nor permitted as a declared
source. Resolved values are held in memory for launch and redaction only.

Working directories are relative to the snapshotted repository execution root,
checked lexically and by realpath, and checked again immediately before spawn.
This narrows but does not eliminate filesystem TOCTOU races. Commands run with
the factory worker's OS authority and network access; process groups and
worktrees are not sandboxes.

## Implemented project-configuration boundary

Local registration accepts an absolute repository path only through an
authenticated operate-scoped server RPC. The server canonicalizes it, verifies
an existing directory and Git marker, and reads only the fixed
`.mkcode/project.yaml` location. Checked-in configuration cannot nominate an
absolute repository root.

The parser rejects unknown keys, scalar command strings, empty executables,
invalid timeouts, traversal/absolute working and context paths, and symlink
escapes for existing paths. Environment entries are variable-name references;
the parser never reads the corresponding process environment. Registration
stores no resolved secret values and performs no command, Git, worktree, or
repository write operation.

On Linux, the server explicitly applies mode `0700` to each server-owned state
directory and mode `0600` to the project-registration store and its atomic-write
temporary file. Existing broader registration-file permissions are narrowed on
read or rewrite when the server can do so as the current owner. Linux directory
creation and permission correction traverse path components through pinned
`/proc/self/fd` descriptors, reject symbolic-link components, and stop before
creating descendants outside managed state. The helper never recursively
changes registered repositories or unrelated directories. This assumes procfs
is mounted and is host hardening, not a portable access-control abstraction;
non-Linux behavior has not received equivalent verification.

Artifact and worktree paths may not exist at validation time. The resolver
canonicalizes their deepest existing ancestor and rejects escapes and invalid
ancestor types, but a future command/workspace implementation must repeat
canonical parent/final-path checks at the moment of creation or use. Structured
commands can still explicitly name a shell or dangerous executable, so the
future runner must enforce executable, argument, network, credential, output,
and cancellation policy. The parser is not a security sandbox.

## Secrets and redaction

- Store secret values outside version-controlled project and registry files.
- Persist stable secret reference names, never resolved values.
- Redact configured environment variables and known token patterns before logs,
  events, artifacts, browser relay, and Herdr output are retained.
- Avoid passing secrets in command arguments because process listings and logs
  may expose them.
- Scope Claude, Codex, OpenCode, Linear, and GitHub credentials to the minimum
  filesystem, repository, organization, and API permissions required.
- Credential rotation must not require rewriting historic run snapshots.

Git credentials are particularly sensitive because a local agent can turn a
code-writing capability into a publication capability. Git push, pull-request
creation, merge, and deployment remain separately authorized workflow actions.

## Phase 1 telemetry policy

Product analytics is disabled unless the operator explicitly supplies
`T3CODE_TELEMETRY_ENABLED=true` and `T3CODE_POSTHOG_KEY`. The disabled path
returns a no-op service before loading the HTTP client or deriving telemetry
identity. It therefore does not read, hash, create, buffer, or transmit Codex,
Claude, or anonymous telemetry identifiers.

No upstream PostHog project key is embedded. The optional host defaults to the
standard PostHog ingestion host only after explicit enablement and key
configuration. Missing/invalid opt-in delivery configuration fails service
initialization closed to the same no-op service without falling back to inherited
credentials, deriving identity, sending data, or preventing server startup.
Local logs, traces, and explicitly configured OTLP observability are separate
from product analytics.

## Phase 1 repository automation policy

Only `.github/workflows/ci.yml` is active. It has read-only repository contents
permission, uses no production credentials, and performs validation only.
Inherited publishing, signing, deployment, EAS, release, Discord, and community
mutation workflows are stored under `.github/workflows-disabled/`, which GitHub
Actions does not load.

Moving a reference workflow back into the active directory requires an approved
MK Code destination, least-privilege credentials, explicit permissions,
rollback procedure, and owner authorization. A successful local run does not
authorize production credentials or external effects.

## Authentication and authorization

The existing server has useful local environment-auth and pairing behavior in
`apps/server/src/auth/EnvironmentAuth.ts` and
`apps/server/src/auth/EnvironmentAuthPolicy.ts:17`. This must be isolated from T3
Connect/Clerk rather than removed with it. Tailscale supplies network reachability,
not application authorization.

The worker API requires:

- loopback binding;
- mutual service identity or a rotatable shared credential;
- replay protection and idempotency keys on mutations;
- narrowly scoped endpoints for create, cancel, approve, query, and event replay;
- audit records for every accepted mutation; and
- no endpoint that accepts arbitrary process launch from browser input.

## Implemented factory-worker boundary

`apps/factory-worker/src/config.ts` binds to loopback by default and rejects a
non-loopback host unless `MKCODE_FACTORY_ALLOW_NON_LOOPBACK=true` is deliberately
set. Every route, including health, requires the separate
`MKCODE_FACTORY_TOKEN`; `api.ts` compares SHA-256 credential digests with
`timingSafeEqual` and emits only generic unauthorized responses. The client in
`apps/server/src/factoryWorkerClient.ts` keeps the credential private and never
serializes it for a browser.

Factory state is independent of interactive server state. The worker enforces
`0700` on its state directory and `0600` on the database and SQLite WAL/shared
memory files. On Linux, it walks state paths relative to validated directory
descriptors, uses `O_NOFOLLOW`, and opens SQLite through the already-validated
database descriptor. This closes writable-ancestor and final-component symlink
replacement windows during creation and chmod. The portable fallback still uses
snapshot path checks; Windows ACL and non-Linux pathname-race semantics require
a later deployment-hardening review.

The API accepts only schema-validated workflow metadata, immutable resolved
project snapshots, cancellation actors, approval decisions, and event queries.
Planning/implementation simulation handlers cannot launch a child process,
access a provider, create a worktree, or mutate project registration. The one
validating handler can invoke only the selected project check stored in the run
snapshot. Worker routes accept IDs, never executable/argument payloads.

Child output flows through a chunk-aware exact-value and token-pattern redactor
before restricted artifact writes. Each stream is capped at 1 MiB, continues
draining after truncation, records observed/persisted counts and SHA-256, and is
returned in authenticated pages capped at 64 KiB. This reduces accidental
secret retention but is not complete data-loss prevention.

## Integrations and Herdr

- Herdr process attachment can expose raw repository content, prompts, secrets,
  and command output. Access follows the same tailnet and session boundary as
  privileged terminal access.
- Linear tokens should use the narrowest workspace/team permissions practical;
  issue text is untrusted intake.
- GitHub tokens should initially be limited to the required repository and draft
  pull-request actions. Automatic merge is absent.
- Integration webhook payloads, if later introduced, require signature
  verification, replay protection, and durable inbox/idempotency records.

Herdr process IDs, terminal status, Linear status, and GitHub status are
observations or synchronization inputs. They do not replace factory persistence.

## Audit, backup, and recovery

- Persist workflow commands, state transitions, approvals, claims, retry
  decisions, integration mutations, and administrative actions with actor and
  correlation IDs.
- Keep event and artifact retention policies explicit and redact before storage.
- Back up interactive and factory SQLite databases separately using a
  SQLite-safe snapshot procedure; record schema version with backups.
- Test restoration onto a clean host and verify event/projection reconciliation.
- Monitor disk capacity for databases, worktrees, command output, build artifacts,
  and Herdr logs. Stop claiming new jobs before disk exhaustion corrupts active
  work.
- On cancellation, terminate the full process tree, persist final process result,
  revoke the lease, and move workspace cleanup to a recoverable job.
- On restart, reconcile active leases, hosted processes, workspace ownership, and
  incomplete outbox intents before accepting new work.

## Known limitations

The single-operator model reduces authorization complexity but does not make
model-driven processes safe. Local child processes can access anything allowed
to their OS identity. Worktrees do not prevent credential theft or network
exfiltration. These limitations must remain visible until stronger containment
is implemented and verified.

Persisted inherited identifiers remain another security-sensitive boundary.
Cookies, pairing URLs, schemes, IndexedDB names, DPoP keys, secrets, database
paths, and service environments cannot be renamed as display text. Follow
`COMPATIBILITY_INVENTORY.md`; authentication and credential identifiers require
overlap/revocation and rollback plans rather than blind replacement.
