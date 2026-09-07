# Implementation Plan: Asset Browser & Dataset Management Workspace

**Branch**: `022-asset-browser-dataset-management-workspace` | **Date**: 2026-08-27 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/022-asset-browser-dataset-management-workspace/spec.md`

## Summary

Elevate the workspace's Assets tab from a filename-only, single-select Previous/Next list into a reusable Asset Browser capability (search, multi-filter, sort, selection, centralized bulk actions) plus a real Dataset Overview — entirely inside the existing Properties Panel / Properties Tabs / Workspace Toolbox surfaces, with zero changes to the annotation Canvas.

Technical approach: extend the existing server-rendered workspace query (`readWorkspacePage`) with sort/multi-filter support rather than replacing it with a client-fetch model, so Previous/Next and the URL-driven navigation pattern already in use are preserved unchanged; add a client-side selection store (Zustand, already a project dependency) that is independent of page navigation and holds either an explicit ID set or a `{datasetId, query}` filtered-selection descriptor; add one unified bulk-mutation endpoint that executes small operations synchronously and hands large ones to the existing PostgreSQL-Job → BullMQ → worker pipeline, following the Dataset Export precedent exactly; add a new `AssetLabel` join model for asset-level metadata tags (kept fully separate from `Annotation.labelId`); add a nullable `Asset.assignedToId` boundary field constrained to existing `DatasetMember`s; and populate the already-real `AudioAsset`/`TextAsset` fields into the currently placeholder-only Audio/Text details header.

## Technical Context

**Language/Version**: TypeScript, Next.js 15 App Router (`apps/web`), Node.js worker process (`apps/worker`)

**Primary Dependencies**: Prisma 6 (`@prisma/client`) against PostgreSQL, BullMQ against Redis, MinIO JS SDK, Zod, Zustand (already used for `dataset-labels-store`, `image-annotation-store`, `video-annotation-store`), react-konva (Canvas only — not touched by this feature)

**Storage**: PostgreSQL via Prisma (all domain/Job state); Redis via BullMQ (`{ jobId }`-only queue transport, never authoritative); MinIO (binaries, export artifacts)

**Testing**: Vitest (`apps/web/vitest.config.ts`, mirrored in `apps/worker`); OpenAPI contract tests at `apps/web/tests/openapi-contract` validated against `specs/api/openapi.yaml`

**Target Platform**: Linux server, Docker Compose stack (web, worker, postgres, redis, minio)

**Project Type**: Web application monorepo (pnpm workspaces) — `apps/web` (Next.js backend + frontend), `apps/worker` (background job processor), `packages/domain`, `packages/queue`

**Performance Goals**: Asset Browser list queries return a bounded page (≤10 assets/page, server-enforced) in normal interactive time regardless of dataset size; "select all filtered" never transfers the full matching set to the client

**Constraints**: Prisma only, no raw SQL; queue payload is `{ jobId }` only — no `Job.input` in Redis; no binary data in PostgreSQL; no synchronous MinIO deletion in a request path; server-enforced maximum page size and bulk-operation batch size; zero observable change to Canvas rendering, drawing interactions, pan/zoom, autosave, or optimistic locking; no new npm dependency (Zustand, Prisma, BullMQ, MinIO SDK, Zod all already present)

**Scale/Scope**: Datasets ranging from a handful to tens of thousands of assets; bulk operations from single-digit selections up to "select all filtered" spanning the entire dataset

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled Spec Kit template (no project-specific principles have been ratified into it). This project's actual binding governance is `/AGENTS.md` (incorporated by `/CLAUDE.md`). Gates below are evaluated against AGENTS.md.

| Gate (from AGENTS.md) | Status | Notes |
|---|---|---|
| Common PostgreSQL `Job` is the sole async source of truth; no `ImportJob`/`ExportJob`/parallel job tables | PASS | Plan adds `JobType` enum values only (`BULK_DELETE_ASSETS`, `BULK_EXPORT_SELECTED`); reuses the one `Job` table |
| Redis/BullMQ carries only `{ jobId }`, never `Job.input` | PASS | New job types funnel through the existing `enqueueExistingJob()` / `jobQueuePayloadSchema` path unchanged |
| No binary data in PostgreSQL | PASS | No binary fields introduced; MinIO remains the only binary store |
| Retries idempotent; duplicate delivery must not duplicate assets/artifacts | PASS | FR-019, FR-022–024, SC-004/SC-008 require idempotent bulk ops; design reuses `AssetLabel` unique constraint + existing Job retry/dedup pattern |
| `Dataset` is the central entity for imported/processed assets | PASS | No new competing container introduced |
| `Asset.modality` selects workspace engine; no workspace routes by modality | PASS | Asset Browser lives in the shared `AssetNavigator`/Properties Panel shell, not a new per-modality route |
| `Annotation.geometry` canonical; `Annotation.revision` required, rejects stale overwrites | PASS | Feature never writes `Annotation` rows (FR-014/015 explicitly asset-metadata-only) |
| Provider/MinIO credentials never reach the browser; only short-lived object-scoped presigned URLs | PASS | Export Selected reuses the existing `createAuthorizedExportDownload` presigned-URL pattern; no new credential surface |
| Prisma only, no raw SQL without approval | PASS | All new queries via Prisma Client |
| Absolute `@/...` imports, server logic out of UI, Zod validation, Route Handlers vs. Server Actions split | PASS (design intent) | To be enforced during implementation/code review |
| No new npm package without stated purpose/alternative/impact | PASS | No new package required — verified Zustand, Prisma, BullMQ, MinIO SDK, Zod already present |
| No workaround mock in place of a real earlier-phase dependency | PASS | Feature builds only on already-approved Phase 0–21 infrastructure (Job system, MinIO GC, DatasetMember) |
| Canvas rules: geometry in image coordinates, no continuous persistence during drag, commit only at action boundaries | PASS | Canvas untouched — FR-039 is a hard requirement, not an aspiration |
| Phase discipline: report before/after each phase, small independently-testable changes | PASS | Spec's 5 prioritized user stories map directly to independently shippable slices for `/speckit-tasks` |

No violations requiring justification. Complexity Tracking table below is not needed.

## Project Structure

### Documentation (this feature)

```text
specs/022-asset-browser-dataset-management-workspace/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md         # Phase 1 output
├── quickstart.md         # Phase 1 output
├── contracts/             # Phase 1 output
│   ├── assets-list.md
│   ├── assets-bulk.md
│   └── dataset-overview.md
└── tasks.md              # Phase 2 output (/speckit-tasks — not created here)
```

### Source Code (repository root)

```text
prisma/
└── schema.prisma                                  # + AssetLabel model, Asset.assignedToId, JobType/JobStage additions

