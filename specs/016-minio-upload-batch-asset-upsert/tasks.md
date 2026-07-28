# Tasks: MinIO Upload + Batch Asset Upsert

**Input**: Design artifacts in `specs/016-minio-upload-batch-asset-upsert/`

**Prerequisites**: [spec.md](./spec.md), [plan.md](./plan.md),
[research.md](./research.md), [data-model.md](./data-model.md),
[worker contract](./contracts/repository-import-worker-contract.md), and
[mirror contract](./contracts/asset-mirror-contract.md).

**Tests**: Required. Phase 016 writes private binaries, Assets, child metadata,
and durable Job progress. Unit, Prisma/MinIO integration, duplicate-delivery,
safe-status, and controlled Compose worker evidence are mandatory.

**Hard boundary**: No migration, dependency, raw SQL, browser provider call,
worker HTTP endpoint, workflow-specific Job table, PostgreSQL binary, or queue
payload change is authorized. BullMQ remains exactly `{ jobId }`; PostgreSQL is
canonical Job state. Do not implement clone/history/thumbnail/UI work outside
the existing safe progress UI.

## Format: `[ID] [P?] [Story?] Description`

- `[P]` means the task can proceed in parallel after its listed prerequisites.
- Story labels map to the user stories in `spec.md`.

## Phase 1: Setup and Contract Baseline

**Purpose**: Establish the actual Phase-015 repository Job shape and protect
local-folder imports before any repository worker behavior changes.

- [X] T001 Audit `IMPORT_DATASET` inputs and current receipt-only behavior in `apps/worker/src/jobs/import-dataset.ts`, `apps/worker/src/queue/queue-router.ts`, and `apps/web/src/lib/repository-import/types.ts`; record the discriminator that identifies a Phase-015 repository Job without trusting queue data.
- [X] T002 [P] Define unit-test fixture builders for claimed repository Jobs, immutable source candidates, isolated MinIO prefixes, and safe provider results in `apps/worker/tests/repository-import/helpers.ts`.
- [X] T003 [P] Add a regression test proving local-folder `PreparedImport` Jobs retain their existing worker behavior while repository Jobs enter a distinct private processor path in `apps/worker/tests/repository-import/import-routing.test.ts`.
- [X] T004 Record policy configuration names, defaults, and validation rules for batch size (default 100, permitted 50–200), per-file size, total import size, and supported MIME/modality in `apps/worker/src/config.ts` and `specs/016-minio-upload-batch-asset-upsert/quickstart.md` without putting policy in browser input or database schema.

---

## Phase 2: Foundational Worker Safety

**Purpose**: Create shared server-only primitives required by every story.

- [X] T005 Implement strict parsing/allowlisting of the Phase-015 safe repository Job input in `apps/worker/src/jobs/repository-import-source.ts`; reject malformed, missing immutable ref, unsafe root, unknown provider, or credential-shaped input with safe worker error codes.
- [X] T006 [P] Implement deterministic SHA-256 `sourceFingerprint` and deterministic private object-key construction from Dataset/provider/repository/revision/path/provider-file identity in `apps/worker/src/jobs/source-fingerprint.ts`.
- [X] T007 [P] Add pure tests for fingerprint stability, changed revision/file identity divergence, normalized path handling, and object-key scoping in `apps/worker/tests/repository-import/fingerprint.test.ts`.
- [X] T008 Implement server-only public/private source-access resolution in `apps/worker/src/source/source-access.ts`: revalidate active owned private connections and derive public GitHub/Gitea roots only from approved server configuration; never use a URL/token from `Job.input`.
- [X] T009 [P] Add source-access tests for public configured provider access, private active credential access, expired/revoked/corrupt credentials, malformed safe Job input, and safe refusal in `apps/worker/tests/repository-import/source-access.test.ts`.
- [X] T010 Implement repository listing/downloading adapter bridge with normalized root-path enforcement, supported modality detection, server-controlled file/total limits, and ephemeral candidates only in `apps/worker/src/jobs/repository-import-source.ts`.
- [X] T011 [P] Add adapter-boundary tests for root escape, unsupported MIME, oversized candidate, list limit, download failure, and no token/path/raw provider diagnostic in outcomes in `apps/worker/tests/repository-import/source-access.test.ts`.
- [X] T012 Extend `apps/worker/src/jobs/job-event-writer.ts` with an allowlisted aggregate batch-event writer; prohibit file path, source URL, storage key, token, and raw provider error fields.
- [X] T013 [P] Extend `apps/worker/src/jobs/job-claim-lock.ts` schemas/helpers for lock-token-safe batch progress and a safe import completion summary containing only aggregate imported/skipped/failed counts.
- [X] T014 Add unit tests for batch-event and completion-summary allowlists, one-event-per-batch behavior, and rejection of raw/error/credential-shaped fields in `apps/worker/tests/repository-import/job-outcome-redaction.test.ts`.

