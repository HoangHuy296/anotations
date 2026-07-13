# Tasks: Project Foundation and Docker Compose

**Input**: Design documents from `/specs/003-project-foundation-docker/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[provider configuration contract](./contracts/provider-configuration.md),
[readiness contract](./contracts/foundation-readiness.md), and
[quickstart.md](./quickstart.md)

**Tests**: Runtime validation is required by the specification: lint, typecheck,
Prisma generation, Compose configuration, provider readiness, three clean
starts, and secret-leak review. No schema migration test is generated because
Phase 1 must not modify the prepared schema or migrations.

**Organization**: Tasks are grouped by user story after shared workspace and
provider prerequisites. No task may implement repository cloning, a business
Job processor, imports, exports, or Phase 2 schema evolution.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel after its explicit dependencies are complete.
- **[Story]**: Maps a task to a Phase 1 user story.
- Every task names its exact target path.

## Phase 1: Setup — Workspace Migration and Safety Baseline

**Purpose**: Convert the existing single root application into the locked pnpm
workspace without losing the current web application or changing the prepared
Prisma schema.

- [X] T001 Record the source-to-target migration inventory and rollback checkpoints in `specs/003-project-foundation-docker/plan.md` before moving the current Next.js files.
- [X] T002 Replace placeholder workspace configuration with package globs and approved build settings in `pnpm-workspace.yaml`.
- [X] T003 Create root workspace scripts, package-manager metadata, and non-publishing settings in `package.json`.
- [X] T004 Move the existing Next.js source, public assets, and web configuration into `apps/web/` while preserving absolute imports and all current routes.
- [X] T005 Update web-local TypeScript, Tailwind, PostCSS, ESLint, and Next configuration paths in `apps/web/tsconfig.json`, `apps/web/postcss.config.mjs`, `apps/web/eslint.config.mjs`, and `apps/web/next.config.ts`.
- [X] T006 [P] Create the private worker package manifest and private-only entrypoint placeholder in `apps/worker/package.json` and `apps/worker/src/index.ts` without an HTTP listener or Job processor.
- [X] T007 [P] Create the shared domain package boundary in `packages/domain/package.json` and `packages/domain/src/index.ts` without credentials or provider clients.
- [X] T008 [P] Create the shared queue package boundary in `packages/queue/package.json` and `packages/queue/src/index.ts` without a Job processor.
- [X] T009 Update root ignore rules for workspace builds, generated output, Compose state, and local secrets in `.gitignore`.

**Checkpoint**: The workspace layout exists, the web application remains the
only browser-facing application, and `prisma/schema.prisma` plus migrations are
unchanged.

---

## Phase 2: Foundational — Real Provider and Configuration Prerequisites

**Purpose**: Add the real server/worker dependencies, validated server-only
configuration, queue payload contract, and safe container build prerequisites.

**⚠️ CRITICAL**: This phase blocks every user story. Obtain the explicit
dependency-install approval recorded in the plan before T010.

- [X] T010 Add approved server/worker dependencies BullMQ, ioredis, and the MinIO client to `package.json` and `pnpm-lock.yaml`; do not add them to browser-facing dependencies.
- [X] T011 Create package-specific dependency declarations for web, worker, domain, and queue in `apps/web/package.json`, `apps/worker/package.json`, `packages/domain/package.json`, and `packages/queue/package.json`.
- [X] T012 Create typed server-only provider configuration validation and redacted error helpers in `packages/domain/src/provider-config.ts` and export them from `packages/domain/src/index.ts`.
- [X] T013 Create the minimal typed `{ jobId: string }` payload, queue-name, and BullMQ-prefix contract in `packages/queue/src/job-contract.ts` and export it from `packages/queue/src/index.ts`.
- [X] T014 Create root environment documentation with names/placeholders only in `.env.example`; do not modify `.env` or `.env.local`.
- [X] T015 Create a secret-safe Docker build context policy in `.dockerignore`.
- [X] T016 Create shared provider readiness probes for PostgreSQL, MinIO, and Redis/BullMQ in `packages/domain/src/provider-readiness.ts`.

**Checkpoint**: Both process types can import the same validated configuration
and queue contract, all required configuration names are documented, and no
credential has been committed or exposed.

---

## Phase 3: User Story 1 — Start a Complete Local Foundation (Priority: P1) 🎯 MVP

**Goal**: Start Compose services `web`, `worker`, `postgres`, `minio`, and
`redis` against real local providers with health-gated startup.

**Independent Test**: Run Compose configuration validation, start the stack,
and verify all five service roles are healthy/ready without adding a public
worker port.

### Implementation for User Story 1

- [X] T017 [P] [US1] Create the web container build with the workspace-aware startup command in `apps/web/Dockerfile`.
- [X] T018 [P] [US1] Create the private worker container build with a process-only startup command in `apps/worker/Dockerfile`.
- [X] T019 [US1] Create Compose services, named volumes, internal networking, provider healthchecks, and `service_healthy` dependencies in `compose.yaml`.
- [X] T020 [US1] Add web Compose startup configuration and a safe readiness route shell in `apps/web/src/app/api/health/route.ts`.
- [X] T021 [US1] Add worker Compose startup/readiness logging shell in `apps/worker/src/readiness.ts and wire it through `apps/worker/src/index.ts` without registering a Job processor.
- [X] T022 [US1] Document the local stack start/stop and service inspection procedure in `README.md`.

