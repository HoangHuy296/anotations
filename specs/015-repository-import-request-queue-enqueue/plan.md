# Implementation Plan: Repository Import Request + Queue Enqueue

**Branch**: `015-repository-import-request-queue-enqueue` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

## Summary

Provide one authenticated repository-import acceptance flow: `/datasets/new`
performs a read-only Phase-014 preflight and then calls `POST
/api/datasets/from-repository`. The server repeats preflight, accepts a valid
request as one durable Dataset + `IMPORT_DATASET` Job boundary, commits it, and
only then delivers the exact BullMQ payload `{ jobId }`. The browser redirects
to `/datasets/[datasetId]/imports/[jobId]`, which renders only the safe
PostgreSQL Job projection.

The implementation must reuse the approved Phase-014 source-backed import
acceptance service; the new API route is a public contract adapter, not a
second Dataset/Job creation implementation. Repository clone, manifest
persistence, object transfer, Asset creation, and worker business processing
are deliberately excluded.

## Technical Context

**Language/Version**: TypeScript 5.9; Node.js 22; Next.js App Router 16.2.

**Primary Dependencies**: Next.js Route Handlers and Server Components, Zod 4,
Prisma 6, existing opaque-cookie authentication/authorization, existing
`@fieldframe/queue` package, BullMQ, existing Phase-014 provider-preflight
coordinator. No new dependency is planned.

**Storage**: PostgreSQL is canonical for `Dataset`, `Job`, and `JobEvent`.
Redis/BullMQ transports only `{ jobId }`. MinIO is not written in this phase.
Existing `SourceConnection` remains server-only and is referenced by ID only.

**Testing**: Node built-in test runner with `tsx`, existing authenticated HTTP
helpers, controlled Compose PostgreSQL/passworded Redis/MinIO/provider
fixtures, and queue assertions through the existing isolated queue test
namespace.

**Target Platform**: Public Next.js web application and its private worker
queue transport; no browser-to-provider, browser-to-Redis, or worker HTTP
endpoint.

**Project Type**: pnpm monorepo web application with browser UI, Route
Handlers, shared queue package, and private worker.

**Performance Goals**: A bounded valid acceptance reaches durable commit and
safe response without waiting for worker processing. A failed preflight writes
no state. The progress page does not poll Redis.

**Constraints**: Normal opaque-cookie actor lookup; strict Zod body; server
repeats read-only preflight before every write; private imports use an existing
active owned SourceConnection; no token/ciphertext in Job input or transport;
queue payload exactly `{ jobId }`; delivery is strictly post-commit; safe
responses conceal foreign resources.

**Scale/Scope**: One repository-import wizard, one request endpoint, one
Dataset-scoped progress page, and controlled acceptance/queue tests. Only the
approved GitHub/Gitea preflight capability is reused; worker import execution
is not part of Phase 015.

## Constitution Check

| Principle | Assessment |
| --- | --- |
| Architecture authority and boundaries | Pass. Next.js validates, authorizes, persists metadata, and requests enqueue. The private worker remains a consumer only; no public worker API or clone behavior is added. |
| Durable state and retry lineage | Conditional pass. PostgreSQL remains canonical and delivery remains `{ jobId }` post-commit. Exact duplicate-submit idempotency needs a durable uniqueness boundary; the current schema cannot enforce it before a Dataset exists. See the implementation gate below. |
| Canonical annotation/workspace state | Pass. No Annotation, geometry, revision, or workspace-engine behavior changes. |
| Private storage, security, and authorization | Pass. No binary/MinIO write occurs. Credentials remain in an existing server-only SourceConnection; safe Job/status DTOs exclude raw input and queue data. |
| Validation, testing, and phase discipline | Conditional pass. Zod, auth/ownership, no-side-effect, queue, redaction, and Compose runtime tests are specified. No migration/dependency/raw SQL is authorized by this plan itself. |

### Implementation gate: durable duplicate-submit idempotency

`Job` has `@@unique([datasetId, idempotencyKey])`, but Phase 015 creates the
Dataset as part of the request. The current schema has no actor-scoped
repository-request uniqueness key before that Dataset exists. A lookup by JSON
input, Dataset name, or `ExternalRepository` would not be an authoritative
concurrent idempotency guarantee and must not be used as a workaround.

Before implementation can mark FR-009 complete, the project owner must approve
one narrow schema-alignment migration, preferably an optional
`Dataset.repositoryImportIdempotencyKey` with a unique actor-scoped constraint
(`@@unique([ownerId, repositoryImportIdempotencyKey])`). The route must set it
only for this creation flow and re-read the existing accepted Dataset/Job on a
unique conflict. This is not a workflow-specific Job table and does not change
the common Job authority. If migration approval is withheld, Phase 015 must
exclude FR-009 and remain open rather than claiming duplicate-submit safety.