**Checkpoint**: A claimed repository Job can be safely recognized, source access
can be resolved without queue/browser secrets, and all worker outcomes have a
bounded safe shape.

---

## Phase 3: User Story 1 — Import Repository Files into a Usable Dataset (P1)

**Goal**: A claimed valid repository Job mirrors supported files to MinIO and
creates usable modality-correct Assets.

**Independent test**: A real controlled provider → private worker → MinIO →
PostgreSQL flow imports supported fixture files and ends in a safe completed
Job with exact Asset/child-row evidence.

### Tests for User Story 1

- [X] T015 [P] [US1] Create real-stream MinIO integration tests for mirror upload, object verification, and no PostgreSQL binary storage in `apps/worker/tests/repository-import/worker-minio-runtime.test.ts`.
- [X] T016 [P] [US1] Add Prisma integration tests for IMAGE, VIDEO, TEXT, and AUDIO Asset reconciliation: correct `Asset.modality`, exactly one matching child row, and no incompatible child rows in `apps/worker/tests/repository-import/asset-upsert.test.ts`.
- [X] T017 [P] [US1] Add a worker integration test for a two-plus-batch repository fixture, asserting one aggregate JobEvent per batch and PostgreSQL progress/counter updates in `apps/worker/tests/repository-import/import-processor.test.ts`.
- [X] T018 [P] [US1] Add authenticated web tests proving owner asset list/view capability works after mirror and foreign access is concealed in `apps/web/tests/repository-import-worker/safe-status-and-asset-access.test.ts`.

### Implementation for User Story 1

- [X] T019 [US1] Implement deterministic MinIO streaming upload, post-upload object metadata verification, and scoped `safeCleanupUnpublishedObject` in `apps/worker/src/jobs/repository-asset-mirror.ts` and `apps/worker/src/providers/minio.ts`.
- [X] T020 [US1] Implement Prisma Asset reconciliation by `[datasetId, sourceFingerprint]`, set `MIRROR_TO_MINIO` plus safe provenance/storage metadata, and upsert only the matching modality child in `apps/worker/src/jobs/repository-asset-upsert.ts`.
- [X] T021 [US1] Add guarded compensation in `apps/worker/src/jobs/repository-asset-upsert.ts`: on publication failure, first confirm no Asset references exact bucket/key, then delete only a current import-scope object; preserve referenced/out-of-scope objects.
- [X] T022 [US1] Replace repository receipt-only behavior with a claimed repository processor in `apps/worker/src/jobs/import-dataset.ts`; preserve local-folder behavior and never process business work without the queue router’s claim token.
- [X] T023 [US1] Update `apps/worker/src/queue/queue-router.ts` to pass current claim context only to the repository processor, preserve payload `{ jobId }`, and preserve source refusal/failure semantics.
- [X] T024 [US1] Implement batch iteration, heartbeat boundaries, modality classification, per-batch PostgreSQL progress/event writes, and final safe completion in `apps/worker/src/jobs/import-dataset.ts`.
- [X] T025 [US1] Run the controlled Compose happy-path matrix in `apps/worker/tests/repository-import/worker-minio-runtime.test.ts`: public configured source and owned private source each produce MinIO objects, Assets, matching child rows, safe completed Job, and no leaked values.

