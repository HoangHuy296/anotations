# Implementation Plan: Autosave, Batch Navigation, and Dataset Export

**Branch**: `012-autosave-batch-export` | **Date**: 2026-07-21 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/012-autosave-batch-export/spec.md`

## Summary

Complete the existing image workspace's daily labeling loop before adding an export workflow. Phase 012.1 makes the existing revision-guarded annotation and description mutations reliably autosaved, flushes them before navigation, keeps conflict drafts recoverable, and makes Dataset-wide search, status filtering, batching, filtered navigation, and progress consistent. Phase 012.2 adds one metadata-only JSON export flow using the existing common PostgreSQL `Job`, the existing BullMQ `{ jobId }` delivery contract, the private worker, and a private MinIO artifact accessed only through an authorized short-lived download capability.

No new database model, migration, queue payload shape, public backend, or dependency is needed. The existing `Job` fields (`input`, status/progress counters, `summary`, `resultStorageKey`, `resultFilename`, and retry lineage) are sufficient. PostgreSQL remains the only Job authority; Redis/BullMQ remains transport only.

## Technical Context

**Language/Version**: TypeScript 5, Node.js 22, Next.js 16 App Router, React 19.

**Primary Dependencies**: Existing Prisma client, Zod, Zustand, React/Konva workspace components, MinIO client, BullMQ/ioredis through `@annotationplatform/queue`; no new package.

**Storage**: PostgreSQL/Prisma is canonical for Datasets, Assets, Labels, Annotations, `AuthSession`, and Job lifecycle/result metadata. MinIO stores only private source and export bytes. Redis/BullMQ transports only `{ jobId }`.

**Testing**: Existing Node built-in test runner with `tsx`, existing web workspace and job-queue suites, worker queue suites, and controlled Compose PostgreSQL/Redis/MinIO for HTTP/worker integration. Full queue integration remains opt-in and must use validated passworded loopback Redis with an isolated non-zero DB and key prefix.

**Target Platform**: Desktop-first authenticated browser workspace and private Compose worker; no public worker endpoint.

**Project Type**: pnpm monorepo web application with Next.js Route Handlers/Server Actions plus a private BullMQ worker.

**Performance Goals**: Show a save state immediately after an eligible edit; start autosave at 1.5 seconds idle; preserve batches of at most 100 Assets; let an authorized user observe a new export Job within 10 seconds in the healthy local runtime; keep workspace interactions responsive with 100 visible Assets and annotations.

**Constraints**:

- `Asset.modality` remains the workspace-engine selector and the shared workspace route remains the only workspace route.
- `Annotation.geometry` is canonical. Annotation edits use `Annotation.revision`; Asset-description edits use `Asset.revision`; stale updates are rejected and never force-written.
- Navigation must flush pending writes or stop safely with a recoverable draft; no local draft is silently discarded.
- Existing Dataset authorization is authoritative. A user outside a Dataset receives safe concealment and cannot cause storage, queue, Job, or metadata side effects.
- Queue payload remains exactly `{ jobId }`; raw Job input, export data, credentials, URLs, or binaries never enter Redis/BullMQ.
- Export bytes live only in private MinIO. Browser responses/manifests do not expose credentials, provider tokens, bucket names, private object keys/URLs, raw Job fields/events, or binary data.
- The private worker must claim the durable Job, use current lock-token lifecycle checks, honor cancellation, and write progress/result only to PostgreSQL.
- No raw SQL exception, schema change, migration, or new dependency is authorized for this phase.

**Scale/Scope**: One Dataset at a time; full-Dataset case-insensitive Asset-name search; 100 Assets per page; at least 250 Assets in batch tests; one JSON export format; Dataset/Asset/Label/Annotation metadata only.

## Constitution Check

The repository's Spec Kit constitution remains an uncustomized template. The effective gates are `AGENTS.md`, Phase 0 architecture documents, the Phase 004 permission matrix, and the Phase 007–009 Job contracts.

| Gate | Pre-design result | Post-design result |
| --- | --- | --- |
| PostgreSQL is canonical for metadata, revisions, and Job lifecycle | Pass: save mutations and all export state use durable records | Pass |
| MinIO owns binary objects and browser never receives credentials | Pass: export artifact stays private; only an authorized short-lived capability is returned | Pass |
| Redis/BullMQ is transport only | Pass: payload stays `{ jobId }`; UI status reads PostgreSQL safe projection | Pass |
| Shared workspace and `Asset.modality` engine selection | Pass: no modality route or future workspace engine | Pass |
| Canonical geometry and optimistic revision conflict safety | Pass: reuse guarded annotation/Asset mutations; add flush/conflict coordination only | Pass |
| Authorization, IDOR concealment, and denial no-side-effects | Pass: all list/save/export/download boundaries resolve actor plus Dataset permission | Pass |
| Worker claim-lock and cancellation safety | Pass: processor runs only after existing durable claim and acknowledges requested cancellation | Pass |
| No unapproved raw SQL, schema migration, or dependency | Pass | Pass |

## Research Decisions

See [research.md](./research.md). All initial technical choices are resolved; no `NEEDS CLARIFICATION` remains.

## Project Structure

### Documentation (this feature)

```text
specs/012-autosave-batch-export/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── autosave-workspace.md
│   ├── export-api.md
│   └── export-manifest.md
└── tasks.md                         # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
apps/web/src/
├── app/(app)/workspace/[datasetId]/
│   ├── page.tsx                     # Authorized query/search/filter/batch boundary
│   └── actions.ts                   # Existing revision-guarded workspace writes
├── app/api/
│   ├── export/route.ts              # New authorized durable export creation boundary
│   └── export/[jobId]/route.ts      # New safe export status/download boundary
├── components/workspace/
│   ├── dataset-sidebar.tsx
│   ├── properties-panel.tsx
│   ├── workspace-header.tsx
│   └── save-conflict-panel.tsx
├── lib/
│   ├── workspace/                   # Read models and guarded image mutations
│   ├── exports/                     # Server-only export authorization/download helpers
│   ├── jobs/                        # Existing safe Job projection and enqueue helpers
│   └── validation/                  # Zod query/export DTOs
└── stores/annotation-store.ts       # Ephemeral timers, save states, and flush coordination

