# Tasks: Dataset, Label, and Asset Metadata Foundation

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [data-model.md](./data-model.md), [metadata API contract](./contracts/metadata-api.md), and [quickstart.md](./quickstart.md).

**Access policy used by every task**: `UserRole.ADMIN` is the system-wide override and may manage all datasets, labels, jobs, and source connections. `UserRole.MANAGER` may create a Dataset but, for an existing Dataset, may manage only one they own or where they are `DatasetMemberRole.MANAGER`; it never grants access to every Dataset. Labeler and Reviewer may read/list only owned/member Dataset metadata and cannot mutate datasets or labels. Effective permission is `UserRole + Dataset ownership + DatasetMemberRole`.

## Phase 1: Setup

- [X] T001 Record Dataset/Label/Asset route coverage and expected role outcomes in `specs/005-dataset-label-asset-metadata-foundation/contracts/access-coverage.md`.
- [X] T002 Create safe Zod request/query schemas for Dataset, Label, and Asset-list operations in `apps/web/src/lib/validation/dataset.ts` and `apps/web/src/lib/validation/asset-list.ts`.

## Phase 2: Foundational Authorization

- [X] T003 Extend the server-only authorization policy with explicit metadata-operation role checks in `apps/web/src/lib/authorization.ts`.
- [X] T004 Create reusable safe Dataset/Label/Asset response projections that exclude binary, storage, provider, source URL, encrypted, and credential fields in `apps/web/src/lib/dataset-metadata.ts`.
- [X] T005 Add Prisma-backed authorization fixtures and role matrix helpers in `apps/web/tests/dataset-metadata/helpers.ts`.

**Checkpoint**: Every later handler must call the central session actor and Dataset permission boundary before reading or mutating a record.

## Phase 3: User Story 1 — Manage a Dataset (Priority: P1) 🎯 MVP

**Goal**: System Admin or Manager creates a Dataset; Admin may manage all existing Datasets while Manager manages only owned/member Datasets; Labeler/Reviewer only read/list assigned Datasets.

**Independent Test**: Verify allowed role responses, member-without-permission `403`, outsider `404`, multi-modal create, server-derived owner, and archive-not-hard-delete behavior.

- [X] T006 [P] [US1] Write Dataset CRUD authorization, ownership, multi-modal, and archive tests in `apps/web/tests/dataset-metadata/datasets.test.ts`.
- [X] T007 [US1] Implement authorized Dataset list/create operations in `apps/web/src/app/api/datasets/route.ts`.
- [X] T008 [US1] Implement authorized Dataset detail/update/archive operations in `apps/web/src/app/api/datasets/[datasetId]/route.ts`.
- [X] T009 [US1] Implement Dataset detail page data loading through the server authorization boundary in `apps/web/src/app/(app)/datasets/[datasetId]/page.tsx`.

## Phase 4: User Story 2 — Manage Dataset Labels (Priority: P1)

**Goal**: System Admin or an authorized Dataset owner/manager manages taxonomy; all authorized Dataset members read labels.

**Independent Test**: Verify normalized-name collision rejection, allowed manage operations, read-only roles, outsider `404`, and no mutation on denial.

- [X] T010 [P] [US2] Write Label API normalized-name, role, cross-dataset, and no-side-effect tests in `apps/web/tests/dataset-metadata/labels.test.ts`.
- [X] T011 [US2] Implement authorized Dataset label list/create operations in `apps/web/src/app/api/datasets/[datasetId]/labels/route.ts`.
- [X] T012 [US2] Implement authorized Label update/delete operations scoped through the label Dataset in `apps/web/src/app/api/labels/[labelId]/route.ts`.
- [X] T013 [US2] Ensure display-name normalization and duplicate conflict mapping use the existing `(datasetId, normalizedName)` constraint in `apps/web/src/lib/validation/label.ts`.

## Phase 5: User Story 3 — Browse Asset Metadata (Priority: P1)

**Goal**: Every dataset member can browse bounded, safe asset metadata within their Dataset.

**Independent Test**: Verify pages/filter combinations never return another Dataset's asset or binary/secret metadata, including page beyond result range.

- [X] T014 [P] [US3] Write asset pagination, status/modality/search-filter, projection, outsider, and cross-dataset tests in `apps/web/tests/dataset-metadata/assets.test.ts`.
- [X] T015 [US3] Implement the authorized paginated/filterable Asset metadata endpoint in `apps/web/src/app/api/datasets/[datasetId]/assets/route.ts`.
- [X] T016 [US3] Implement authorized Dataset detail asset-list UI state in `apps/web/src/app/(app)/datasets/[datasetId]/page.tsx`.

## Phase 6: Polish and Validation

- [X] T017 Run the complete Dataset/Label/Asset role matrix with Prisma no-side-effect assertions and record results in `specs/005-dataset-label-asset-metadata-foundation/quickstart.md`.
- [X] T018 Run the Phase 005 Node tests, `pnpm typecheck`, and `pnpm --filter @annotationplatform/web lint`; record results in `specs/005-dataset-label-asset-metadata-foundation/quickstart.md`.
- [X] T019 Review all metadata responses for binary, storage, source URL, token, encrypted-value, and ownership leakage in `specs/005-dataset-label-asset-metadata-foundation/contracts/access-coverage.md`.
- [X] T020 Confirm no Prisma schema, migration, generated client, worker, queue-processing, or binary-storage changes in `specs/005-dataset-label-asset-metadata-foundation/quickstart.md`.
- [X] T021 Run focused authenticated HTTP integration coverage for Dataset CRUD/archive, Label collision/denial, and Asset pagination/filtering in `apps/web/tests/dataset-metadata/http-routes.test.ts`.

## Dependencies and Execution Order

```text
T001–T005 → US1 (T006–T009) → US2 (T010–T013) + US3 (T014–T016) → T017–T021
```

- US2 and US3 can proceed in parallel after foundational authorization and Dataset route conventions are complete.
- No task may replace the Phase 004 authorization boundary or trust browser-supplied owner/dataset scope.

## Parallel Opportunities

- T006, T010, and T014 are independent test files after T005.
- T011 and T015 modify separate route files after T003–T004.
- T017 and T019 can run in parallel after all story tasks.

## MVP

Complete T001–T009: authorized Dataset CRUD/archive with multi-modal support and correct role/non-member denial.
