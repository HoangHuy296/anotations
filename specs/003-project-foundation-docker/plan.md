# Implementation Plan: Project Foundation and Docker Compose

**Branch**: `003-project-foundation-docker` | **Date**: 2026-07-13 | **Spec**: [spec.md](./spec.md)

**Input**: Phase 1 specification and the accepted Phase 0 architecture lock.

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Establish a runnable pnpm workspace with a browser-facing Next.js application,
a private non-HTTP worker, and Compose-managed PostgreSQL, MinIO, and Redis.
Both processes validate server-only configuration and verify their provider
connections without exposing credentials. The foundation uses real providers,
preserves PostgreSQL as the Job authority, and does not change the prepared
Prisma schema or migrations.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: TypeScript 5, Node.js 20.9+ minimum, Next.js 16.2.9, React 19.2.4.

**Primary Dependencies**: Existing Next.js, Tailwind, shadcn-style primitives, Prisma 6.19.3, and Zod; add pnpm workspace configuration, BullMQ, ioredis, MinIO client, and Docker Compose runtime definitions in implementation.

**Storage**: PostgreSQL stores durable metadata and Job state; MinIO stores private binary objects; Redis supports BullMQ transport only; named Compose volumes preserve local provider data.

**Testing**: `pnpm lint`, `pnpm typecheck`, Prisma generation, Compose config validation, provider health/readiness checks, and three clean startup cycles. No schema migration is run or created in this phase.

**Target Platform**: Local Docker Compose on a supported Docker Desktop or Linux Docker Engine host; Node processes run in Linux containers.

**Project Type**: pnpm monorepo containing one public web application, one private worker process, and shared internal packages.

**Performance Goals**: All five services become ready within three minutes locally; web and worker reconnect successfully through three clean starts; readiness checks fail safely while a dependency is unavailable.

**Constraints**: Queue payloads remain `{ jobId }`; worker exposes no HTTP server; no provider credentials in clients/logs; no mock providers; no binary PostgreSQL storage; do not modify `prisma/schema.prisma` or migrations.

**Scale/Scope**: Migrate the current single root application into the locked workspace layout, add provider clients/readiness only, and defer Job processors, repository cloning, schema evolution, and product workflows.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution remains an unfilled template. The following Phase 0 documents
therefore act as binding governance: `AGENTS.md`, `docs/architecture.md`,
`docs/job-system.md`, `docs/bullmq-postgres-job-flow.md`, and `docs/phases.md`.

- PASS — One public Next.js application and one private worker preserve the
  locked product boundary; the worker is not a second public backend.
- PASS — PostgreSQL, MinIO, and Redis are real Compose services, not mocks.
- PASS — Provider clients use server-only configuration; no secret is included
  in a response, queue payload, or shared browser package.
- PASS — BullMQ carries only `{ jobId }`; Phase 1 does not add a Job processor
  or move durable Job state to Redis.
- PASS — Prisma generation uses the prepared schema and no migration/schema
  change is planned.
- REQUIRED BEFORE IMPLEMENTATION — Obtain explicit dependency-install approval
  for BullMQ, ioredis, and the MinIO client. They add server/worker runtime
  surface but no browser bundle dependency.
- REQUIRED BEFORE IMPLEMENTATION — Preserve the current source tree until a
  migration plan protects all existing UI files and imports; workspace movement
  must be atomic and validated by lint/typecheck.

**Post-design re-check**: PASS. The provider contract and data model add no
alternative authority or public worker interface. The missing agent-context
update script is recorded below; `AGENTS.md` is already the accepted Phase 0
agent context and is not changed by this plan.

## Project Structure

### Documentation (this feature)

```text
specs/003-project-foundation-docker/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
apps/
├── web/                              # existing Next.js UI and public API
│   ├── src/
│   ├── public/
│   ├── package.json
│   ├── next.config.ts
│   └── Dockerfile
└── worker/                           # private BullMQ process; no HTTP routes
    ├── src/
    │   ├── index.ts
    │   ├── config.ts
    │   ├── readiness.ts
    │   └── providers/
    ├── package.json
    └── Dockerfile

packages/
├── domain/                           # shared types and validated config contracts
│   ├── src/
│   └── package.json
└── queue/                            # queue name/payload and publisher contract
    ├── src/
    └── package.json

prisma/                               # prepared, read-only schema and migrations
lib/generated/prisma/                 # generated output already selected by schema
compose.yaml
pnpm-workspace.yaml
package.json                           # root scripts and workspace orchestration
```

**Structure Decision**: Move the existing Next.js application to `apps/web`
instead of creating a second frontend. Create `apps/worker` only as a private
process. The root retains Prisma configuration/schema and generated-client
output because the prepared schema already selects that output path. Shared
packages contain only contracts/configuration-safe code, never credentials or a
second database authority. The current `pnpm-workspace.yaml` is incomplete and
must be replaced with a valid workspace manifest during implementation.

## Migration Inventory and Rollback Checkpoints

| Existing root path | Phase 1 destination | Rollback checkpoint |
| --- | --- | --- |
| `src/`, `public/`, Next configuration, TypeScript configuration, and ESLint/PostCSS configuration | `apps/web/` | Preserve source paths as one atomic move before changing imports or dependency manifests. |
| `prisma/`, `prisma.config.ts`, `database-url.ts` | repository root | Never move or edit schema/migrations; validate generation after workspace scripts are established. |
| Root package manifest and workspace file | repository root | Validate pnpm workspace syntax before dependency installation. |
| Existing package lock | removed after pnpm workspace install succeeds | Retain `pnpm-lock.yaml` as the sole package-manager lockfile. |

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Private worker process alongside web application | Long-running provider work must not occupy browser request lifecycle. | Running worker logic in the web process conflicts with the accepted private-worker ownership boundary. |
| Internal shared packages | Both processes require identical validated configuration and minimal queue-payload contracts. | Duplicating contracts risks drift and secret-handling inconsistencies. |