**Pre-design gate result**: CONDITIONAL — all architecture gates pass except
the explicitly documented missing durable idempotency constraint. Planning is
complete; implementation is blocked until that narrow migration is approved or
the acceptance criterion is amended by the owner.

## Research Decisions

See [research.md](./research.md). The only approval-dependent decision is the
durable idempotency constraint above; all other technical choices are resolved.

## Project Structure

### Documentation

```text
specs/015-repository-import-request-queue-enqueue/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── repository-import-request-api.md
    └── repository-import-progress-ui.md
```

### Source Code

```text
apps/web/src/
├── app/
│   ├── (app)/datasets/new/page.tsx
│   ├── (app)/datasets/[datasetId]/imports/[jobId]/page.tsx
│   └── api/
│       ├── datasets/from-repository/route.ts
│       └── jobs/[jobId]/route.ts                 # existing safe projection
├── components/datasets/
│   ├── repository-import-wizard.tsx
│   └── repository-import-progress.tsx
├── lib/
│   ├── source-import/preflight.ts                # existing read-only boundary
│   ├── queue/enqueue-job.ts                      # existing canonical accept/enqueue boundary
│   ├── jobs/safe-job-status.ts                   # existing safe status DTO
│   └── validation/repository-import-request.ts
└── tests/repository-import-request/
    ├── from-repository-route.test.ts
    ├── duplicate-submit.test.ts
    ├── progress-page.test.ts
    └── no-side-effects.test.ts

apps/worker/src/
└── queue/queue-router.ts                          # existing receipt only; no processor work added
```

**Structure Decision**: Preserve the existing monorepo boundaries. The new
Route Handler adapts the Phase-014/approved source-import service to the
Phase-015 browser contract; it must not duplicate transactional or queue
logic. UI components contain interaction and display only, while validation,
preflight, authorization, and durable acceptance stay server-only.

## Implementation Sequence

1. Audit the existing `createAndEnqueueNewDatasetSourceImportJob` boundary,
   safe Job projection, role/dataset authorization, and Phase-014 preflight
   contracts. Establish one reusable service input/output that has no token or
   browser-controlled ownership/storage/queue fields.
2. Resolve the idempotency gate: obtain migration approval, add the minimal
   actor-scoped persistent key and unique constraint, generate Prisma, and
   migrate only the approved local development database. Do not substitute
   non-unique application lookups.
3. Add strict `POST /api/datasets/from-repository` validation and normal
   opaque-cookie authorization. Re-run read-only preflight before the Prisma
   transaction, then delegate to the canonical acceptance service.
4. In the one acceptance transaction, create/reuse the authoritative
   idempotency result, Dataset, any necessary safe repository metadata, and
   one `QUEUED` `IMPORT_DATASET` Job. Persist only allowlisted repository
   identity/resolved revision/root/bounded preview summary and optional
   SourceConnection ID. Commit before calling `enqueueExistingJob`.
5. Implement `/datasets/new` wizard state: request preflight, show only safe
   result, submit the idempotency key, and navigate only after an accepted safe
   Dataset/Job response. Implement Dataset-scoped progress rendering from the
   existing safe PostgreSQL status endpoint; preserve concealment on direct
   foreign navigation.
6. Add unit/contract/HTTP tests for invalid URL/token/ref/root/visibility and
   foreign connection denials, successful public/private acceptance, exact
   queue payload, enqueue-unavailable recovery, duplicate submit, progress
   authorization, and response redaction/no side effects.
7. Run Prisma validation/generate (and the approved migration only after
   approval), targeted HTTP and queue tests, controlled Compose runtime tests,
   typecheck, lint, production build, and `git diff --check`. Record
   non-secret evidence before tasks are completed.

## Post-design Constitution Check

**Conditional pass.** The design keeps PostgreSQL as the sole durable source
of truth, enqueues only `{ jobId }` after commit, uses no MinIO or binary work,
and retains server-side SourceConnection ownership and redaction. The single
remaining gate is explicit migration approval for durable duplicate-submit
idempotency; no implementation may bypass it.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Narrow Dataset idempotency migration (approval required) | FR-009 requires a concurrent, durable actor-scoped deduplication key before a Dataset exists. | Checking Job input/JSON, Dataset name, or ExternalRepository in application code is not unique, race-safe, or scoped correctly. |
