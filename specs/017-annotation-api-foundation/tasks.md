# Tasks: Annotation API Foundation

**Input**: Design documents from `/specs/017-annotation-api-foundation/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md), and
[annotation API contract](./contracts/annotation-api.md).

**Tests**: Required. This feature changes durable annotation state and its
optimistic-lock boundary. Tests must use normal opaque-cookie HTTP sessions and
controlled PostgreSQL fixtures; no auth bypass, mocked database, queue, or
storage side effect is permitted.

**Hard boundary**: No schema migration, dependency, raw SQL, worker, Job,
BullMQ/Redis, MinIO, provider, binary, or browser token work is authorized.
`Annotation.revision` remains the only concurrency field and
`Annotation.geometry` remains canonical JSON. GET supports every modality;
PUT supports IMAGE only, with BOUNDING_BOX, POLYGON, CIRCLE, POINT, and
POLYLINE.

## Format: `[ID] [P?] [Story?] Description`

- `[P]` marks work in a different file that may proceed after its listed
  prerequisite.
- Story labels map to the three user stories in `spec.md`.
- Every runtime assertion must avoid printing passwords, cookies, tokens,
  provider/storage configuration, database URLs, or raw server errors.

## Phase 1: Setup and Compatibility Inventory

**Purpose**: Lock the current Annotation schema and workspace-action
compatibility before adding an HTTP mutation boundary.

- [X] T001 Record the current `Annotation.revision`, Asset/Label scope, and existing `version`-named image action compatibility calls in `specs/017-annotation-api-foundation/research.md` and `apps/web/src/lib/validation/annotation.ts`; do not add a `version` column or migration.
- [X] T002 Confirm the normal opaque-session actor helper, Dataset permission matrix, concealment policy, and existing workspace fixture helpers in `apps/web/src/lib/auth.ts`, `apps/web/src/lib/authorization.ts`, and `apps/web/tests/workspace/helpers.ts` before adding API tests.
- [X] T003 Create the focused test directory and shared authenticated Asset/Dataset/Label fixture helpers in `apps/web/tests/annotation-api/helpers.ts`, reusing normal signup/login and Prisma cleanup conventions without an auth bypass.

---

## Phase 2: Foundational Validation, Projection, and Error Semantics

**Purpose**: Build the shared server-only pieces that every GET and PUT path
uses. Complete this phase before any user-story route implementation.

- [X] T004 Define bounded Zod request schemas, CUID parsing, explicit create/update/delete lists, and stable API error DTOs in `apps/web/src/lib/validation/annotation-api.ts`; reject browser-supplied Dataset, owner, creator, source, review, storage, and queue fields.
- [X] T005 [P] Implement strict IMAGE geometry schemas and reusable geometry validation helpers in `apps/web/src/lib/validation/annotation-api.ts`; reject non-finite numbers, out-of-range values, invalid point arrays, and shapes outside image bounds.
- [X] T006 [P] Implement the one safe annotation DTO projection and deterministic list ordering in `apps/web/src/lib/annotations/safe-annotation.ts`; expose canonical geometry and `revision` only, never session/creator details, source/storage values, raw errors, or infrastructure data.
- [X] T007 Implement server-only Asset/Dataset resolution, Label/AssetVersion reference validation, and server-derived own-versus-any annotation permission selection in `apps/web/src/lib/annotations/annotation-service.ts`; preserve concealed foreign/unknown resource behavior.
- [X] T008 Add unit tests for schemas, geometry boundaries, and safe DTO redaction in `apps/web/tests/annotation-api/annotation-validation.test.ts`; cross-Asset/cross-Dataset refusal is covered through the authenticated HTTP boundary in T016.

**Checkpoint**: Canonical geometry, safe projection, and authorization/refusal
rules are reusable and require no queue, MinIO, or worker interaction.

---

## Phase 3: User Story 1 — Load an Asset's Annotations (Priority: P1) 🎯 MVP

**Goal**: An authorized workspace can load its Asset's current annotation list
or a durable empty list before rendering overlays.

**Independent Test**: Normal cookie-authenticated HTTP GET returns a stable
safe list for an owner/member, `[]` for an empty Asset, and concealed results
for foreign/unknown/malformed/cross-Dataset Assets.

### Tests for User Story 1

- [X] T009 [P] [US1] Write authenticated HTTP list-route tests for populated and empty Assets in `apps/web/tests/annotation-api/annotation-http.test.ts`; assert `200`, safe DTO fields, canonical geometry, deterministic ordering, and `revision`.
- [X] T010 [P] [US1] Add owner/member/foreign/unknown/malformed/cross-Dataset GET concealment and response-redaction cases in `apps/web/tests/annotation-api/annotation-http.test.ts`.

### Implementation for User Story 1

- [X] T011 [US1] Implement the read-only list operation in `apps/web/src/lib/annotations/annotation-service.ts` using the shared Asset/Dataset guard and safe projection; return an empty list for an authorized Asset with no rows.
- [X] T012 [US1] Add `GET /api/assets/[assetId]/annotations` to `apps/web/src/app/api/assets/[assetId]/annotations/route.ts`; resolve the session actor first and map validation/auth/concealment outcomes to the established safe HTTP envelope.
- [X] T013 [US1] Add a client-safe annotation-list refresh adapter in `apps/web/src/lib/annotations/annotation-api-client.ts`; the initial workspace read remains the approved shared server-side service rather than a duplicate browser fetch.
- [X] T014 [US1] Add workspace loading regression coverage in `apps/web/tests/annotation-api/annotation-service.test.ts`, proving the shared server-side shell read separates editable and visible read-only annotations without fetching raw Job/storage/provider data.

**Checkpoint**: User Story 1 is independently usable: the workspace receives
only authorized durable annotation data before overlay rendering.

---

## Phase 4: User Story 2 — Save Valid Annotation Changes Safely (Priority: P1)

**Goal**: An authorized annotator can atomically create, geometry-update, or
explicitly delete annotations for one Asset.

**Independent Test**: An owner or permitted member submits one valid mixed
change set through normal HTTP and receives safe current DTOs; invalid input or
authorization denial leaves all durable state unchanged.

### Tests for User Story 2

- [X] T015 [P] [US2] Write authenticated PUT success tests for all five IMAGE shape creates, geometry-only edits, explicit label reassignment, replay identity, revision-guarded deletion, and safe result DTOs in `apps/web/tests/annotation-api/annotation-http.test.ts`.
- [X] T016 [P] [US2] Write HTTP geometry, label, cross-Asset, and cross-Dataset rejection tests with before/after Annotation/Job/JobEvent snapshots in `apps/web/tests/annotation-api/annotation-http.test.ts`; assert no isolated MinIO/Redis/BullMQ side effect is initiated. AssetVersion is not mutated by the Phase 017 annotation contract.
- [X] T017 [P] [US2] Write owner, manager, reviewer, labeler, and foreign-user mutation matrix tests based on the existing permission policy in `apps/web/tests/annotation-api/annotation-http.test.ts`; prove a labeler cannot alter another creator's annotation.

### Implementation for User Story 2

- [X] T018 [US2] Implement Asset-scoped create validation and server-derived Annotation metadata in `apps/web/src/lib/annotations/annotation-service.ts`; validate the exact Asset, Dataset, compatible Label, modality, type, and canonical geometry before persistence.
- [X] T019 [US2] Implement geometry-only revision-guarded updates in `apps/web/src/lib/annotations/annotation-service.ts`; mutate only geometry, `updatedById`, and `revision`, preserving label assignment, taxonomy, properties, status, review data, and unrelated metadata.
- [X] T020 [US2] Implement explicit revision-guarded deletion and one all-or-nothing Prisma transaction for the complete change set in `apps/web/src/lib/annotations/annotation-service.ts`; any validation, authorization, missing reference, or guarded-write failure must roll back every requested mutation.
- [X] T021 [US2] Add `PUT /api/assets/[assetId]/annotations` to `apps/web/src/app/api/assets/[assetId]/annotations/route.ts`; return current safe DTOs and deleted IDs on success, stable validation errors on malformed bodies, and no raw Prisma errors.
- [X] T022 [US2] Reconcile existing image workspace action compatibility in `apps/web/src/app/(app)/workspace/[datasetId]/actions.ts`, `apps/web/src/lib/validation/annotation.ts`, and `apps/web/src/lib/workspace/image-mutations.ts` so internal `version` naming cannot create a second public concurrency contract; retain current action regression behavior and no schema change.

**Checkpoint**: User Story 2 is independently usable: authorized, validated
single-Asset annotation saves are atomic and geometry does not alter label
taxonomy metadata.

---

## Phase 5: User Story 3 — Prevent Stale Annotation Overwrites (Priority: P1)

**Goal**: The API detects stale annotation revisions and the workspace does not
silently overwrite newer durable geometry.

**Independent Test**: Two normal authenticated actors submit the same current
revision; exactly one succeeds, the other receives a stable conflict, and a
mixed batch containing a stale annotation rolls back entirely.

### Tests for User Story 3

- [X] T023 [P] [US3] Add concurrent HTTP revision-race and single-winner tests in `apps/web/tests/annotation-api/annotation-conflicts-http.test.ts`.
- [X] T024 [P] [US3] Add mixed change-set rollback, stale explicit-delete, and stale geometry-update tests in `apps/web/tests/annotation-api/annotation-conflicts-http.test.ts`; assert the durable winner and all unrelated rows remain unchanged.
- [X] T025 [P] [US3] Add client conflict-adapter tests in `apps/web/tests/annotation-api/annotation-api-client.test.ts`; a `409 ANNOTATION_REVISION_CONFLICT` surfaces a typed conflict result and is never retried by the adapter.

### Implementation for User Story 3

- [X] T026 [US3] Convert any zero-count revision-guarded mutation in `apps/web/src/lib/annotations/annotation-service.ts` into a stable `ANNOTATION_REVISION_CONFLICT` outcome that aborts the enclosing transaction.
- [X] T027 [US3] Extend `apps/web/src/lib/annotations/annotation-api-client.ts` and `apps/web/src/stores/annotation-store.ts` with a typed conflict result/reload-needed state; do not add autosave timing, background retry, or client-side overwrite behavior.
- [X] T028 [US3] Re-run and update the existing revision/action regressions in `apps/web/tests/workspace/annotation-locking.test.ts` and `apps/web/tests/workspace/annotation-mutations.test.ts` to assert `revision` remains canonical across API and legacy action compatibility paths.

**Checkpoint**: All three user stories are independently complete: reads are
safe, writes are atomic, and stale writes cannot silently win.

---

## Phase 6: Polish, Security Evidence, and Final Validation

**Purpose**: Complete the mandatory safe-response and runtime validation
record without introducing a later phase.

- [X] T029 [P] Audit GET/PUT successes, validation failures, conflicts, and concealed responses for credential/session/source/storage/queue/raw-error/stack leakage in `apps/web/tests/annotation-api/annotation-http.test.ts`.
- [X] T030 [P] Add no-side-effect assertions for rejected PUT cases in `apps/web/tests/annotation-api/annotation-http.test.ts`, including Annotation, Job, JobEvent, isolated Redis/BullMQ, and MinIO snapshots.
- [X] T031 Update authenticated API contract examples and executed evidence guidance in `specs/017-annotation-api-foundation/contracts/annotation-api.md` and `specs/017-annotation-api-foundation/quickstart.md`; record only commands actually run during implementation.
- [X] T032 Run focused annotation API/workspace suites, Prisma validate/generate, web typecheck, lint, production build, and `git diff --check`; record pass/fail/skip totals and non-secret blockers in `specs/017-annotation-api-foundation/quickstart.md`.
- [X] T033 Perform the final architecture/scope audit in `specs/017-annotation-api-foundation/quickstart.md`: confirm PostgreSQL annotation authority, no Job/queue/MinIO worker path, canonical geometry/revision, opaque-cookie authorization, no migration/dependency, and no later-phase autosave/review/canvas expansion.

---

## Dependencies and Execution Order

```text
T001–T003 Setup
  → T004–T008 Foundation
    → US1: T009–T014 (safe reads)
      → US2: T015–T022 (atomic writes)
        → US3: T023–T028 (conflicts)
          → T029–T033 final validation and audit
