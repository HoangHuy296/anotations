# Tasks: Local Folder Import and Commit Signal

**Input**: Design documents from `/specs/010-local-folder-import-commit-signal/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Required. Use existing Node/tsx, Prisma, Compose MinIO/Redis, and worker test conventions. Denied paths must verify no database, object, queue, or event side effect.

**Scope guard**: Browser never sends binary or absolute local path to backend. PostgreSQL is canonical. Queue payload is exactly `{ jobId }`. Do not add ImportJob tables, binary database fields, storage credentials/browser provider access, modality-specific workspace routes, or Redis Job state.

## Phase 1: Setup and scope controls

**Purpose**: Record import-specific boundaries before schema or runtime edits.

- [X] T001 Record Phase 010 implementation scope, exclusions, and Phase 009 dependencies in `specs/010-local-folder-import-commit-signal/plan.md`
- [X] T002 [P] Add safe local import test environment requirements to `specs/010-local-folder-import-commit-signal/quickstart.md`
- [X] T003 [P] Create local-folder import test fixture helpers, safe manifest builders, and MinIO inspection helpers in `apps/web/tests/local-folder-import/helpers.ts`
- [X] T004 [P] Add Phase 010 test commands/discovery to `apps/web/package.json` and `apps/worker/package.json`

---

## Phase 2: Durable foundation and authorization

**Purpose**: Build the blocking durable model and server-only boundaries before browser or worker flow.

**⚠️ CRITICAL**: Complete this phase before all user stories.

- [X] T005 Add `PreparedImport`, `PreparedImportItem`, required relations/indexes/uniques, and safe import fields to `prisma/schema.prisma`
- [X] T006 Create and review the additive PreparedImport migration in `prisma/migrations/`
- [X] T007 Generate Prisma client from `prisma/schema.prisma`
- [X] T008 [P] Add Zod schemas for safe manifest items, start, item completion, and commit requests in `apps/web/src/lib/validation/local-folder-import.ts`
- [X] T009 [P] Add import-specific safe error codes (`IMPORT_INCOMPLETE`, `IMPORT_COMMIT_TIMEOUT`, preparation conflict) in `apps/web/src/lib/api-response.ts`
- [X] T010 Add Dataset/import ownership lookup, preparation authorization, and safe not-found/conﬂict helpers in `apps/web/src/lib/imports/authorization.ts`
- [X] T011 Add an `IMPORT_DATASET` queue name mapping while retaining `{ jobId }` payload in `packages/queue/src/job-contract.ts` and `apps/web/src/lib/queue/queue-names.ts`
- [X] T012 Add private-worker routing support for approved `IMPORT_DATASET` deliveries in `apps/worker/src/queue/queue-router.ts`
- [X] T013 Add foundation schema/authorization/queue-payload tests in `apps/web/tests/local-folder-import/foundation.test.ts`

**Checkpoint**: Durable preparation and item identities exist; authorization is server-side; import delivery is approved without changing queue payload.

---

## Phase 3: User Story 1 - Prepare and upload a local folder (Priority: P1) 🎯 MVP

**Goal**: An authorized user can preflight a local folder, create a Dataset/import preparation/Job, upload directly, and reconcile one Asset per item.

**Independent Test**: An owner starts a mixed-modality manifest, uploads each approved item through a scoped capability, and sees one Asset/child row per completed item without an absolute path or backend binary transfer.

### Tests for User Story 1

- [X] T014 [P] [US1] Add start/preflight contract tests for absolute-path/binary rejection, duplicate logical names, and safe response redaction in `apps/web/tests/local-folder-import/start-route.test.ts`
- [X] T015 [P] [US1] Add upload-capability/item-completion authorization, MinIO verification, idempotency, and no-side-effect tests in `apps/web/tests/local-folder-import/item-completion.test.ts`
- [X] T016 [P] [US1] Add modality/child-row creation tests for image, video, text, and audio in `apps/web/tests/local-folder-import/modality-assets.test.ts`

### Implementation for User Story 1

- [X] T017 [US1] Implement durable idempotent Dataset + PreparedImport + `IMPORT_DATASET` Job start service in `apps/web/src/lib/imports/prepare-local-folder-import.ts`
- [X] T018 [US1] Implement authorized preparation endpoint in `apps/web/src/app/api/imports/local-folder/route.ts`
- [X] T019 [US1] Implement authorized batch object-scoped upload-capability service using existing direct-upload policy in `apps/web/src/lib/imports/local-folder-upload.ts`
- [X] T020 [US1] Implement batch upload-capability endpoint in `apps/web/src/app/api/imports/[preparedImportId]/upload-capabilities/route.ts`
- [X] T021 [US1] Implement item object verification, Asset/child-row reconciliation, and durable progress update in `apps/web/src/lib/imports/complete-local-folder-item.ts`
- [X] T022 [US1] Implement idempotent item-complete endpoint in `apps/web/src/app/api/imports/[preparedImportId]/items/[itemId]/complete/route.ts`
- [X] T023 [US1] Implement browser folder picker, safe preflight scanner, batch transfer state, and no-path client model in `apps/web/src/components/imports/local-folder-import-form.tsx`
- [X] T024 [US1] Implement new Dataset local-folder page in `apps/web/src/app/(app)/datasets/local-folder/page.tsx`

**Checkpoint**: A complete set of files can be prepared and uploaded into a new Dataset without final completion being claimed.

---

## Phase 4: User Story 2 - Commit a complete import (Priority: P1)

**Goal**: An authorized user commits only a complete durable import, with idempotent finalization and Phase 009 progress UI.

**Independent Test**: A fully completed preparation commits once; incomplete, unauthorized, duplicate, and invalid-state commits are safe and do not duplicate data.

### Tests for User Story 2

- [X] T025 [P] [US2] Add HTTP commit matrix for owner/member/non-member, Job type/state, count match/mismatch, and safe error output in `apps/web/tests/local-folder-import/commit-route.test.ts`
- [X] T026 [P] [US2] Add commit race/idempotency tests proving one terminal outcome, event, Asset set, and queue delivery in `apps/web/tests/local-folder-import/commit-route.test.ts`

### Implementation for User Story 2

- [X] T027 [US2] Implement server-side commit count validation and idempotent completion mutation in `apps/web/src/lib/imports/commit-local-folder-import.ts`
- [X] T028 [US2] Append allowlisted import completion/incomplete events in `apps/web/src/lib/jobs/safe-job-event.ts` and `apps/web/src/lib/imports/commit-local-folder-import.ts`
- [X] T029 [US2] Implement authorized `commit-import` route in `apps/web/src/app/api/jobs/[jobId]/commit-import/route.ts`
- [X] T030 [US2] Add commit action, incomplete state, and durable refresh to `apps/web/src/components/imports/local-folder-import-form.tsx` and `apps/web/src/components/jobs/job-action-buttons.tsx`

**Checkpoint**: Complete imports finalize exactly once; incomplete imports stay visibly non-terminal with `IMPORT_INCOMPLETE`.

---

## Phase 5: User Story 3 - Recover from interrupted import (Priority: P2)

**Goal**: Uncommitted imports safely time out, clean up only safe orphans, and retry/reconcile without duplicates.

**Independent Test**: An expired preparation transitions to one failed `IMPORT_COMMIT_TIMEOUT` outcome; repeated scans/retries do not duplicate or delete published data.

### Tests for User Story 3

- [X] T031 [P] [US3] Add timeout scanner tests for deadline, terminal idempotency, safe summary/event, and partial progress in `apps/worker/tests/queue/import-timeout-scanner.test.ts`
- [X] T032 [P] [US3] Add cleanup/retry reconciliation tests for referenced vs orphan objects and duplicate item completion in `apps/web/tests/local-folder-import/cleanup-and-retry.test.ts`
- [X] T033 [P] [US3] Add worker claim/heartbeat/cancel regression for `IMPORT_DATASET` in `apps/worker/tests/queue/import-dataset-worker.test.ts`

### Implementation for User Story 3

- [X] T034 [US3] Implement `IMPORT_DATASET` private worker processor using current lease mutations and durable preparation state in `apps/worker/src/jobs/import-dataset.ts`
- [X] T035 [US3] Implement PostgreSQL-backed stale import scanner and `IMPORT_COMMIT_TIMEOUT` transition in `apps/worker/src/queue/import-timeout-scanner.ts`
- [X] T036 [US3] Implement safe orphan-only object cleanup and import retry reconciliation in `apps/web/src/lib/imports/import-cleanup.ts`
- [X] T037 [US3] Register processor and scanner in worker bootstrap/recovery flow in `apps/worker/src/queue/queue-router.ts` and `apps/worker/src/index.ts`
- [X] T038 [US3] Render timeout/partial import outcome through safe Job summary in `apps/web/src/components/jobs/job-error-panel.tsx`

**Checkpoint**: A disconnected import becomes safely failed, remains observable, and can be reconciled without duplicate assets or unsafe object deletion.

---

## Phase 6: User Story 4 - Enforce import ownership (Priority: P2)

**Goal**: Every import resource and object capability obeys Dataset/import ownership and leaves no denial side effect.

**Independent Test**: Known preparation, item, Dataset, Job, and upload references from a non-member result in concealment and no durable/object/queue writes.

### Tests for User Story 4

- [X] T039 [P] [US4] Add full owner/manager/reviewer/labeler/non-member authorization matrix and no-side-effect assertions in `apps/web/tests/local-folder-import/ownership-matrix.test.ts`
- [X] T040 [P] [US4] Add expired/cross-preparation upload-capability and object-reference isolation tests in `apps/web/tests/local-folder-import/upload-capability-security.test.ts`

### Implementation for User Story 4

- [X] T041 [US4] Apply authorization helpers to all import routes and services in `apps/web/src/app/api/imports/` and `apps/web/src/lib/imports/`
- [X] T042 [US4] Audit client props/responses/logging for paths, credentials, storage keys, raw manifest, queue, lock, and binary leakage in `apps/web/src/components/imports/` and `apps/web/src/app/api/imports/`

**Checkpoint**: Import preparation, transfer, commit, timeout, and retry preserve Dataset isolation end-to-end.

---

## Phase 7: Polish and cross-cutting validation

- [X] T043 Update API/UI contract and validation record with final semantics in `specs/010-local-folder-import-commit-signal/contracts/` and `specs/010-local-folder-import-commit-signal/quickstart.md`
- [X] T044 [P] Audit schema and queue contract for no separate Job table, no binary fields, and strict `{ jobId }` payload in `prisma/schema.prisma` and `packages/queue/src/job-contract.ts`
- [X] T045 Run migration, Prisma validate/generate, web/worker typecheck/build, local import integration suite, worker suite, and Compose MinIO/Redis smoke test; record results in `specs/010-local-folder-import-commit-signal/quickstart.md`
- [X] T046 Confirm no repository import, annotation/taxonomy creation, backend binary proxy, or modality-specific route was introduced in `apps/web/src/`, `apps/worker/src/`, and `prisma/schema.prisma`

## Dependencies and execution order

- Setup → Foundation blocks all stories.
- US1 provides preparation/item state used by US2 and US3.
- US2 commit depends on US1 completion reconciliation.
- US3 timeout/worker recovery depends on foundation and prepared item state; it may start after US1.
- US4 authorization tests span all routes after their implementation.
- Polish follows all stories.

```text
Setup → Foundation → US1 upload → US2 commit
                         ├────→ US3 timeout/recovery
                         └────→ US4 ownership audit
                                     ↓
                                  Polish
```

## Parallel opportunities

- T002–T004; T008–T009; and T014–T016 can run in parallel.
- US2 tests T025–T026 and US3 tests T031–T033 can run in parallel after their prerequisites.
- T039–T040 can run in parallel after import endpoints are present.

## Implementation strategy

### MVP first

1. Complete Setup and Foundation.
2. Complete US1 durable preparation and direct item completion.
3. Validate no-path/no-binary and correct Asset modality behavior.
4. Stop for review before enabling commit or worker processing.

### Incremental delivery

1. US1 creates safe prepared uploads.
2. US2 adds accurate finalization.
3. US3 adds disconnect recovery.
4. US4 proves isolation and security.
5. Polish validates the complete path.

## Format validation

All 46 tasks use required checkbox, sequential ID, explicit file path, and user-story label where applicable.