**Checkpoint**: A valid repository import produces stable private Assets and a
safe completed Job without modifying the browser/API queue contract.

---

## Phase 4: User Story 2 — Safely Resume an Interrupted Import (P1)

**Goal**: Redelivery/retry and publish failure reconcile the same durable
source identity without duplicate assets, metadata, or objects.

**Independent test**: Deliver/reprocess a claimed Job after an earlier batch
and prove all original Asset IDs, fingerprints, and object keys are reused.

### Tests for User Story 2

- [X] T026 [P] [US2] Add duplicate-delivery/retry tests proving existing fingerprints reuse the same Asset ID, child row, and MinIO key in `apps/worker/tests/repository-import/retry-reconciliation.test.ts`.
- [X] T027 [P] [US2] Add controlled failure-injection tests for upload-success/Prisma-failure, object cleanup, retry recovery, and preservation of referenced/out-of-scope keys in `apps/worker/tests/repository-import/cleanup-compensation.test.ts`.
- [X] T028 [P] [US2] Add claim-race tests proving a second worker delivery cannot publish/progress after the first worker claims the Job in `apps/worker/tests/repository-import/claim-race.test.ts`.
- [X] T029 [P] [US2] Add cancellation-between-batches and invalidated-source-connection tests for no new batch/no unreferenced object and correct safe terminal state in `apps/worker/tests/repository-import/import-processor.test.ts`.

### Implementation for User Story 2

- [X] T030 [US2] Make `apps/worker/src/jobs/repository-asset-upsert.ts` idempotently reconcile existing Asset/object state before upload and after duplicate/unique-conflict outcomes; never create a second modality child row.
- [X] T031 [US2] Harden `apps/worker/src/jobs/repository-asset-mirror.ts` compensation and retry behavior for repeated cleanup, bulk/delete errors, and per-object failure isolation.
- [X] T032 [US2] Add cancellation/heartbeat/lock-token checks before each batch and after long-running candidate work in `apps/worker/src/jobs/import-dataset.ts`; call existing `cancelJob` only when cancellation was requested.
- [X] T033 [US2] Preserve safe partial counters and fail semantics for fatal provider/MinIO/Prisma/lock failures in `apps/worker/src/jobs/import-dataset.ts` and `apps/worker/src/jobs/job-claim-lock.ts`.
- [X] T034 [US2] Run the isolated two-worker and redelivery Compose suite in `apps/worker/tests/repository-import/claim-race.test.ts` and record exact PostgreSQL/Redis/MinIO invariants in `specs/016-minio-upload-batch-asset-upsert/quickstart.md`.

**Checkpoint**: Delivery at-least-once and retries reconcile safely, and
compensation never deletes a published/out-of-scope object.

---

## Phase 5: User Story 3 — Understand Import Outcome Without File-Level Noise (P2)

**Goal**: Owners see durable aggregate progress/outcome while file/provider
details remain private.

**Independent test**: A mixed fixture with valid, unsupported, and failing
files produces correct aggregate counters and safe status/event projection.

### Tests for User Story 3

- [X] T035 [P] [US3] Add mixed-outcome worker tests asserting imported/skipped/failed aggregate counters, safe summary, and no more than one JobEvent per batch in `apps/worker/tests/repository-import/import-processor.test.ts`.
- [X] T036 [P] [US3] Add HTTP safe-status/events redaction tests for completed, partial, failed, and canceled repository Jobs in `apps/web/tests/repository-import-worker/safe-status-and-asset-access.test.ts`.
- [X] T037 [P] [US3] Add regression tests proving Redis/BullMQ delivery data remains exactly `{ jobId }` and contains no file/credential/storage/progress report in `apps/worker/tests/repository-import/queue-redaction.test.ts`.

