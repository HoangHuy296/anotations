# Tasks: Direct Upload and Multi-modal Metadata Rows

**Input**: [spec.md](./spec.md), [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [upload API contract](./contracts/upload-api.md), and [quickstart.md](./quickstart.md).

**Tests**: Required. The specification requires HTTP integration coverage using the real Compose MinIO service plus Prisma assertions. Do not use raw SQL, mocks for MinIO, or browser-visible credentials.

**Security policy used by every task**: Resolve `getSessionActor()` first. `ADMIN` is the system-wide override; every non-admin must own or be a Dataset member. `asset.upload` is required to issue and complete an upload; `dataset.read` is required to issue a view capability. A non-member receives `404`; a known member lacking the required permission receives `403`. Browser MinIO access is permitted only through a backend-generated, short-lived, object-scoped presigned URL; it is never a credential.

## Phase 1: Setup and Runtime Boundary

**Purpose**: Make the approved direct-transfer boundary explicit and configure a safe, browser-reachable MinIO capability path without exposing credentials.

- [X] T001 Review the approved controlled presigned-URL exception and verify its wording remains consistent across `AGENTS.md`, `docs/architecture.md`, and `specs/006-direct-upload-multi-modal-metadata-rows/spec.md`.
- [X] T002 Add documented non-secret direct-upload configuration (`MINIO_PUBLIC_ENDPOINT`, `MINIO_CORS_ALLOWED_ORIGIN`, `UPLOAD_CAPABILITY_SECRET`) in `packages/domain/src/provider-config.ts`, `.env.example`, and `docker-compose.yaml`; keep access/secret keys server-only.
- [X] T003 Configure private MinIO browser reachability and restrictive CORS for only `MINIO_CORS_ALLOWED_ORIGIN` in `docker-compose.yaml`, without exposing the MinIO console, bucket listing, or anonymous object access.
- [X] T004 Add the `test:direct-upload` Node/tsx test command with the existing server-only module registration in `apps/web/package.json`.

## Phase 2: Foundational Upload Services (Blocking Prerequisites)

**Purpose**: Create server-only primitives that every browser-facing upload and view route depends on.

**⚠️ CRITICAL**: Complete this phase before any upload, completion, or view route. Do not create a schema migration, UploadIntent table, queue Job, worker work, or binary database field.

- [X] T005 Extend the server-only MinIO provider with presigned POST-policy/GET, object-stat, bounded-object-read, private cleanup, and safe internal-to-browser endpoint conversion operations in `apps/web/src/lib/providers.ts`.
- [X] T006 Create signed, expiring, purpose-bound upload/view capability creation and verification with deterministic server object-key derivation in `apps/web/src/lib/upload-capability.ts`.
- [X] T007 Create Zod schemas that accept only Dataset id, safe filename, candidate content type, bounded size, and strict opaque `fileId` completion input in `apps/web/src/lib/validation/upload.ts`.
- [X] T008 Create bounded server-side signature/text MIME and modality detection, filename normalization, verified common metadata extraction, and safe failure mapping in `apps/web/src/lib/upload-verification.ts`.
- [X] T009 Create reusable safe direct-upload response projections that omit top-level storage keys, buckets, source URLs, credentials, encrypted values, and arbitrary object metadata; the minimal provider-required signed POST fields are transient-only in `apps/web/src/lib/asset-upload.ts`.
- [X] T010 [P] Create Compose-backed Prisma fixture helpers for owner, manager, read-only member, non-member, active Dataset, and isolated MinIO test-object cleanup in `apps/web/tests/direct-upload/helpers.ts`.

**Checkpoint**: Server-only capability, verification, provider, validation, authorization fixture, and safe-response primitives exist; no browser input can select object keys, ownership, modality, or credentials.

## Phase 3: User Story 1 — Upload into an Authorized Dataset (Priority: P1) 🎯 MVP

**Goal**: An authorized Dataset contributor can upload one supported image through a constrained URL and publish one ready Asset without leaking storage credentials or creating duplicate metadata on retry.

**Independent Test**: An owner/manager obtains a presigned URL, transfers a PNG to real MinIO, completes it, and observes one READY IMAGE Asset in the Dataset list. A read-only member gets `403`; a non-member gets `404`; both make no object or Prisma write.

### Tests for User Story 1

- [X] T011 [P] [US1] Write authenticated HTTP tests for `POST /api/assets/presigned-upload`, Dataset permission statuses, safe response fields, and denied-request Prisma/MinIO no-side-effects in `apps/web/tests/direct-upload/upload-routes.test.ts`.
- [X] T012 [P] [US1] Write real-MinIO round-trip tests for `POST /api/assets/complete-upload`, verified PNG publication, replayed completion, and HTTP Dataset asset-list visibility within ten seconds in `apps/web/tests/direct-upload/upload-routes.test.ts`.

### Implementation for User Story 1

- [X] T013 [US1] Implement idempotent verified IMAGE Asset publication with `AssetStatus.READY`, `sourceMode=UPLOAD`, server-derived actor/fingerprint/storage reference, ImageAsset creation, and safe private orphan cleanup in `apps/web/src/lib/asset-upload.ts`.
- [X] T014 [US1] Implement authorized, short-lived object-scoped presigned POST-policy issuance with exact key/type and configured-size constraints in `apps/web/src/app/api/assets/presigned-upload/route.ts` using `getSessionActor()` and `asset.upload`.
- [X] T015 [US1] Implement authorized upload completion, object verification, replay reconciliation, and safe failure responses in `apps/web/src/app/api/assets/complete-upload/route.ts`.
- [X] T016 [US1] Add a browser upload-flow client helper that sends only validated request fields, uses the returned constrained multipart POST capability transiently, then sends only opaque `fileId` in `apps/web/src/lib/client/direct-upload.ts`.
- [X] T017 [US1] Run the User Story 1 Compose-backed tests in `apps/web/tests/direct-upload/upload-routes.test.ts`; record any intentional status-code contract adjustments in `specs/006-direct-upload-multi-modal-metadata-rows/contracts/upload-api.md`.

**Checkpoint**: Image upload is independently usable and retry-safe; browser code has no MinIO credential or object-key construction logic.

## Phase 4: User Story 2 — Classify Uploaded Media and Create Matching Metadata Rows (Priority: P1)

**Goal**: A successful supported image, video, text, or audio upload is classified server-side and has exactly one matching child metadata row.

**Independent Test**: Upload one fixture of each supported modality to real MinIO and complete it; assert the verified Asset modality, safe common metadata, one correct child row, no other child rows, and `TextDocument.content=null`.

### Tests for User Story 2

- [X] T018 [P] [US2] Write detector tests for the four accepted modality fixtures, valid UTF-8 text, mismatched media, and browser MIME/extension conflicts in `apps/web/tests/direct-upload/upload-routes.test.ts`.
- [X] T019 [P] [US2] Write HTTP/Prisma integration tests for IMAGE/VIDEO/TEXT/AUDIO child-row exclusivity, `TextDocument.content=null`, and no published rows after verification denial in `apps/web/tests/direct-upload/upload-routes.test.ts`.

### Implementation for User Story 2

- [X] T020 [US2] Implement the conservative verified-type mapping for PNG/JPEG/WebP, MP4/WebM, UTF-8 plain text/CSV/JSON text, and WAV/MP3/Ogg in `apps/web/src/lib/upload-verification.ts`.
- [X] T021 [US2] Extend transactional Asset publication to create exactly one matching VideoAsset, TextDocument, or AudioAsset row and only safely verified optional metadata in `apps/web/src/lib/asset-upload.ts`.
- [X] T022 [US2] Ensure `POST /api/assets/complete-upload` rejects browser-supplied modality/owner/storage values and maps detector failures to the documented safe status/code contract in `apps/web/src/app/api/assets/complete-upload/route.ts`.
- [X] T023 [US2] Run the four-modality real-MinIO test matrix in `apps/web/tests/direct-upload/upload-routes.test.ts`.

**Checkpoint**: All initial supported modalities are server-classified and produce exactly one correct child row without storing a binary body in PostgreSQL.

## Phase 5: User Story 3 — Obtain an Authorized Asset Viewing Capability (Priority: P2)

**Goal**: An authorized Dataset member can receive a short-lived view URL for a verified Asset, while outsiders and unavailable objects receive no protected capability.

**Independent Test**: An authorized member receives a short-lived URL that reads the expected object; a read-only non-member cannot discover it, and an Asset with no verified object does not issue a URL.

### Tests for User Story 3

- [X] T024 [P] [US3] Write HTTP tests for authorized `GET /api/assets/[assetId]/view-url`, member/non-member status codes, safe response projection, and no credential/object-key field outside the signed URL in `apps/web/tests/direct-upload/upload-routes.test.ts`.

### Implementation for User Story 3

- [X] T025 [US3] Implement Dataset-scoped authorized view-capability issuance and unavailable-Asset handling in `apps/web/src/app/api/assets/[assetId]/view-url/route.ts`.
- [X] T026 [US3] Run the authorized and denied real-MinIO view tests in `apps/web/tests/direct-upload/upload-routes.test.ts`.

**Checkpoint**: Private object viewing is authorized through the Asset's Dataset and only the approved short-lived URL reaches the browser.

## Phase 6: Polish, Security, and Phase Validation

**Purpose**: Validate every cross-cutting invariant before reporting completion. Do not begin a later phase.

- [X] T027 [P] Add an end-to-end no-side-effect and replay suite covering `403`/`404`, expiry, object mismatch, repeat completion, and Asset/child/object counts with Prisma plus real MinIO in `apps/web/tests/direct-upload/upload-routes.test.ts` and `apps/web/tests/direct-upload/upload-capability.test.ts`.
- [X] T028 [P] Add a response/queue/log secret-boundary review test ensuring upload, completion, view, and Dataset asset-list outputs never expose top-level MinIO credentials, provider tokens, storage keys, buckets, source URLs, encrypted values, or `Job.input`; signed POST fields are transient-only in `apps/web/tests/direct-upload/upload-routes.test.ts`.
- [X] T029 Record direct-upload configuration names, Compose CORS validation, test results, and approved exception scope in `specs/006-direct-upload-multi-modal-metadata-rows/quickstart.md` and `specs/006-direct-upload-multi-modal-metadata-rows/contracts/upload-api.md`.
- [X] T030 Run `pnpm typecheck`, `pnpm --filter @fieldframe/web lint`, `pnpm --filter @fieldframe/web test:direct-upload`, and the Compose runtime validation from `specs/006-direct-upload-multi-modal-metadata-rows/quickstart.md`; record exact pass/fail results in that quickstart.
- [X] T031 Confirm and record that `prisma/schema.prisma`, `prisma/migrations/`, generated Prisma client, `apps/worker/`, queue contracts, Redis Job state, and modality-specific workspace routes remain unchanged in `specs/006-direct-upload-multi-modal-metadata-rows/quickstart.md`.
- [X] T032 Add a Compose-backed HTTP smoke assertion that a completed READY IMAGE Asset is returned by `GET /api/datasets/[datasetId]/assets` within ten seconds, including safe `BigInt` serialization in `apps/web/src/app/api/datasets/[datasetId]/assets/route.ts` and `apps/web/tests/direct-upload/upload-routes.test.ts`.

## Dependencies and Execution Order

```text
T001–T004 → T005–T010 → US1 (T011–T017) → US2 (T018–T023) → US3 (T024–T026) → T027–T031
```

- User Stories 1–3 all require the foundational capability, validation, provider, and verification boundary.
- US2 extends the US1 completion transaction from IMAGE to the remaining modalities; it must follow US1.
- US3 can begin after T005–T009, but is scheduled after US2 to validate the final published Asset shape once.
- No task may add a schema migration, new package, UploadIntent table, Job, queue payload, worker processing, raw SQL, browser credential, public bucket, or separate modality workspace route.

## Parallel Opportunities

- T002, T003, and T004 touch different configuration/test-script paths after the policy review.
- T005–T010 can proceed in parallel only where their file boundaries do not conflict; T006/T007 must be available before endpoint work.
- T011/T012, T018/T019, T024, T027, and T028 are independent test files and can be authored in parallel after their stated prerequisites.
- T014 and T016 can proceed in parallel after T006–T007; T015 waits for T013–T014.
- T020 and T021 touch separate detector/publication files and may proceed in parallel after their tests are written.

## Implementation Strategy

### MVP first

1. Complete setup and foundations.
2. Complete US1 only: real private image transfer, authorized capability issuance, idempotent completion, and safe Asset publication.
3. Stop and validate the US1 independent test before extending media support.

### Incremental delivery

1. US1 proves the secure direct-upload boundary with IMAGE.
2. US2 adds all remaining supported modalities and child-row invariants.
3. US3 adds authorized private object viewing.
4. Final validation proves no-side-effect, secret, idempotency, Compose CORS, and no-later-phase constraints.

## Notes

- Every task follows the required checklist format: checkbox, sequential ID, optional `[P]`, user-story label only in user-story phases, and exact file path.
- Tests must fail before the corresponding implementation task and use Prisma assertions instead of raw SQL.
- Do not request a new dependency during execution without explicit user approval that states purpose, existing alternative, and impact.
