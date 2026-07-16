# Disabled inherited GitHub Actions workflows

GitHub Actions loads workflow definitions only from `.github/workflows/`.
The files in this directory are retained as implementation and migration
references but cannot run as repository workflows from this location.

| Workflow                    | Classification                                | Why disabled for MK Code                                                                                                                              |
| --------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy-relay.yml`          | Upstream infrastructure deployment            | Deploys the T3 Connect production relay and requires Cloudflare, PlanetScale, Axiom, Clerk, and APNs credentials.                                     |
| `release.yml`               | Production publishing and public distribution | Publishes npm packages and GitHub releases, signs desktop artifacts, deploys T3-hosted Vercel channels, pushes release commits, and notifies Discord. |
| `mobile-eas-preview.yml`    | Public distribution                           | Builds or updates the inherited Expo application from pull-request activity.                                                                          |
| `mobile-eas-production.yml` | Production publishing                         | Builds, submits, or updates inherited mobile applications using T3-owned distribution identifiers.                                                    |
| `issue-labels.yml`          | Community automation                          | Mutates issue labels for the inherited public contribution process.                                                                                   |
| `pr-size.yml`               | Community automation                          | Mutates pull-request labels through `pull_request_target`.                                                                                            |
| `pr-vouch.yml`              | Community automation                          | Mutates pull requests/issues using inherited contributor-vouching policy.                                                                             |

The validation-only MK Code workflow remains at `.github/workflows/ci.yml`.
Release-smoke scripts and inherited workflow contents stay available for
reference; their presence does not authorize publishing or deployment.

Do not move a workflow back under `.github/workflows/` until MK Code has an
approved replacement lifecycle, credentials, destinations, permissions,
rollback procedure, and an explicit owner decision. Restoring an inherited file
unchanged is not an acceptable MK Code release design.
