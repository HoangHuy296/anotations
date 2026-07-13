# Implementation Plan: Architecture Lock — Phase 0

**Branch**: `001-architecture-lock` | **Date**: 2026-07-10 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification for the documentation-only Phase 0 architecture lock.

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Approve and document the architecture that will govern future implementation:
the application backend owns validation, metadata, and job submission;
PostgreSQL owns durable Job state; BullMQ/Redis transports only `jobId`; MinIO
stores private binary objects; and a private worker owns long-running work and
repository cloning. Phase 0 produces governance documents only. It does not
add infrastructure, dependencies, containers, schema changes, or executable
worker code.

## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: Documentation only; implementation language is not changed in Phase 0.

**Primary Dependencies**: No dependency changes. The approved future boundaries are Next.js backend API, Prisma, PostgreSQL, MinIO, Redis, BullMQ, and a private worker.

**Storage**: PostgreSQL is the source of truth for metadata and Job state; MinIO stores private binaries; Redis is queue transport only.

**Testing**: Documentation review against FR-001–FR-015, link/path checks, and review of the quickstart scenarios. No runtime test suite is added in Phase 0.

**Target Platform**: Containerized Linux deployment is planned for Phase 1; Phase 0 targets repository documentation only.

**Project Type**: Existing Next.js web application plus a planned private worker process; this is a single product repository, not a separate frontend or public backend.

**Performance Goals**: The request path returns after durable submission rather than waiting for cloning or processing; precise production targets are deferred to Phase 1 operational design.

**Constraints**: No secrets in browser state, logs, or public responses; no binary values in PostgreSQL; no full Job input in Redis; retries cannot create duplicate binary objects; no modality-specific workspace routes.

**Scale/Scope**: Phase 0 creates six architecture/governance documents and aligns `AGENTS.md`. It explicitly excludes all implementation artifacts required by Phase 1.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The existing constitution is an unfilled template, so it defines no enforceable
project principles. Until Phase 0 replaces it with approved governance, the
following gates derive from the feature specification and existing project
instructions:

- PASS — This plan is documentation-only; it creates no future-phase code,
  dependency, Docker, database, or migration artifact.
- PASS — It preserves secret safety and treats provider credentials as
  server-only.
- PASS — It makes PostgreSQL the Job authority, prohibits Redis from owning
  Job state, and keeps binary content out of PostgreSQL.
- PASS WITH REQUIRED DOCUMENT CHANGE — Existing `AGENTS.md` mandates a single
  Next.js application and local storage. Phase 0 must replace the conflicting
  architecture instructions with the approved worker/MinIO model before Phase
  1 begins. No implementation may start until that change is reviewed.
- PASS WITH DOCUMENTED LIMITATION — Spec Kit supplies no agent-context update
  script in `.specify/scripts/`; the Phase 0 task will update `AGENTS.md`
  directly as the repository's agent context.

**Post-design re-check**: PASS. The generated data model and contract are
conceptual only; they do not add schema, services, API routes, or runtime
dependencies.

## Repository Review at Phase 0 Start

| Existing location | Observed conflict | Phase 0 resolution |
| --- | --- | --- |
| `AGENTS.md` | Requires local storage and describes all backend work as residing in the request-serving Next.js application. | Replace these rules with the approved MinIO/private-worker boundary while keeping Next.js as the only public application API. |
| `docs/architecture/README.md` | Names local filesystem storage, direct Gitea import handling, and `ExportJob` as the target baseline. | Retain as historical context; point readers to `docs/architecture.md` as the Phase 0 lock. |
| `prisma/schema.prisma` | Contains `ExportJob` and has no common durable Job, Asset modality, or Annotation version model. | Do not alter it in Phase 0; document required future migration work only. |
| `src/lib/storage/local-storage.ts` | Implements local private cache storage. | Do not replace it in Phase 0; MinIO implementation belongs to Phase 1 or later. |
| `src/lib/dataset-import.ts` and `src/app/api/gitea/import/route.ts` | Existing request path owns import persistence and direct Gitea import flow. | Do not refactor in Phase 0; future work must move cloning/long-running work to the private worker. |

**Review conclusion**: The current implementation is intentionally not
rewritten. The new document set is the sole architecture authority for work
started after Phase 0 approval.

## Project Structure

### Documentation (this feature)

```text
specs/001-architecture-lock/
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
AGENTS.md
docs/
├── architecture.md                    # Phase 0 architecture lock
├── job-system.md                      # durable Job ownership and lifecycle
├── bullmq-postgres-job-flow.md        # submission, transport, retry flow
├── clone-repository-plan.md           # private worker cloning boundary
└── phases.md                          # ordered phase execution and handoff

specs/001-architecture-lock/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    └── architecture-governance.md
```

**Structure Decision**: Phase 0 changes only the listed governance documents.
The `docs/architecture/` baseline and ADRs remain historical context until the
new `docs/architecture.md` explicitly supersedes or links them. No application
source layout is created or reorganized in this phase.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Existing single-process rule conflicts with planned private worker | Long-running cloning and processing must not occupy the request-serving application boundary. | Performing this work in the request-serving application would violate FR-001 and make request lifecycle and retry ownership unsafe. |
