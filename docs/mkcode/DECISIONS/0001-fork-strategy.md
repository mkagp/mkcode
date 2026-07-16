# ADR 0001: Fixed-fork strategy

- **Status:** Accepted

## Context

MK Code begins from T3 Code commit
`ecb35f75839925dd1ac6f854efeef5c9e291d11b`. The repository contains useful
browser, server, provider, persistence, Git, auth, and remote-access foundations,
along with desktop, mobile, hosted relay, marketing, and public distribution
surfaces that are not all part of MK Code's direction.

Tracking full upstream behavior would constrain MK Code's domain model, release
lifecycle, and product priorities. A blind rewrite would discard proven code and
operational safeguards.

## Decision

MK Code is independently maintained from a fixed T3 Code baseline. Full upstream
feature parity is not a goal. Upstream changes are evaluated individually and
ported only when they serve MK Code and fit its boundaries.

MK Code establishes its own architecture, terminology, roadmap, CI baseline, and
release lifecycle. New factory features enter through isolated applications and
packages instead of being embedded in browser components or the interactive
thread aggregate.

The root T3 Tools Inc. MIT notice and permission text remain intact. Applicable
third-party notices and embedded license text remain with retained code or
substantial copies.

## Consequences

- Divergence from upstream is expected and documented.
- Security/protocol fixes require deliberate upstream review rather than an
  assumption of automatic merging.
- T3 package names and persisted identifiers may remain temporarily for
  compatibility even after visible branding changes.
- Unsupported surfaces are isolated and frozen before removal.
- MK Code owns regressions, releases, deployment, and licensing review for its
  derived product.

## Alternatives considered

- **Continuously merge upstream:** lowers short-term update effort but preserves
  upstream product constraints and raises conflict risk as the factory diverges.
- **Rewrite from scratch:** gives clean naming but discards validated provider,
  connection, Git, auth, and persistence behavior and delays useful delivery.
- **Maintain a thin patch set:** unsuitable because the target process and domain
  boundaries intentionally differ from upstream.