```

US2 depends on the shared read/projection/guard foundation and uses its safe
DTOs. US3 depends on the completed revision-guarded write boundary. The final
phase depends on all user stories.

## Parallel Opportunities

- After T003, T005 and T006 may proceed in parallel; T008 follows their
  completed validation/projection helpers.
- After the foundation, T009 and T010 may be prepared in parallel, followed by
  T011–T014.
- In US2, T015–T017 are independent test files and may be written in parallel
  before T018–T022.
- In US3, T023–T025 are independent test preparation tasks and may proceed in
  parallel after the atomic mutation contract is stable.
- T029 and T030 may run in parallel after all route behavior is implemented.

## Implementation Strategy

### MVP First — User Story 1

1. Complete T001–T008.
2. Implement and validate T009–T014.
3. Stop: demonstrate an authorized workspace reading populated and empty
   annotation lists with concealed foreign access.

### Incremental Delivery

1. Add US2 only after GET safe projection and Asset scope are proven.
2. Add US3 only after the transaction and guarded revision mutations are
   proven.
3. Complete T029–T033 only after the full authenticated HTTP, no-side-effect,
   and workspace regression evidence is green.

## Notes

- All 33 tasks use the required checkbox, ID, and exact path format.
- This task list intentionally does not authorize Phase 012 autosave timing,
  Phase 011 canvas features, annotation review decisions, worker processing,
  or any schema migration.
