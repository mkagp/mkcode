# ADR 0011: Local process host

- **Status:** Accepted

## Context

Deterministic commands need process startup, interruption, termination, and
status without binding workflow logic to Node child processes or future Herdr
APIs.

## Decision

`packages/command-runner` defines a narrow ProcessHost and implements only
LocalProcessHost. It uses direct spawn with `shell:false`; Linux children start
in a distinct process group so timeout/cancellation can interrupt and then kill
members that remain in that process group. Daemonized descendants or children
that create a new session are outside that guarantee. Durable records use a
generated process-host execution ID. Native PID is host-specific metadata and
is never sufficient proof after restart.

## Consequences

- Workflow persistence imports no child-process implementation.
- The local host can signal only executions in its in-memory ownership map,
  reducing PID-reuse risk.
- Starting/running commands found after restart become `operator_attention`
  rather than being blindly relaunched or signalled.
- Linux is verified; Windows process-tree and ACL semantics remain unsupported.

## Alternatives considered

- **Embed spawn in WorkflowEngine:** rejected because persistence would own OS
  side effects.
- **Use native PID as durable identity:** rejected because of reuse and reboot.
- **Implement Herdr now:** deferred behind the same port.