**Checkpoint**: User Story 1 is independently testable: all five declared
services start, provider containers are healthy before app processes become
ready, and the worker has no HTTP listener.

---

## Phase 4: User Story 2 — Use Stable Private Provider Connections (Priority: P1)

**Goal**: Make web and worker validate and use private PostgreSQL, MinIO, and
Redis/BullMQ connections with safe readiness behavior.

**Independent Test**: Start web/worker with valid configuration, verify their
required providers are ready, then remove one required value and confirm only a
safe non-ready result/log is produced.

### Implementation for User Story 2

- [X] T023 [P] [US2] Implement server-only PostgreSQL and MinIO provider clients for the web application in `apps/web/src/lib/providers.ts`.
- [X] T024 [P] [US2] Implement private PostgreSQL, MinIO, and Redis/BullMQ provider clients for the worker in `apps/worker/src/providers/index.ts`.
- [X] T025 [US2] Implement bounded web readiness evaluation using the shared config/probes in `apps/web/src/lib/readiness.ts` and connect it to `apps/web/src/app/api/health/route.ts`.
- [X] T026 [US2] Implement worker configuration validation, bounded provider readiness, sanitized logs, and graceful shutdown in `apps/worker/src/config.ts`, `apps/worker/src/readiness.ts`, and `apps/worker/src/index.ts`.
- [X] T027 [US2] Configure BullMQ prefix and worker Redis retry behavior without ioredis `keyPrefix` in `apps/worker/src/providers/queue.ts` and `packages/queue/src/job-contract.ts`.
- [X] T028 [US2] Add safe startup/recovery and secret-nonexposure checks to `README.md` and `.env.example`.

**Checkpoint**: User Story 2 is independently testable: web and worker connect
to real providers, safe readiness behavior handles missing/unavailable values,
and no credential reaches the browser, logs, or queue payload.

---

## Phase 5: User Story 3 — Generate Database Client Consistently (Priority: P2)

**Goal**: Make workspace-root Prisma client generation deterministic while
keeping the prepared schema and migrations read-only.

**Independent Test**: Run the documented root generation command and verify it
creates the configured client output with no diff to `prisma/schema.prisma` or
`prisma/migrations/`.

### Implementation for User Story 3

- [X] T029 [US3] Update root database-generation and validation scripts to run from the workspace root in `package.json` while preserving `prisma.config.ts` paths.
- [X] T030 [US3] Add generated-client access boundaries for web and worker without changing schema output in `apps/web/src/lib/db.ts` and `apps/worker/src/providers/db.ts`.
- [X] T031 [US3] Document root-only Prisma generation, schema/migration immutability, and expected output location in `README.md`.
- [X] T032 [US3] Verify and record a no-diff schema/migration generation check in `specs/003-project-foundation-docker/quickstart.md`.

**Checkpoint**: User Story 3 is independently testable: generation succeeds,
the generated client can be reached by both private process boundaries, and
the prepared schema/migrations are unchanged.

---

## Phase 6: Polish and Cross-Cutting Validation

**Purpose**: Verify the implementation meets Phase 1 acceptance without
introducing any Phase 2 or product-workflow behavior.

