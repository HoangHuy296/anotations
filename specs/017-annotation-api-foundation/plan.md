# Implementation Plan: Annotation API Foundation

**Branch**: `017-annotation-api-foundation` | **Date**: 2026-07-29 | **Spec**: [spec.md](./spec.md)

## Summary

Add the first Asset-scoped, browser-facing annotation API so the shared
workspace can load durable annotations before rendering and atomically save a
validated change set. The API uses the existing opaque session, Dataset
authorization, Prisma `Annotation.revision` optimistic locking, and canonical
normalized `Annotation.geometry`. It remains synchronous metadata work: no
Job, BullMQ, worker, MinIO, or binary path is involved.

## Technical Context

**Language/Version**: TypeScript 5.9 on Node.js 22.  
**Primary Dependencies**: Existing Next.js App Router, Prisma 6, Zod 4, and
the generated Prisma client. No new dependency.  
**Storage**: PostgreSQL/Prisma for Annotation, Asset, Label, Dataset, and
membership metadata. No MinIO write and no Redis/BullMQ use.  
**Testing**: Node built-in test runner with `tsx`; existing authenticated
workspace/integration fixture helpers and controlled local PostgreSQL.  
**Target Platform**: Next.js public API and the shared workspace route.  
**Project Type**: pnpm monorepo web application with a separate private worker
that is not in this feature's execution path.  
**Performance Goals**: A normal Asset annotation list and single-Asset bulk
save complete without paging or background work; writes are bounded to one
Asset change set.  
**Constraints**: Opaque-cookie auth, Zod validation, concealed out-of-scope
resources, canonical normalized geometry, all-or-nothing mutation, revision
conflict detection, no schema migration, no raw SQL, no dependency, no queue
payload, and no browser credential/storage exposure.  
**Scale/Scope**: One Asset per request; reads support IMAGE, VIDEO, TEXT, and
AUDIO. Writes support IMAGE only, with strict bounding boxes, polygons,
circles, points, and polylines. Existing image Server Actions remain
compatibility adapters during the API transition. Autosave UI scheduling,
review status changes, segmentation, and other modality writes are out of
scope.

## Constitution Check

| Gate | Result |
| --- | --- |
| Public API/private worker boundary | Pass — only a Next.js Route Handler is added; the worker is untouched. |
| PostgreSQL canonical state | Pass — annotations and revisions are read and mutated through Prisma. |
| Queue transport `{ jobId }` only | Pass — this phase does not create a Job or contact BullMQ/Redis. |
| Private binary storage | Pass — geometry and metadata only; no binary is read or written. |
| Authorization and secrecy | Pass — session actor and Dataset/Asset guards are enforced server-side; safe DTOs only. |
| Canonical geometry/revision | Pass — `Annotation.geometry` and existing `Annotation.revision` remain authoritative. |
| Phase discipline | Pass — no canvas redesign, worker processing, migration, or dependency is planned. |

## Design Plan

### Phase 0 — lock the API semantics and validation boundary

1. Inventory the current `Annotation` schema, image workspace mutation helpers,
   `assertAnnotationPermission`, and current image Server Actions.
2. Establish one annotation API validation module with safe request/response
   DTOs and a discriminated canonical geometry schema.
3. Use `revision` as the only public concurrency field. Existing internal
   compatibility variables named `version` are not a reason to add a second
   schema column or public API field.
4. Read all modalities through the shared service. Limit writes to IMAGE and
   strictly validate normalized bounding boxes, polygons, circles, points, and
   polylines; segmentation and future types fail validation rather than being
   stored as loose JSON.

### Phase 1 — safe read contract

1. Add `GET /api/assets/[assetId]/annotations`.
2. Resolve the session actor first; resolve the Asset and Dataset through the
   existing read permission boundary; conceal foreign, unknown, malformed,
   archived, or deleted resources according to current policy.
3. Return a safe list DTO ordered deterministically by creation time and ID,
   including geometry, existing annotation-safe metadata, and `revision`.
4. Return `200` with `annotations: []` for an authorized Asset with no rows;
   never leak unrelated annotations, creator/session information, raw Prisma
   fields, or storage/source data.

### Phase 2 — atomic version-aware mutation

