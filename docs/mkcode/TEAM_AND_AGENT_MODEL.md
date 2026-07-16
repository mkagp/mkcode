# Team and agent model

## Provider-neutral organization

```text
Orchestrator
├── Team Lead
│   ├── Worker
│   └── Worker
└── Team Lead
    └── Worker
```

An AgentDefinition describes responsibility, capabilities, task and result
schemas, and permission boundaries. An AgentRun is one concrete execution under
a resolved ExecutionProfile. TeamDefinition composes roles and delegation
limits; WorkflowDefinition decides when those roles act.

## Responsibilities

### Orchestrator

May understand the whole WorkItem, select or request an approved workflow,
divide work by domain, delegate to registered team-lead slots, resolve conflicts,
track acceptance criteria, request replanning, and escalate decisions.

Must not directly launch arbitrary operating-system processes, declare
deterministic validation successful, bypass workflow policy, merge or deploy,
or freely create unregistered agents.

### Team lead

May split domain work into bounded worker assignments, prevent overlapping path
ownership, review worker results, consolidate artifacts, and return unresolved
issues to the orchestrator. A team lead cannot exceed its delegation policy or
turn review into deterministic validation.

### Worker

Receives one narrow task envelope and returns one structured result. It may
request further delegation, but the factory validates the requested registered
agent, capabilities, depth, concurrency, permissions, and available workflow
slot before launching anything.

## Task envelope

Every worker assignment contains:

- objective and rationale;
- scoped repository/workspace identity;
- allowed and forbidden paths;
- acceptance criteria;
- input artifact references;
- expected result schema;
- permission boundary;
- time/resource budget;
- parent AgentRun and delegation depth; and
- idempotency key.

The result envelope contains disposition, summary, changed-path claims, produced
artifacts, unresolved issues, requested follow-up, and evidence references. It
does not contain an authoritative “validation passed” flag.

## Delegation and review policy

- Default maximum delegation depth: two levels below the orchestrator.
- Default maximum parallel AgentRuns: one in the first vertical slice; later
  project or workflow policy may increase it.
- Overlapping write scopes require controller rejection or explicit serialized
  ownership.
- Independent review uses an AgentDefinition and AgentRun distinct from the
  builder that produced the candidate change.
- Escalation becomes a durable event and may route to the orchestrator or human
  approval gate.
- Definition precedence is global definition, project override, workflow
  override, then permitted per-run override. The resolved result is snapshotted.

## Example reusable team

```yaml
apiVersion: mkcode.dev/v1alpha1
kind: TeamDefinition
metadata:
  name: feature-team
spec:
  orchestrator:
    agent: feature-orchestrator
  leads:
    - slot: implementation
      agent: implementation-lead
      workers:
        - slot: builder
          agent: bounded-builder
        - slot: reviewer
          agent: independent-reviewer
  policy:
    maxDelegationDepth: 2
    maxParallelAgentRuns: 2
    requireIndependentReview: true
```

This example intentionally contains no runtime, provider, or model.

## Example project override

```yaml
apiVersion: mkcode.dev/v1alpha1
kind: TeamOverride
metadata:
  team: feature-team
spec:
  slots:
    builder:
      allowedPaths:
        - apps/web/**
        - packages/contracts/**
      forbiddenPaths:
        - infra/**
    reviewer:
      requiredCapabilities:
        - typescript-review
  executionProfiles:
    builder: codex-local-standard
    reviewer: claude-local-review
```

The profile names demonstrate that runtime binding is a separate resolution
step; the AgentDefinitions and TeamDefinition remain provider-neutral.
