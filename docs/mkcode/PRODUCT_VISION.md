# Product vision

## What MK Code is

MK Code is an independently maintained, browser-based agentic development
platform derived from a fixed T3 Code baseline. It gives one trusted operator a
control plane for development across multiple local repositories, combining
human-directed coding conversations with restart-safe automated workflows.

Its first deployment target is a headless Linux Mini PC. One MK Code server and
one factory worker run as separate services. The browser reaches the server over
Tailscale; the worker remains loopback-only.

## Primary user and problem

Version one serves a single developer or technical operator who wants to:

- register repositories with different languages and toolchains;
- discuss work with Claude Code, Codex, OpenCode, or another runtime;
- turn a discussion or external task into structured implementation work;
- delegate bounded work without giving agents authority over process launch or
  validation policy;
- see deterministic lint, typecheck, test, and build outcomes;
- inspect attempts, artifacts, approvals, and raw processes;
- recover workflow progress after process or service restarts; and
- review work before any Git publication or merge.

## Interactive mode

Interactive mode is optimized for a person steering a coding session. The
existing project, thread, turn, message, provider-session, approval, checkpoint,
diff, terminal, and preview behavior remains in this domain. A user can select a
runtime or configured provider instance, discuss a possible change, inspect
results, and decide whether the discussion should become durable work.

Interactive state is not workflow state. A provider declaring a task complete,
a terminal becoming idle, or a thread reaching its last turn does not complete a
factory stage.

## Factory mode

Factory mode executes structured WorkItems through durable WorkflowRuns. It owns
stages, attempts, agent runs, deterministic commands, workspaces, retries,
approvals, artifacts, integration state, and event history. Controller code—not
an agent prompt—resolves definitions, validates delegation, launches processes,
runs configured commands, and advances workflow state.

The initial vertical slice deliberately remains narrow: manually create work,
allocate a worktree, launch one builder, run one deterministic lint command,
return failures to that builder once, and stop for human review.

## Entry points and lifecycle relationships

Work may enter manually from the browser, from an interactive conversation, or
later from Linear. These paths create or link to a WorkItem; they do not turn a
conversation or Linear issue into the workflow database.

One WorkItem may have multiple related conversations, specifications, workflow
runs, implementation attempts, and external issue links. Conversations and
WorkItems retain independent lifecycles. Active WorkflowRuns snapshot resolved
project, workflow, team, agent, and execution-profile definitions so later edits
cannot silently alter running work.

## Human review and Git publication

Human approval is a durable factory record. The operator can review the change,
validation evidence, independent review, artifacts, and raw terminal output.
Version one never merges or deploys automatically. GitHub draft pull-request
creation is a later integration and remains an explicit workflow action.

## System relationships

- **Application repositories** own checked-in `.mkcode/` configuration, project
  context, and deterministic setup/validation commands.
- **MK Code** owns definitions, execution policy, workflow state, retries,
  approvals, artifacts, and stage transitions.
- **Agent runtimes** execute model-driven work through replaceable adapters.
- **Herdr** may host and expose processes and PTYs, but does not own workflow
  state or outcomes.
- **Linear** may create or synchronize WorkItems, but is not the workflow store.
- **GitHub** may receive branches, commits, draft pull requests, and reviews, but
  does not determine internal stage completion.
- **Tailscale** provides private network reachability to the browser server.

## Version-one goals

- Browser-only first-class product experience.
- Multiple registered local repositories.
- Separate interactive and factory domains.
- One restart-safe factory worker and separate SQLite database.
- File-based, version-controlled project and registry definitions.
- At least one runtime adapter exercised through a provider-neutral contract.
- One deterministic, human-approved vertical workflow.
- Tailscale-only remote operation with local MK Code authentication.

## Explicit non-goals

- Full upstream T3 Code feature parity.
- Multi-tenant SaaS.
- Multiple concurrent factory workers or high availability.
- Automatic merge or production deployment.
- A general-purpose or arbitrary workflow language.
- A complete browser CRUD surface before schemas stabilize.
- Perfect support for every runtime in the first release.
- Desktop or mobile redistribution.
- Replacing deterministic validation with agent self-reporting.
- Making Herdr, Linear, GitHub, conversations, or terminals the source of
  workflow truth.
