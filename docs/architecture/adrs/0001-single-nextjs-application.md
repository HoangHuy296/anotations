# ADR 0001: Single Next.js Application and App Router

- Status: Accepted
- Date: 2026-06-23

## Context

The product needs a web UI, protected APIs, Gitea integration, persistence,
and exports. Separate services would add deployment and security boundaries
without a demonstrated scaling need. The installed framework is Next.js
16.2.9 and its bundled documentation is authoritative for implementation.

## Decision

Build one Next.js App Router application. Pages, Server Actions, and Route
Handlers live under `src/app`. Shared domain code lives under `src/lib`.
Phase 1 migrates the current root `app/` to `src/app/`; both roots must not
coexist afterward. No separate backend or second frontend is introduced.

## Consequences

Deployment and same-origin security remain simple. Teams must preserve strict
module boundaries inside one repository. Framework upgrades require reviewing
the relevant bundled Next.js documentation before code changes.