apps/web/src/
├── app/
│   ├── api/
│   │   └── datasets/[datasetId]/
│   │       ├── assets/
│   │       │   ├── route.ts                        # existing cursor-list route — extended query surface, also used server-side by bulk resolver
│   │       │   └── bulk/route.ts                    # NEW — unified bulk-mutation endpoint
│   │       └── overview/route.ts                    # NEW (or inline in the page) — dataset overview data
│   └── (app)/
│       ├── datasets/[datasetId]/page.tsx            # extended: counts, modality summary, progress, health
│       └── workspace/[datasetId]/page.tsx            # extended query params passed to readWorkspacePage
├── components/workspace/
│   ├── asset-navigator.tsx                          # extended in place: checkboxes, select-visible/select-all-filtered, bulk-action bar
│   ├── image-properties-tabs.tsx                    # Assets tab wires in the new selection store
│   ├── video-properties-tabs.tsx                    # same
│   ├── placeholder-properties-tabs.tsx               # AUDIO/TEXT: real metadata fields populated; disabled sub-tabs untouched
│   └── dataset-sidebar.tsx                           # Toolbox: add "Export Selected" entry point
├── stores/
│   └── asset-selection-store.ts                     # NEW — Zustand store: query/selection/bulk-action state
├── lib/
│   ├── workspace/
│   │   ├── workspace-read.ts                         # extended query builder (sort, multi-status, label, date range)
│   │   └── workspace-assets.ts                       # shared query-builder extraction for reuse by bulk selection resolver
│   ├── assets/
│   │   ├── asset-bulk-service.ts                     # NEW — sync bulk ops (add/remove label, status, assign) + selection resolver
│   │   └── asset-label-service.ts                    # NEW — AssetLabel add/remove, idempotent
│   ├── datasets/
│   │   └── dataset-overview-service.ts               # NEW — counts, modality summary, progress, health signals
│   ├── validation/
│   │   ├── asset-list.ts                             # extended schema (sort, filters, date range)
│   │   └── asset-bulk.ts                              # NEW — bulk request schema, server-enforced max batch size
│   └── queue/enqueue-job.ts                           # unchanged funnel, reused by new job types
└── types/workspace.ts                                # extended selection/query types

apps/worker/src/
├── jobs/
│   ├── bulk-delete-assets.ts                          # NEW
│   └── bulk-export-selected.ts                        # NEW
└── queue/queue-router.ts                              # + 2 dispatch branches

packages/queue/src/job-contract.ts                     # + 2 entries in supportedQueueJobTypes

apps/web/tests/
├── dataset-metadata/assets.test.ts                     # extended: sort/filter coverage
├── assets-bulk/                                         # NEW — add/remove label, status, delete, export, idempotency, authZ
└── dataset-overview/                                    # NEW

apps/worker/tests/jobs/
├── bulk-delete-assets.test.ts                           # NEW
└── bulk-export-selected.test.ts                         # NEW

specs/api/openapi.yaml                                   # extended per contracts/*.md
```

**Structure Decision**: Single Next.js/worker monorepo, existing layout preserved. No new app, package, service, or route boundary is introduced — every new file lands inside `apps/web` (backend API + UI) or `apps/worker` (background jobs), matching the two-process architecture AGENTS.md requires. The Assets tab keeps its current server-rendered, URL-driven pagination model (extended with more query params) rather than switching to a client-fetch list; only *selection* state moves to a dedicated client store, since selection must survive page navigations that the existing pattern already does via URL search params.

## Complexity Tracking

*No Constitution Check violations — table intentionally omitted.*

## Post-Design Constitution Re-Check

Re-evaluated after Phase 1 (research.md, data-model.md, contracts/, quickstart.md): the concrete design — one `AssetLabel` model with a DB-level uniqueness invariant, one nullable `Asset.assignedToId` boundary field, two new `JobType` values funneled through the existing `{jobId}`-only enqueue path, one unified bulk endpoint, zero new npm packages, zero changes to Canvas/annotation files — introduces no gate violation beyond what the pre-design table already covered. No entries were added to Complexity Tracking.
