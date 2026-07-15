# Implementation Plan: Dataset, Label, and Asset Metadata Foundation

**Branch**: `005-dataset-label-asset-metadata-foundation` | **Date**: 2026-07-14 | **Spec**: [spec.md](./spec.md)

## Summary

Implement authorized Dataset CRUD/archive, dataset-scoped Label CRUD, and safe paginated Asset metadata browsing using the existing schema. Authorization is a blocking boundary, not a UI convention: every route resolves the active session actor, scopes the Dataset, checks the exact permission, then reads or mutates.

## Technical Context

**Language/Version**: TypeScript 5, existing Next.js App Router.  
**Dependencies**: Existing Prisma client, Zod, server-only authorization modules; no new package.  
**Storage**: Existing PostgreSQL Dataset, DatasetMember, Label, Asset records; no binary reads/writes.  
**Testing**: Existing Node/tsx test command with Prisma assertions; no raw SQL.  
**Constraints**: No schema/migration/generated-client edits; no owner id from client; no binary, storage key, provider token, encrypted connection, or private source URL in metadata responses.

## Constitution Check

| Gate | Result | Evidence |
| --- | --- | --- |
| Next.js owns public APIs | PASS | All requested operations are browser-facing route handlers. |
| PostgreSQL is authoritative | PASS | Dataset/label/asset metadata and ownership are resolved through Prisma. |
| Dataset authorization root | PASS | Every label/asset operation is scoped through an authorized Dataset. |
| No binary in PostgreSQL or response | PASS | Asset list exposes safe metadata only. |
| No unauthorized side effect | PASS | Permission check precedes create/update/archive/delete. |

## Authorization Design

1. Resolve actor from the active server session; absent/invalid session returns `401`.
2. For an existing Dataset id, call `requireDatasetPermission(actor, datasetId, permission)` before reading the target resource. `UserRole.ADMIN` is the only system-wide override; a global MANAGER remains scoped to owned/member Datasets.
3. A non-member or cross-dataset resource returns `404`; an entitled member lacking the action permission returns `403`.
4. Dataset create derives `ownerId` only from actor and permits only system ADMIN or MANAGER. Dataset update/archive require the Dataset permission boundary; no browser input can grant a role or ownership.
5. Labels are resolved by `labelId + datasetId`; create/update/delete requires `label.manage`.
6. Asset list requires `dataset.read` and applies all pagination/filter predicates inside that Dataset query.

## Project Structure

```text
apps/web/src/app/api/
├── datasets/route.ts
├── datasets/[datasetId]/route.ts
├── datasets/[datasetId]/labels/route.ts
├── datasets/[datasetId]/assets/route.ts
└── labels/[labelId]/route.ts
apps/web/src/lib/validation/
├── dataset.ts
├── label.ts
└── asset-list.ts
apps/web/tests/dataset-metadata/
specs/005-dataset-label-asset-metadata-foundation/
```

## Complexity Tracking

No exception: reuse the Phase 004 authorization boundary; do not create a parallel authorization system.