1. Add `PUT /api/assets/[assetId]/annotations` accepting a bounded change set:
   `creates`, `updates`, and `deletes`. Empty arrays are valid. Creates have a
   stable replay identity; updates may change geometry and/or explicitly
   reassign `labelId`.
2. Require each update/delete to include annotation ID and current `revision`.
   Creation obtains a server-derived actor, Dataset, Asset, modality, and
   default/manual metadata; clients cannot provide ownership or Dataset IDs.
3. Run validation, Asset/Dataset resolution, label membership checks, and
   per-annotation own/any permission selection before mutation. Annotations,
   Labels, and optional AssetVersions must belong to the exact Asset/Dataset.
4. Execute the whole change set in one Prisma transaction. Each existing-row
   mutation is revision-guarded; a zero-count guarded mutation becomes a
   stable `409 ANNOTATION_REVISION_CONFLICT` and rolls back all requested
   changes.
5. Geometry-only updates write only geometry, `updatedById`, timestamps, and
   the revision increment. They cannot update Label taxonomy metadata,
   annotation status/review metadata, or unrelated properties.
6. Return the current safe DTOs after success. No implicit deletion occurs;
   `deletes` is explicit and revision-guarded.

### Phase 3 — regression, authorization, and no-side-effect proof

1. Test normal opaque-cookie HTTP reads for empty, populated, owner/member,
   foreign, malformed, and cross-Dataset Assets.
2. Test creates, geometry-only updates, explicit deletion, label/Asset
   reference validation, and normalized geometry rejection.
3. Test simultaneous stale updates and a multi-item request containing one
   stale revision; prove the winner remains and the batch rolls back.
4. Test every rejection leaves Annotation rows unchanged and creates no Job,
   JobEvent, Redis/BullMQ entry, MinIO object, or credential-bearing response.
5. Retain existing image workspace action tests to prove the new API does not
   regress current canvas behavior.

### Phase 4 — workspace consumption and validation record

1. The server workspace read service is canonical and reads safe annotations
   before rendering. A browser GET adapter is only for refresh/polling and
   delegates to the same service.
2. Extend the IMAGE workspace's explicit action-boundary editing to the five
   supported shapes without changing the existing autosave delay or review
   workflow.
3. Run focused API/workspace tests plus Prisma validation/generate, web
   typecheck/lint/build, and `git diff --check`.
4. Record only actual, non-secret validation outcomes. Do not mark the phase
   complete until authenticated HTTP, conflict, and no-side-effect evidence is
   green.

## Project Structure

### Documentation

```text
specs/017-annotation-api-foundation/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── annotation-api.md
└── tasks.md                 # Created later by /speckit-tasks
```

### Source Code

```text
apps/web/src/
├── app/api/assets/[assetId]/annotations/
│   └── route.ts                         # New GET/PUT API boundary
├── lib/
│   ├── auth/                            # Existing opaque-session actor resolution
│   ├── authorization.ts                 # Existing Dataset/annotation permission guards
│   ├── validation/
│   │   └── annotation-api.ts            # New request, geometry, and safe DTO schemas
│   └── annotations/
│       ├── annotation-service.ts        # New Asset-scoped read/mutation orchestration
│       └── safe-annotation.ts           # New safe projection helpers
├── app/(app)/workspace/[datasetId]/
│   └── actions.ts                       # Existing action compatibility; no duplicate API logic
└── components/workspace/
    └── ...                              # Existing shell consumes the safe list adapter only

apps/web/tests/
├── annotation-api/
│   ├── annotation-routes.test.ts
│   ├── annotation-authorization.test.ts
│   └── annotation-conflicts.test.ts
└── workspace/
    └── annotation-*.test.ts             # Existing regression coverage
```

**Structure Decision**: Keep public HTTP behavior in the Next.js application,
business orchestration server-only under `lib/annotations`, and pure validation
under `lib/validation`. The private worker and queue packages are deliberately
outside this feature.

## Post-Design Constitution Check

Pass. The design uses the existing PostgreSQL-backed revision contract and
authorization matrix, keeps canonical geometry durable, adds no raw SQL or
schema change, and introduces neither binary handling nor queue/worker work.

## Complexity Tracking

No constitution violation requires justification.