### Implementation for User Story 3

- [X] T038 [US3] Finalize safe summary/stage mapping and batch-level JobEvent messages in `apps/worker/src/jobs/import-dataset.ts` and `apps/worker/src/jobs/job-event-writer.ts`.
- [X] T039 [US3] Confirm the existing safe Job-status projection explicitly allowlists Phase-016 aggregate import summary and rejects raw object/provider/file fields in `apps/web/src/lib/jobs/safe-job-status.ts` and `apps/web/src/lib/jobs/safe-job-summary.ts`.
- [X] T040 [US3] Verify the Dataset asset list and authorized view URL continue to use PostgreSQL Asset metadata and backend-generated capability only in `apps/web/src/app/api/datasets/[datasetId]/assets/route.ts` and `apps/web/src/app/api/assets/[assetId]/view-url/route.ts`.

**Checkpoint**: Owners see aggregate durable outcome; Redis and public APIs
expose neither raw source details nor private storage information.

---

## Phase 6: Final Validation and Scope Audit

**Purpose**: Produce runtime evidence before closing Phase 016.

- [X] T041 Run Prisma validation/generate and confirm no schema/migration change was introduced for Phase 016 using `prisma/schema.prisma` and `pnpm exec prisma validate`.
- [X] T042 Run worker unit/repository suites, web safe-status suite, and controlled Compose end-to-end suite using a passworded isolated Redis DB/prefix and a scoped MinIO prefix; record commands/totals in `specs/016-minio-upload-batch-asset-upsert/quickstart.md`.
- [X] T043 Verify runtime service health, worker readiness, private bucket availability, and normal Compose restoration after tests; record only non-secret results in `specs/016-minio-upload-batch-asset-upsert/quickstart.md`.
- [X] T044 Run root typecheck, lint, worker/web production builds, and `git diff --check`; record results in `specs/016-minio-upload-batch-asset-upsert/quickstart.md`.
- [X] T045 Perform architecture/scope audit against `AGENTS.md`, `docs/architecture.md`, `docs/job-system.md`, and `docs/clone-repository-plan.md`; confirm no clone endpoint, no binary PostgreSQL, no Redis Job state, no raw queue payload, no credential leak, and no unapproved later-phase work in `specs/016-minio-upload-batch-asset-upsert/quickstart.md`.

---

## Dependencies and Execution Order

```text
Setup (T001–T004)
  → Foundational safety (T005–T014)
    → US1 usable mirrored Assets (T015–T025)
      → US2 retry/compensation safety (T026–T034)
        → US3 safe aggregate outcome (T035–T040)
          → final validation/scope audit (T041–T045)
```

US1 is the MVP. US2 depends on the mirror/upsert implementation from US1. US3
depends on batch outcomes produced by US1 and preserves US2 safety semantics.

## Parallel Opportunities

- After T001, T002–T004 can proceed independently.
- After T005, T006/T007, T008/T009, T010/T011, and T012/T013/T014 are separate
  file groups and can proceed in parallel.
- US1 test scaffolding T015–T018 can be written in parallel before T019–T024.
- US2 tests T026–T029 can be prepared in parallel after US1 contracts settle.
- US3 tests T035–T037 can be prepared in parallel after batch outcome schema
  is stable.

## Implementation Strategy

1. Deliver the smallest vertical slice: public controlled repository → one
   image → MinIO → Asset/ImageAsset → safe completed Job (T001–T025).
2. Add deterministic redelivery, cancellation, and cleanup proof (T026–T034)
   before enabling larger/multi-modality imports.
3. Complete aggregate safe progress/redaction and controlled end-to-end
   validation (T035–T045).
