# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `bun run sync:repos`; use `bun run sync:repos --repo <id>` to sync one
  configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.

## MK Code Transformation Guardrails

- This repository is becoming **MK Code**, an independently maintained product
  derived from the fixed T3 Code baseline at
  `ecb35f75839925dd1ac6f854efeef5c9e291d11b`. Full upstream feature parity is
  not a goal; evaluate upstream changes selectively against MK Code's needs.
- Inspect the current architecture, startup paths, package graph, imports, tests,
  and release consumers before making cross-cutting changes. Major deletions
  require concrete dependency and consumer evidence.
- Keep interactive sessions and automated factory workflows as separate domains.
  Interactive threads, turns, provider tasks, terminals, and process state are
  not authoritative workflow state.
- Keep workflow engine, persistence, runtime execution, deterministic commands,
  and integrations out of browser components. The browser consumes APIs and
  event contracts; it does not own workflow transitions.
- Prefer provider-neutral AgentDefinition, TeamDefinition, WorkflowDefinition,
  ExecutionProfile, AgentRuntime, and ProcessHost boundaries. Semantic roles
  must not embed providers or model names.
- Deterministic validation must execute project-declared commands and record
  process results. Agent prompts and self-reported success cannot replace lint,
  typecheck, test, build, or other controller-owned validation.
- Agents may request delegation, but deterministic factory code must validate
  policy and launch every agent instance. Agents must not directly create
  unregistered agents or arbitrary operating-system processes.
- Treat Herdr as a replaceable process-hosting and observability integration, not
  the workflow state store or source of retry, approval, validation, or work-item
  truth.
- Preserve the root T3 Tools Inc. MIT attribution and all applicable retained
  third-party notices. Rebranding must not erase license obligations.
- Treat display branding separately from persisted and protocol identifiers.
  Before changing `.t3`, `T3CODE_*`, database paths, storage keys, cookies, URL
  schemes, package names, IPC channels, or update channels, follow
  `docs/mkcode/COMPATIBILITY_INVENTORY.md` and provide an explicit migration,
  alias, fallback-read, compatibility-window, and rollback strategy as
  applicable.
- Do not commit, push, create pull requests, merge, publish packages, or deploy
  services unless the user explicitly directs that external action.
- Read `docs/mkcode/README.md` and the relevant current/target architecture and
  ADR documents before implementing MK Code transformation work.