- [X] T033 [P] Run lint and typecheck, resolve workspace import/configuration failures, and document results in `specs/003-project-foundation-docker/quickstart.md`.
- [X] T034 [P] Validate Compose syntax, image builds, service health, and internal-only worker exposure; document results in `specs/003-project-foundation-docker/quickstart.md`.
- [X] T035 Run three clean Compose startup/restart cycles and document provider readiness results in `specs/003-project-foundation-docker/quickstart.md`.
- [X] T036 Inspect browser output, readiness responses, queue payload contract, and normal logs for secret leakage; document results in `specs/003-project-foundation-docker/quickstart.md`.
- [X] T037 Confirm no changes exist in `prisma/schema.prisma` or `prisma/migrations/` and record Phase 1 completion, limitations, and next phase in `specs/003-project-foundation-docker/tasks.md`.

**Checkpoint**: Phase 1 is ready for approval. Stop here; do not begin Phase 2
schema changes, Job processing, repository cloning, imports, exports, or
annotation features.

**Phase 1 completion — 2026-07-13**: Three worker and three private-web
restart cycles passed after Docker runtime recovery. Prisma generation left
`prisma/schema.prisma` and all migration SQL files unchanged. Stop here; the
next work requires explicit approval for the Job-processing phase.

---

## Dependencies & Execution Order

### Phase Dependencies

```text
Phase 1 workspace migration
  → Phase 2 provider/configuration foundation
    → Phase 3 US1 Compose foundation (MVP)
      → Phase 4 US2 provider readiness
        → Phase 5 US3 Prisma generation
          → Phase 6 validation and approval gate
```

- **Phase 1**: Starts with inventory; T004 must preserve all existing web
  files before dependent application work begins.
- **Phase 2**: Depends on workspace package manifests. T010 requires explicit
  dependency-install approval and blocks all provider implementation.
- **US1**: Depends on Phase 2 because Compose images require package manifests,
  safe environment documentation, and shared readiness contracts.
- **US2**: Depends on US1's running topology and readiness route/worker shell.
- **US3**: Depends on root scripts and workspace layout; it may be prepared
  after Phase 2 but must be validated after US2 provider connectivity.
- **Phase 6**: Depends on all user stories.

### User Story Dependencies

- **US1 (P1)**: Delivers the runnable five-service MVP after the foundational
  workspace/provider setup.
- **US2 (P1)**: Builds on US1's Compose topology to establish secure, stable
  provider connections.
- **US3 (P2)**: Uses the same root foundation and must not modify schema or
  migrations; its final validation follows US2.

### Parallel Opportunities

- T006–T008 may run in parallel after the root workspace configuration exists.
- T012–T016 may run in parallel after dependencies and package manifests are
  ready, except for shared-file export reconciliation.
- T017 and T018 may run in parallel because they target different Dockerfiles.
- T023 and T024 may run in parallel because web and worker provider clients are
  in distinct files.
- T033 and T034 may run in parallel after all user-story implementation is
  complete.

## Parallel Example: User Story 2

```text
Task: "Implement web provider clients in apps/web/src/lib/providers.ts"
Task: "Implement worker provider clients in apps/worker/src/providers/index.ts"
```

Then complete web readiness, worker readiness, queue configuration, and the
secret-safety documentation in their dependency order.

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete workspace migration and provider/configuration foundation.
2. Complete T017–T022 to build and start the five Compose services.
3. Validate health-gated startup, service readiness, and no public worker port.
4. Stop for review before adding provider client behavior.

### Incremental Delivery

1. Add a reversible workspace migration and real dependency foundation.
2. Deliver US1 Compose topology and validate it independently.
3. Add US2 provider connections, safe readiness, and secret controls.
4. Add US3 Prisma generation boundaries without schema changes.
5. Run cross-cutting validation, report Phase 1, and stop for Phase 2 approval.

## Notes

- All tasks follow the required checkbox, sequential ID, optional parallel
  marker, user-story label, and exact-path format.
- Dependency installation is intentionally a blocking task because BullMQ,
  ioredis, and the MinIO client add server/worker runtime surface; they do not
  belong in a browser bundle.
- Phase 1 must report files created, files modified, commands to run,
  environment variables needed, database migration changes, known limitations,
  and the next recommended phase before awaiting approval.
