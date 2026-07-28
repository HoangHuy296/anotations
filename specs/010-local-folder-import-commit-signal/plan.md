# Implementation Plan: Local Folder Import and Commit Signal

**Branch**: `010-local-folder-import-commit-signal` | **Date**: 2026-07-17 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/010-local-folder-import-commit-signal/spec.md`

## Summary

Build end-to-end local folder import: durable preparation, browser preflight/direct transfer, item-to-Asset reconciliation, explicit commit, timeout recovery, safe progress UI, and private-worker processing. Follow Phase 009 rather than creating another public execution boundary.

## Technical Context

**Language/Version**: TypeScript on Node.js 22

**Primary Dependencies**: Existing Next.js, Prisma, Zod, MinIO capability, BullMQ transport, React; no new dependency planned

**Storage**: PostgreSQL metadata/Job authority; MinIO binary storage; Redis/BullMQ transport only

**Testing**: Node `tsx`, Prisma HTTP/integration tests, Compose MinIO/Redis tests, worker regressions

**Target Platform**: Browser, Next.js application, private Linux worker

**Project Type**: pnpm monorepo web application with private worker

**Performance Goals**: preflight/start 1,000 eligible files; durable visible progress within 10 seconds; no backend binary proxy

**Constraints**: queue `{ jobId }`; no binary in PostgreSQL; no path/credentials in browser/Job/queue; Asset modality canonical; no duplicate Asset/object on retry

**Scale/Scope**: additive PreparedImport/item schema; one Dataset import flow and worker processor

## Constitution Check

The checked-in constitution is a placeholder. `AGENTS.md`, Phase 0 architecture lock, and Phase 009 completion are binding.

| Gate | Pre-design | Plan response |
| --- | --- | --- |
| PostgreSQL Job authority | Pass | Preparation, totals, deadline, and outcomes are durable. |
| Queue transport only | Pass | Create then enqueue; only `{ jobId }` is delivered. |
| Private binary storage | Pass | Browser uses scoped capability; metadata only in database. |
| Safe browser boundary | Pass | No local path, credential, private key, or raw Job data in contracts. |
| Claim-lock safety | Pass | Worker reuses Phase 008 lifecycle mutations. |
| Idempotency | Pass | Preparation/item/Asset reconciliation and cleanup are durable. |

**Post-design re-check**: Pass. The additive import model introduces no separate Job authority or binary field.

## Project Structure

```text
specs/010-local-folder-import-commit-signal/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
└── contracts/
    ├── import-api.md
    └── import-ui.md

apps/web/src/
├── app/(app)/datasets/local-folder/
├── app/api/imports/
├── app/api/jobs/[jobId]/commit-import/
├── components/imports/
└── lib/imports/

apps/worker/src/jobs/
apps/worker/src/queue/
prisma/schema.prisma
prisma/migrations/
```

**Structure Decision**: Next.js owns browser APIs, validation, authorization, metadata, and enqueue. PostgreSQL owns preparation/Job state. MinIO owns bytes. The private worker owns long-running import lifecycle. Existing Phase 009 Job UI/status is reused.

## Implementation Approach

1. Add/migrate PreparedImport and item constraints without altering common Job authority.
2. Build authorization and idempotent preparation/start APIs before UI.
3. Reuse direct-upload capability for batch item completion and Asset child-row reconciliation.
4. Add approved `IMPORT_DATASET` queue mapping/worker processor while retaining `{ jobId }`, claim, heartbeat, cancellation, and recovery rules.
5. Build commit validation, timeout scanner, cleanup/compensation, and retry reconciliation.
6. Add folder preflight/upload/commit UI using safe durable progress only.
7. Verify authorization, duplicate, disconnect, MinIO, queue, worker, and no-side-effect behavior end-to-end.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --- | --- | --- |
| Additive PreparedImport/item model | Durable transfer ownership, expiry, and idempotency are required. | Browser-only state cannot safely handle disconnect/commit/retry. |
| `IMPORT_DATASET` private processor | It performs approved durable work after browser transfer. | A public processor would violate the worker boundary. |

## Implementation record (2026-07-17)

Implemented the additive durable preparation model, strict `IMPORT_DATASET`
queue delivery, server-side preparation/capability/item reconciliation and
commit endpoints, and the browser folder-picker flow. The worker only accepts
the durable delivery and leaves finalization to the authorized commit signal;
the PostgreSQL expiry scanner makes an uncommitted running import fail safely.
The remaining work is the full PostgreSQL/MinIO/Redis integration matrix and
the explicit orphan cleanup/retry UI validation recorded in `tasks.md`.