apps/worker/src/
├── jobs/
│   ├── export-dataset.ts            # New private metadata-only export processor
│   ├── job-claim-lock.ts            # Existing lock-token lifecycle helpers
│   └── job-event-writer.ts          # Existing safe durable event writer
├── providers/minio.ts               # Existing private MinIO client
└── queue/queue-router.ts            # Add EXPORT_DATASET routing after durable claim

apps/web/tests/
├── workspace/                       # Autosave, conflicts, search/filter/batch/navigation tests
└── job-queue/                       # HTTP export authorization/status/redaction tests

apps/worker/tests/queue/             # Export claim/cancel/retry/manifest/MinIO tests
```

**Structure Decision**: Extend the existing shared workspace, Zod validation, authorization, safe Job DTO, enqueue factory, MinIO provider, and private queue router. Keep timers, local drafts, viewport, and selected-asset state in the client store; keep all durable writes, authorization, Job creation, export generation, storage access, and capabilities server-side. Do not add an ExportJob table, a public worker API, an alternate queue client in `apps/web`, or a modality-specific workspace route.

## Implementation Sequence

### Phase 012.1 — Autosave, Asset Search, Filters, and Batch Navigation

1. Audit and lock the existing workspace read/mutation contracts: Annotation `revision`, Asset `revision`, safe Asset list DTO, allowed statuses, and current Dataset permission outcomes. Add contract tests for stale, unauthorized, deleted, and missing-resource no-side-effect behavior before UI changes.
2. Extend the client save coordinator so each resource has one cancellable 1.5-second timer, truthful dirty/saving/saved/error/conflict state, and an awaited `flush` path. Wire every geometry, label, delete, and description action to a guarded server mutation at a semantic action boundary only.
3. Add safe navigation coordination: previous/next, selected asset, pagination, filter/search change, and route change must await a flush; failed/conflicted saves preserve the draft and block destructive navigation until an explicit resolution.
4. Make `readImageWorkspacePage` and workspace query handling a single authorization-scoped source for case-insensitive filename search, status filtering, stable batch ordering, capped 100-item pages, selected-asset reconciliation, and Dataset progress totals. Do not perform a separate unscoped Asset lookup for navigation.
5. Complete workspace UI feedback for Dataset progress, active search/filter/batch state, empty results, save state, and conflict choices. Keep search/filter/pagination in the right-side Asset management panel and retain the shared layout.
6. Run focused unit/integration/UI tests for debounce/flush, reload persistence, concurrent conflict, 250-Asset pagination, filtered previous/next, and permission/no-side-effect behavior.

### Phase 012.2 — Export through the Durable Job System

7. Define strict server-side export request, safe status/download, and manifest schemas. Support JSON only; allowlist the persisted input to Dataset identity plus a canonical format/version. Derive idempotency from server-validated Dataset/config context and return the existing durable Job for a repeated identical start request.
8. Implement `POST /api/export`: resolve current session actor, validate Zod input, require Dataset `job.createExport`, create/reconcile the common `EXPORT_DATASET` Job in PostgreSQL, enqueue through `@annotationplatform/queue` using exactly `{ jobId }`, and return only a safe Job DTO. On enqueue failure leave a recoverable queued Job and no false completion.
9. Implement `GET /api/export/[jobId]`: authorize Dataset-scoped Job read, project only the established safe status fields, and when completed create a short-lived authorized download capability from private artifact metadata. Never serialize `resultStorageKey`, bucket, raw input/state/result/errors/events, transport/lock fields, or provider config.
10. Add `EXPORT_DATASET` to the private router after the existing atomic claim. The processor loads the canonical Job, verifies active Dataset and cancellation state, reads all authorized Dataset/Asset/Label/Annotation metadata with stable ordering, produces a bounded JSON manifest, uploads a deterministic private artifact, and updates progress, safe summary, result metadata, events, and terminal status using existing lock-token helpers.
11. Make export recovery/retry/cancellation idempotent. A duplicate delivery for one Job reuses/reconciles its deterministic artifact. The existing successor-based retry contract must preserve only allowlisted export context; it must not copy raw `Job.input` or create duplicate output for the same successor Job.
12. Add controlled Compose integration tests for create/enqueue/worker receipt/claim/progress/cancel/retry, private MinIO artifact existence, authorized status/download, manifest contents, redaction, and all authorization/no-side-effect paths. Run full typecheck/lint/build and record a non-secret validation result.

## Complexity Tracking

No constitution violation or exceptional complexity is introduced.
