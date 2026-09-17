# Tasks: TEXT Workspace Engine

**Input**: Design documents from `/specs/025-text-workspace-engine/`
**Prerequisites**: [plan.md](plan.md) (required), [spec.md](spec.md) (required for user stories), [research.md](research.md), [data-model.md](data-model.md), [contracts/](contracts/), [quickstart.md](quickstart.md)

**Status**: Revised task design for all ten requested corrections. This command changes planning documents only; application implementation and runtime acceptance remain pending.

**Tests**: Included and REQUIRED. FR-046 and SC-002/SC-004/SC-005/SC-006/SC-007/SC-008/SC-009 make real concurrency, browser, and regression evidence a completion requirement, not an optional extra — skipped tests must be reported as unverified, never silently omitted or presented as passing evidence.

**Organization**: Tasks are grouped by user story (spec.md priorities P1/P2/P3) so each story is independently implementable and testable, with one deliberate documented exception: Undo/Redo is built incrementally (core in US5, extended in US3, extended again in US4) because it can only cover commands that already exist. G1–G5 (spec.md "Dependencies and mandatory planning gates") are resolved in research.md/data-model.md; the Foundational phase below is where their concrete schema/service consequences land before any story begins.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies on incomplete tasks)
- **[Story]**: US1–US7, matching spec.md story numbers
- All descriptions include exact file paths (this is an existing pnpm monorepo — see plan.md "Project Structure")

## Path Conventions

- Web app (Next.js, browser-facing): `apps/web/src/...`, tests under `apps/web/tests/...`
- Private worker: `apps/worker/src/...`, tests under `apps/worker/tests/...`
- **Shared cross-app packages: `packages/domain/src/...`, `packages/queue/src/...`.** Canonical durable TEXT contracts (geometry, `schemaVersion`, `sourceIdentity`, offset unit, export-safe shapes, boundary-artifact schema, UTF-8 decode rules, source-limit policy) live here — never only in `apps/web`. Worker code (including export code) must import these from `packages/domain`, never from `apps/web/src/types`. `apps/web/src/types/text.ts` holds only UI/selection-only types (e.g. client selection-preview state, readiness UI wrappers) built on top of the canonical package.
- Shared schema: `prisma/schema.prisma`, `prisma/migrations/...`
- Public contract docs: `specs/api/openapi.yaml`

---

## Phase 1: Setup

**Purpose**: Confirm the repository and target environment are ready for Phase 025 work before any schema or code change lands.

- [X] T001 Inspect `git status` and the current feature checkout; reuse `025-text-workspace-engine` if present or create it from the current agreed base without discarding dirty work; record the actual branch and preserved changes in `specs/025-text-workspace-engine/research.md`.
- [X] T002 Run the target-deployment TEXT asset inventory (object-only / inline-only / both / neither / with-annotations counts) described in `specs/025-text-workspace-engine/research.md` G2 against the actual rollout database; record results in research.md's "Evidence and limits" table for migration preflight — do not proceed to T017 until this is current Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.
- [X] T003 Pin the deployment derivation profile and benchmark execution manifest in `specs/025-text-workspace-engine/verification/runtime-profile.md`; implement the deterministic test-only `apps/web/tests/text-performance/generate-reference-corpus.ts` from `specs/025-text-workspace-engine/benchmark/reference.json` and quickstart.md. Freeze expected source/config digests and runtime/image/browser versions; finalize the actual worker boundary-artifact digest in T030 after preparation exists for both T150 and T174; this prepares fixtures, not runtime latency acceptance.
- [X] T004 Define strict create/read custom-property and update propertyPatch schemas plus a pure merge/unset function in `packages/domain/src/text-properties-contract.ts` per data-model.md: only custom namespace, bounded scalar/null values, explicit deletion, reserved/unknown-key rejection and aggregate byte limits. Add `packages/domain/tests/text-properties.test.ts` for merge/delete/null/size/depth behavior and export via `packages/domain/src/index.ts`; reuse no permissive VIDEO property validator.

**Checkpoint**: Environment and rollout-target facts are current; Foundational work in Phase 2 can begin.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared domain contracts, schema, source-authority (read and write sides), transaction-guard, policy write lifecycle, and engine-registration infrastructure that every user story depends on (G1–G4 concrete implementation). No user story can be correctly implemented before this phase completes.

**⚠️ CRITICAL**: No user story work should begin until this phase is complete and the checkpoint below passes.

### 2A. Shared domain contracts (`packages/domain`) — build before any consumer imports them

- [X] T005 Define named TextSpanGeometry, TextDocumentGeometry, TextRelationGeometry, TextGeometry union, schema version, sourceIdentity, UTF16_CODE_UNIT and implement the pure safe annotation/export serializer with its input/output contract in `packages/domain/src/text-annotation-contract.ts`; exclude web/server imports and source excerpts. Web selection/UI wrappers may import these types but must not redefine canonical shapes.
- [X] T006 Define `TextBoundaryProfile`/`TextBoundaryArtifact` schema types (schemaVersion, algorithm, Node/ICU/Unicode profile, sourceIdentity, offsetUnit, sourceCodeUnitLength, sorted boundary offsets) in `packages/domain/src/text-boundary-contract.ts`, shared by worker artifact writing and web artifact validation
- [X] T007 Extract the shared fatal UTF-8 decode + BOM-handling pure function (per research.md D1: `ignoreBOM: true`, reject invalid UTF-8, never substitute malformed bytes) into `packages/domain/src/text-source-decode.ts`, so preparation (worker) and reads (web) use identical decode rules instead of duplicated logic
- [X] T008 Define `readTextSourceLimits(env)` in `packages/domain/src/text-source-limits.ts` using Zod and the proposed TEXT_WORKSPACE_MAX_SOURCE_BYTES, TEXT_WORKSPACE_MAX_CODE_UNITS and TEXT_WORKSPACE_MAX_ANNOTATIONS configuration names; centralize defaults 1048576/100000/5000 and validated positive upper bounds. Web/worker consumers and ordinary fixtures import this policy; boundary-value tests explicitly exercise overrides and invalid values (FR-042).
- [X] T009 Publish shared TEXT contracts through `packages/domain/src/index.ts`; add browser-safe export boundaries and cross-app import checks in `packages/domain/tests/text-contract.test.ts`, plus Unicode decode/config override fixtures in `packages/domain/tests/text-source.test.ts`. No worker import may resolve apps/web code (depends on T005, T006, T007, T008).

### 2B. Schema and migration (G2–G4)

**These six tasks edit the single `prisma/schema.prisma` file and MUST be applied as one coordinated, sequential set of edits — not run as parallel/independent work**, even though they touch non-overlapping model blocks.

- [X] T010 Add nullable verified-source fields to `TextAsset` in prisma/schema.prisma: `sourceIdentity`, `sourceEncoding`, `offsetUnit`, `sourceByteLength`, `sourceCodeUnitLength`, `boundaryArtifactKey`, `boundaryArtifactDigest`, `boundaryProfile` (Json), `preparedSourceFingerprint`, `preparedAt` — per data-model.md "Source document"
- [X] T011 Add `textPolicy` (Json), `textPolicyRevision` (Int, default 1), `textMutationRevision` (Int, default 0) fields to `Dataset` in prisma/schema.prisma — per data-model.md "Dataset taxonomy policy" (depends on T010)
- [X] T012 Add `AnnotationMutationReceipt` model to prisma/schema.prisma: `id`, `assetId`, `actorId`, `operationId`, `requestHash`, `result` (Json, bounded safe result only), `createdAt`; unique `(assetId, actorId, operationId)`; index on `assetId` — per data-model.md "Mutation receipts" (depends on T011)
- [X] T013 Add restrictive endpoint protection on `Annotation.fromAnnotationId`/`toAnnotationId` relations (`onDelete: Restrict`) and supporting indexes on both endpoint columns in prisma/schema.prisma — per data-model.md "Atomic command algorithm" (depends on T012)
- [X] T014 Add `TEXT_SOURCE_PREPARE` to the `JobType` enum in prisma/schema.prisma (depends on T013)
- [X] T015 Add `ANNOTATION_CHANGED` and `TEXT_POLICY_CHANGED` to the `CollaborationOutboxEventType` enum in prisma/schema.prisma (depends on T014)
- [X] T016 Run `pnpm run db:validate` (`prisma validate`) against the combined T010–T015 schema edits and fix any errors before proceeding (depends on T015) Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.
- [X] T017 Generate `prisma/migrations/<timestamp>_text_workspace_engine/migration.sql` with `pnpm exec prisma migrate dev --create-only` inside an isolated checkout/container and disposable PostgreSQL database. `prisma.config.ts` overrides DATABASE_URL from .env, so verify effective target identity without exposing its URL; exporting DATABASE_URL alone is insufficient. Review all SQL, including expected endpoint FK replacement from SetNull to Restrict; forbid destructive domain-data changes and test cleanup implications. Do not apply to shared review/production (depends on T002, T016).
- [X] T018 Apply the reviewed new migration from `prisma/migrations/<timestamp>_text_workspace_engine/migration.sql` to the disposable acceptance database and verify existing assets/ordered relation cleanup; retain deployment SQL/evidence for later rollout. Follow existing authorization for generated-file rewrites and shared-environment deployment; AGENTS.md does not itself require a new approval merely to add a migration (depends on T017).
- [X] T019 Regenerate the Prisma client (`pnpm run db:generate`) and update any files that import stale generated types (depends on T018) Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.

### 2C. Source authority: preparation and the boundary artifact (G1, G2)

- [X] T020 Implement UTF-16 code-unit + extended-grapheme boundary map computation in `apps/worker/src/source/text-boundary.ts`, matching the exact fixture table in research.md D1 (`OpenAI builds AI.`, `A😀B`, the combining-mark fixture `e` + U+0301, the precomposed accented fixture `é`, `👩‍💻`, `中文`, the BOM+CRLF fixture `U+FEFF, A, CR, LF, B, CR, C, LF`, empty string), using the `TextBoundaryProfile`/`TextBoundaryArtifact` types from T006 (depends on T006)
- [X] T021 Implement full-bounded UTF-8 decode + SHA-256 raw-byte digest verification in `apps/worker/src/source/text-source-verify.ts`, using the shared decode function from T007 and the shared limit policy from T008 (no locally duplicated numeric literals) (depends on T007, T008, T020)
- [X] T022 Add `TEXT_SOURCE_PREPARE` to `supportedQueueJobTypes` in `packages/queue/src/job-contract.ts` (transport payload stays `{jobId}` only) (depends on T014)
- [X] T023 Implement the `TEXT_SOURCE_PREPARE` worker processor in `apps/worker/src/jobs/text-source-prepare.processor.ts`: claim/attempt/terminal-state via the existing Job lifecycle, recheck source metadata at commit (reject a replaced source), write the boundary artifact to a private MinIO derivative under a deterministic source/profile key, and persist verified `TextAsset` metadata; leave source unchanged on failure (depends on T010, T019, T021)
- [X] T024 Register the `TEXT_SOURCE_PREPARE` processor in `apps/worker/src/queue/queue-router.ts` (depends on T022, T023)
- [X] T025 Wire shared validated limits into `apps/worker/src/config.ts`, server config used by `apps/web/src/lib/providers.ts`, readiness and `docker-compose.yaml` / `docker-compose.review.yaml`; document server-only names in `.env.example`. Register prepare support in all existing worker dispatch/retry/capability allowlists; test malformed settings and overridden limits before serving work (depends on T008, T024).
- [X] T026 Implement the server-only `apps/web/src/lib/annotations/text-boundary-loader.ts` using the real MinIO client from `apps/web/src/lib/providers.ts`, with bounded streaming reads. Verify artifact byte digest, schema/profile, asset-bound sourceIdentity, offsetUnit and source length; offsets must be sorted unique safe integers within bounds including 0/end. Cache only verified maps in a bounded LRU with TTL, keyed by dataset/asset/sourceIdentity/artifactDigest/profile; authorize and check current durable metadata on every call, including cache hits. Evict mismatch/replacement, never cache source text/errors/authorization or expose locators; do not use the local-file StorageProvider.get() fallback (depends on T006, T008, T019).
- [X] T027 Implement TEXT source readiness derivation (`UNPREPARED | PREPARING | READY | UNAVAILABLE | INVALID_ENCODING | SOURCE_MISMATCH | UNSUPPORTED_SIZE | LEGACY_RECONCILIATION_REQUIRED`) in `apps/web/src/lib/annotations/text-source-readiness.ts`, computed from verified metadata, object checks, and the latest relevant Job (depends on T010, T019)

### 2D. Authoritative TEXT source read service — the single place source-authority logic lives

- [X] T028 Implement `apps/web/src/lib/annotations/text-source-read-service.ts`: authorize dataset.read, resolve private source via existing MinIO providers, enforce T008 byte bound during streaming, fatal-decode via T007, recompute raw-byte SHA256 and compare sourceIdentity, verified lengths and preparedSourceFingerprint. Compose T026 boundary loader/T027 readiness; return exact safe source and supplied boundaries. No I/O inside annotation transactions: obtain verified immutable context before the transaction and recheck source/policy identity inside. Route Handlers only authenticate, invoke services and envelope responses (depends on T007, T008, T026, T027).
- [X] T029 Add and run `apps/web/tests/text-source/text-source-service.test.ts` and `text-boundary-loader.test.ts` for MinIO reads, fatal decode/BOM, raw digest versus fingerprint, lengths, corrupt/mismatched artifact profile/source, boundary limits, bounded stream abort, cache hit revocation/mismatch/expiry/eviction, and absence of leaked locators (depends on T026, T028).
- [X] T030 Add and run `apps/worker/tests/source/text-source-prepare.test.ts` for full Unicode fixtures, duplicate delivery, successor retry, replaced source during preparation, malformed/oversized source and metadata/artifact rollback; demonstrate web loader consumes exactly the worker artifact contract and finalize the benchmark boundary artifact/profile manifest against the T003 corpus (depends on T023, T028).

### 2E. Transactional invalidation foundation

- [X] T031 Add `ANNOTATION_CHANGED` (dataset/asset IDs + optional parent revision only) and `TEXT_POLICY_CHANGED` (dataset ID + policy revision only) dispatch through the existing collaboration outbox in `apps/web/src/lib/collaboration/collaboration-outbox-service.ts` (depends on T015)
- [X] T032 Add both new event types to the existing worker/gateway/client realtime allowlists (`apps/worker/src/jobs/collaboration-outbox-relay.ts` and the web realtime delivery layer under `apps/web/src/lib/realtime` and `apps/realtime/src/`) (depends on T031)

### 2F. Mutation transaction guard and receipts (G3, G4)

- [X] T033 Implement shared dataset guard and editable-asset command orchestration in `apps/web/src/lib/annotations/text-command-service.ts`: reauthorize, claim dataset guard, resolve receipt replay before any parent revision increment, then editable asset guard, revision/source/policy/ownership validation, command-level count admission/property validation, child writes and exactly one parent revision increment plus receipt/outbox atomically. Roll back all changes on failure and retry only transient serialization/uniqueness races. Expose dataset-only guarding separately for policy writes, which must not claim an arbitrary asset (depends on T005, T011, T012).
- [X] T034 Implement transaction-scoped count admission in `apps/web/src/lib/annotations/text-annotation-count.ts`, called by `text-command-service.ts` after receipt replay and dataset/asset guards: count current canonical TEXT annotations, calculate semantic command final count, permit delta<=0 even for legacy-over-limit assets; admit positive delta only when final count<=configured maximum. No reservation outside the transaction and no slot use on replay/update/relabel/delete; failed admission rolls back all revisions (depends on T008, T033).
- [X] T035 Implement canonical request hashing and receipt replay handling (distinguish omitted vs. explicit null, identical replay returns committed outcome without a new revision/event, changed payload under the same operation ID conflicts) in `apps/web/src/lib/annotations/text-mutation-receipt.ts` (depends on T012)
- [X] T036 Implement `apps/web/src/lib/annotations/safe-text-annotation.ts` as a web adapter over the shared T005 safe serializer and T028 source context; keep selected excerpts solely in the authorized in-memory inspector. Never require the worker serializer to depend on this web adapter (depends on T005, T028).
- [X] T037 Prove transaction primitives in `apps/web/tests/text-annotations/text-command-foundation.test.ts`: generic guarded-row operations under real Prisma Serializable transactions, stale revision rejection, immutable receipt replay, duplicate operation IDs, rollback after guard claim and no replay revision/outbox increment. Use transaction callbacks over fixtures, not unimplemented span/classification/relation commands. Command-specific replay-after-update/delete and races belong to their stories (depends on T033, T035, T036).

### 2G. Source-preparation authorization

- [X] T038 Implement the reviewed authorization decision in `apps/web/src/lib/annotations/text-source-prepare-service.ts`: dataset.read authorizes derivative preparation and subsequent source reads, independent of annotation.create and review freeze; resolve server-side immutable input and idempotently create/reuse one common Job per asset/source/profile, enqueue only jobId and reuse existing retry lineage. Recheck scope/archive/delete state; do not grant job.cancel/job.retry generally. `apps/web/src/lib/authorization.ts` currently grants REVIEWER annotation.create too, so test gate independence at the policy seam without inventing a production role. Existing media processing uses asset.upload and is a contrasting policy, not precedent for a dataset.read preparation grant (depends on T022, T023, T024).

### 2H. Taxonomy policy: read AND write lifecycle (G4)

- [X] T039 Implement Dataset TEXT policy read/validate service in `apps/web/src/lib/annotations/text-policy-service.ts`: parse `textPolicy` JSON (schemaVersion, classificationGroups, relationTypes), apply the implicit-SINGLE-group default when unset, and resolve eligible labels/groups/relation-type compatibility (depends on T011)
- [ ] T040 Update `apps/web/src/lib/workspace/label-management.ts`, `apps/web/src/lib/validation/label.ts` and generic `apps/web/src/app/api/labels/[labelId]/route.ts` mutations to validate TEXT eligibility and use the dataset-only guard. Reject referenced-label deletion/invalidating scope changes, validate existing dependents, increment textPolicyRevision and emit TEXT_POLICY_CHANGED atomically for relevant eligibility changes (depends on T039).
- [ ] T041 Extend the existing label management UI/actions (`apps/web/src/components/labels/label-form.tsx`, `apps/web/src/app/(app)/labels/actions.ts`, `apps/web/src/app/api/datasets/[datasetId]/labels/route.ts`) to accept and persist a TEXT eligibility scope (ENTITY / CLASSIFICATION / SENTIMENT / INTENT / RELATION) per label through normal authorized product use — no direct database seeding is required to create an eligible ENTITY label (depends on T040)
- [ ] T042 Implement `apps/web/src/lib/annotations/text-policy-write-service.ts` using the canonical PolicyWrite `{expectedRevision,policy}` input unchanged from HTTP through service and tests; label.manage and dataset-only guard validate references/dependents, compare expectedRevision with textPolicyRevision and commit policy/revision/TEXT_POLICY_CHANGED atomically without an asset-edit claim (depends on T011, T033, T039).
- [ ] T043 Implement `apps/web/src/app/api/datasets/[datasetId]/text-policy/route.ts`: GET requires dataset.read for annotators/reviewers; PUT requires label.manage and the T042 guarded writer. Return safe policy/revision/eligible labels; preserve concealed-resource responses and same-origin write protection (depends on T042).
- [ ] T044 Prove generic policy revision guards and policy-only stale-write/rollback behavior in `apps/web/tests/text-policy/text-policy-lifecycle.test.ts`, including dataset.read GET, label.manage PUT, canonical expectedRevision acceptance, expectedPolicyRevision alias rejection, invalid label references and atomic policy revision/outbox. Existing annotation fixtures may validate static refusal, but do not require policy-versus-annotation command races before those commands exist (depends on T040, T041, T042, T043).

### 2I. Engine registration and save contract (shared shell) — with immediate regression proof

- [ ] T045 Extend `apps/web/src/lib/workspace/workspace-engine-registry.tsx` to register real TEXT capabilities (read/select always; span/classification/relation gated on source readiness + policy + permissions + workflow state) instead of the placeholder entry
- [ ] T046 Define the active-engine flush(assetId) result contract in `apps/web/src/lib/workspace/workspace-engine-registry.tsx`; adapt existing IMAGE/VIDEO save modules and `apps/web/src/components/workspace/workspace-header.tsx` plus `properties-panel.tsx` callers immediately so success carries current asset revision and failure blocks Submit/navigation. Use capability adapters for not-yet-built TEXT persistence; never report dirty TEXT as saved (depends on T045).
- [ ] T047 Write and immediately run `apps/web/tests/workspace/image-video-flush-regression.test.ts` against T046 adapters AND callers: pending saves, failure/conflict, resulting current revision, Submit/Resubmit, previous/next, asset selection and late responses. Foundation cannot complete until this gate passes (depends on T046).
- [ ] T048 Extend `apps/web/src/lib/workspace/workspace-read.ts` and `apps/web/src/types/workspace.ts` so the generic workspace selection DTO carries TEXT source/annotation/revision/capability context instead of metadata-only fields, using the T005 canonical shapes for the underlying data (depends on T027, T005)
- [ ] T049 Create `apps/web/src/stores/text-annotation-store.ts` and UI-only `apps/web/src/types/text.ts` importing shared T005 shapes; provide asset-scoped saved snapshot/pending command state, supplied boundaries and ephemeral selection/search, with cleanup on scope change and no browser durable storage (depends on T005, T048).

**Checkpoint**: Shared domain contracts exist and are the single source of canonical TEXT shapes; schema is validated through the isolated-DB migration procedure, with shared rollout separately authorized; source can be prepared, read, and boundary-validated through one authoritative service with no duplicated logic; **foundation transaction primitives proven; command-specific race proof is deferred to each story and is not required for foundation completion**; TEXT policy is both readable and writable through an authorized route; source-preparation authorization is mapped to `dataset.read`; source limits come from one shared config module; the workspace engine registry recognizes TEXT with a flush contract that has **already been regression-tested against IMAGE/VIDEO**; and content/taxonomy invalidation events exist end to end. User story implementation can now begin.

---

## Phase 3: User Story 1 - Read and navigate the original document (Priority: P1) 🎯 MVP

**Goal**: An authorized member opens a TEXT asset and reads, selects, scrolls, and searches the original document in the shared workspace, with correct readiness/unavailable states and no partial-content illusion.

**Independent Test**: Open existing plain-text assets containing multilingual text, navigate between assets, search repeated phrases, and change display width; verify the document against its source without creating an annotation.

### Tests for User Story 1

- [ ] T050 [P] [US1] Contract test for `GET /api/assets/{assetId}/text` (READY / UNPREPARED / UNAVAILABLE / INVALID_ENCODING / SOURCE_MISMATCH / UNSUPPORTED_SIZE responses, `Cache-Control: private, no-store`, single call into text-source-read-service.ts with no duplicated authority logic in the route) in `apps/web/tests/text-source/text-read-route.test.ts`
- [ ] T051 [US1] Contract test in `apps/web/tests/text-source/text-prepare-route.test.ts`: dataset.read authorizes preparation of an unprepared source and ready reads, including review-frozen assets; assert no annotation.create check at the policy seam. Test 202 new/reused Job, 200 ready, 401 unauthenticated, 404 concealed nonmember/cross-dataset, and 403 only for a visible-resource capability denial. Current REVIEWER also has annotation.create; do not invent a role to claim otherwise.
- [ ] T052 [P] [US1] Integration test: open a TEXT asset with each Unicode fixture from research.md D1, confirm exact decoded text, search-and-move-between-matches, and distinct search-highlight-vs-annotation rendering in `apps/web/tests/text-source/text-reader-fixtures.test.ts`
- [ ] T053 [P] [US1] Integration test: removed-member and cross-dataset asset access returns the existing concealed-resource behavior with no source excerpt disclosed in `apps/web/tests/text-source/text-access-denial.test.ts`

### Implementation for User Story 1

- [ ] T054 [US1] Implement `GET /api/assets/{assetId}/text` Route Handler in `apps/web/src/app/api/assets/[assetId]/text/route.ts` as a thin caller of the T028 source read service — no source-authority logic in the route itself (depends on T028)
- [ ] T055 [US1] Implement `POST /api/assets/{assetId}/text/prepare` Route Handler in `apps/web/src/app/api/assets/[assetId]/text/prepare/route.ts`, gated on `dataset.read` per T038, creating/reusing a `TEXT_SOURCE_PREPARE` Job (depends on T023, T024, T038)
- [ ] T056 [US1] Implement the TEXT source read client in `apps/web/src/lib/workspace/text-read-client.ts` (fetch readiness/source/boundary projection, trigger prepare, poll Job status) (depends on T054, T055)
- [ ] T057 [US1] Replace the placeholder reader in `apps/web/src/components/workspace/text-engine.tsx` with escaped, selectable DOM text rendering (`white-space: pre-wrap`), a source-indexed segment table mapping DOM text-node offsets to original UTF-16 offsets, and readiness/unavailable states (depends on T056)
- [ ] T058 [US1] Implement search-within-document (literal Unicode match, move-between-matches, offset translation to original source, visually distinct from saved spans) in `apps/web/src/components/workspace/text-engine.tsx` (depends on T057)
- [ ] T059 [US1] Create `apps/web/src/components/workspace/text-status-fields.tsx` showing filename, supported encoding, source character count (declared unit), known language, and processing state, with missing values shown as unavailable rather than guessed (depends on T054)
- [ ] T060 [US1] Create `apps/web/src/components/workspace/text-properties-tabs.tsx` wiring Text Details (T059), Description, Responsibilities, and Workflow History into the existing properties region, replacing the TEXT branch of `placeholder-properties-tabs.tsx` (depends on T059)
- [ ] T061 [US1] Update `apps/web/src/components/workspace/properties-panel.tsx` to route TEXT assets to `apps/web/src/components/workspace/text-properties-tabs.tsx` (depends on T060)
- [ ] T062 [US1] Update `apps/web/src/components/workspace/text-toolbox.tsx` to remove the image-store coupling and bounding-box control, showing only capability-driven TEXT tools (read/select only at this stage) with a reason when a tool is unavailable (depends on T045)
- [ ] T063 [US1] Wire the generic workspace read path (T048) into `apps/web/src/components/workspace/text-engine.tsx` / `apps/web/src/components/workspace/text-toolbox.tsx` so capability gating reflects registry state (depends on T048, T057, T062)

**Checkpoint**: User Story 1 is fully functional and independently testable — TEXT assets open, read, search, and show correct readiness states with no annotation capability yet.

---

## Phase 4: User Story 2 - Create and refine spans and entity labels (Priority: P1)

**Goal**: An authorized annotator creates, labels, expands, shrinks, relabels, and deletes character spans with exact Unicode-safe boundaries; nested/overlapping spans remain individually addressable.

**Independent Test**: On an editable TEXT asset, create unlabeled and labeled spans, adjust boundaries, reload, and compare highlighted text and metadata against the original source.

### Tests for User Story 2

- [ ] T064 [P] [US2] Contract test for `POST /api/assets/{assetId}/text/annotations` `createSpan`/`updateSpan`/`deleteAnnotation` commands (envelope shape, strict unknown-field rejection, error codes 400/409/422) in `apps/web/tests/text-annotations/text-span-commands.test.ts`
- [ ] T065 [P] [US2] Integration test: create `OpenAI` span on `OpenAI builds AI.` and assert `startOffset=0, endOffset=6` in `apps/web/tests/text-annotations/text-span-offsets.test.ts`
- [ ] T066 [P] [US2] Integration test: full Unicode fixture matrix (create/save/reload/export) asserts identical original substring for every fixture in research.md D1, and rejects empty/reversed/out-of-bounds/fractional boundaries with no partial write, in `apps/web/tests/text-annotations/text-span-unicode-fixtures.test.ts`
- [ ] T067 [P] [US2] Integration test: geometry-only edits preserve label/properties and label/property-only edits preserve geometry; relation-identity preservation is exercised after relation commands exist in US4 (metadata isolation, FR-013) in `apps/web/tests/text-annotations/text-span-isolation.test.ts`
- [ ] T068 [P] [US2] Integration test: overlapping (`New York` / `New York University`) and same-range different-label spans remain separately selectable; exact same-range/same-label duplicate create is rejected or reconciled as a replay in `apps/web/tests/text-annotations/text-span-overlap.test.ts`
- [ ] T069 [P] [US2] Concurrency test: two editors starting from the same annotation revision race an incompatible update/delete; at most one succeeds via Prisma Serializable transaction + revision check against a real PostgreSQL instance, in `apps/web/tests/text-annotations/text-span-concurrency.test.ts`

### Implementation for User Story 2

- [ ] T070 [US2] Implement `apps/web/src/lib/annotations/text-span-service.ts` in `apps/web/src/lib/annotations/text-span-service.ts`: validate finite safe-integer endpoints, `0 <= start < end <= sourceCodeUnitLength`, membership in the T028 boundary projection, preserve whitespace, reject/reconcile duplicates per data-model.md "Canonical annotation shapes" (depends on T028, T033, T036)
- [ ] T071 [US2] Implement `createSpan`/`updateSpan`/`deleteAnnotation` command handling inside `apps/web/src/lib/annotations/text-command-service.ts` (T033), dispatching to `apps/web/src/lib/annotations/text-span-service.ts` and enforcing the atomic command algorithm (validate → guard → apply → bump revision → receipt → outbox) (depends on T033, T070)
- [ ] T072 [US2] After span commands exist, run real PostgreSQL replay-after-update/delete, span-write versus policy-write, limit-1, limit, simultaneous creates competing for the last slot, and replay-at-limit cases in `apps/web/tests/text-annotations/text-span-command-races.test.ts`; use independent connections/barriers and assert exact parent/child revisions and one receipt/outbox (depends on T071, T042, T034).
- [ ] T073 [US2] Wire the shared custom-property patch validator into span commands in `apps/web/src/lib/annotations/text-span-service.ts`; add stale revision/own-any permission/merge/unset/null tests in `apps/web/tests/text-annotations/text-properties.test.ts`. Preserve geometry, unrelated stored metadata and labels; property changes commit at the normal action boundary (depends on T004, T071).
- [ ] T074 [US2] Implement `GET /api/assets/{assetId}/text/annotations` and `POST /api/assets/{assetId}/text/annotations` Route Handlers in `apps/web/src/app/api/assets/[assetId]/text/annotations/route.ts` (depends on T071)
- [ ] T075 [US2] Implement authorized revision-consistent pagination for TEXT in `apps/web/src/lib/annotations/text-annotation-read-service.ts` and `/text/annotations/route.ts`: bounded pages, opaque cursor, total/count-limit capabilities, expectedAssetRevision on subsequent pages and 409 on snapshot change. Legacy count above admission limit remains readable; no silent truncation or full-document unsupported state solely due to annotation count (depends on T074, T034).
- [ ] T076 [US2] Integrate shared safe TEXT span/document/relation projection into `apps/web/src/lib/annotations/annotation-service.ts`, `safe-annotation.ts` and `apps/web/src/app/api/assets/[assetId]/annotations/route.ts`; preserve relation endpoint IDs and existing generic annotations envelope, add TEXT-only page metadata and reuse T075 pagination. No source excerpts/private storage fields and no IMAGE/VIDEO behavior/schema change (depends on T005, T036, T075).
- [ ] T077 [US2] Test generic reader modality dispatch in `apps/web/tests/annotation-api/text-generic-reader.test.ts`: fixture spans/documents/relations retain canonical fields/endpoints, authorization conceals resources, no source/storage leakage, unchanged IMAGE/VIDEO snapshots, and legacy-over-limit TEXT is fully traversable. Include snapshot-change pagination conflicts; document/relation fixtures test projection only, not unimplemented commands (depends on T076).
- [ ] T078 [US2] Implement the TEXT annotation mutation client (create/update/delete span, operation-ID generation/reuse for retries) in `apps/web/src/lib/workspace/text-annotation-client.ts` (depends on T074)
- [ ] T079 [US2] Extend `apps/web/src/lib/workspace/text-annotation-client.ts` and `apps/web/src/stores/text-annotation-store.ts` to accumulate paged TEXT snapshots consistently, show progressive loading/over-limit creation state, never mark a partial set complete and restart safely on revision conflict while preserving dirty intent. Virtualize/page the inspector for large legacy sets rather than rejecting reads (depends on T075, T078).
- [ ] T080 [US2] Implement client-side selection normalization in `apps/web/src/components/workspace/text-engine.tsx`: normalize reversed selections, snap outward to the **server-supplied grapheme boundary projection from T028/T056 only** (never recompute authoritative boundaries in the browser), show a preview before commit, reject collapsed selections, preserve whitespace-only selections (depends on T057, T078, T028)
- [ ] T081 [US2] Add span create/label/expand/shrink/relabel/delete controls to `apps/web/src/components/workspace/text-toolbox.tsx`, gated on eligible ENTITY labels from `apps/web/src/lib/annotations/text-policy-service.ts` (T039) and current permissions/source-readiness/workflow state (depends on T039, T062, T078)
- [ ] T082 [US2] Create `apps/web/src/components/workspace/text-annotation-list.tsx`: an accessible list/inspector exposing every overlapping annotation with label, range, and selected state, resolving nested/same-range ambiguity without relying on a drawn shape (depends on T078)
- [ ] T083 [US2] Wire `apps/web/src/components/workspace/text-annotation-list.tsx` and span controls into `apps/web/src/components/workspace/text-properties-tabs.tsx` (depends on T060, T082)
- [ ] T084 [US2] Create `apps/web/src/components/workspace/text-custom-properties-editor.tsx` and wire it into `text-properties-tabs.tsx`: typed key/value rows, explicit null, remove/unset, validation messages and own/any/frozen permission gating. Commit propertyPatch only on deliberate save/blur, integrate autosave and inverse patches once US5 lands; test keyboard edits in `apps/web/tests/text-annotations/text-properties-editor.test.ts` (depends on T073, T083).
- [ ] T085 [US2] Implement `apps/worker/src/jobs/text-export-serializer.ts` consuming only T005 domain contracts and extend `apps/worker/src/jobs/export-manifest.ts` / `export-selected-manifest.ts` with source metadata and span projection from a coherent Prisma snapshot; preserve IMAGE/VIDEO output. Add worker serializer contract fixtures in `apps/worker/tests/queue/text-export-manifest.test.ts` (depends on T005).

**Checkpoint**: User Stories 1 AND 2 both work independently — spans can be created, edited, and reloaded with verified Unicode-safe geometry.

---

## Phase 5: User Story 5 - Save safely and complete review or rework (Priority: P1)

**Goal**: TEXT edits autosave honestly, Submit/Resubmit waits for successful saves before using the current asset revision, conflicting/stale saves are never silently lost, and the asset reuses the existing Start/Submit/Review/Approve/Reject/Rework lifecycle with working Undo/Redo.

**Independent Test**: Seed a TEXT asset with annotations and two authorized actors; exercise Start, Submit, Open Review, Approve, Reject, Start Rework, and Resubmit, including a save conflict and a stale review decision.

**Scope note (P1 checkpoint independence)**: At this phase, Undo/Redo covers only span, label, and supported-property edits — the only command kinds that exist by this point. Classification and relation Undo/Redo are added later in US3 and US4 respectively (see those phases' "extend Undo/Redo" tasks). This phase's checkpoint does not depend on US3/US4 and must be validated using only span/label/property Undo/Redo.

### Tests for User Story 5

- [ ] T086 [P] [US5] Integration test: pending span edits + Submit waits for successful save and uses the resulting current asset revision; a failed/conflicting save blocks Submit and navigation with retry/reload/discard options, in `apps/web/tests/text-workflow/text-save-barrier.test.ts`
- [ ] T087 [P] [US5] Concurrency test: reviewer holding an earlier asset revision is refused via the existing review-staleness boundary after a concurrent annotation change commits, in `apps/web/tests/text-workflow/text-stale-review.test.ts`
- [ ] T088 [P] [US5] Integration test: NEEDS_REVIEW/REVIEWED/REJECTED reject prohibited TEXT mutations via both UI controls and direct requests (including Undo/Redo), while scrolling/searching/inspection/Discussion remain usable, in `apps/web/tests/text-workflow/text-review-frozen.test.ts`
- [ ] T089 [P] [US5] Integration test: reject → start rework → edit → resubmit preserves Workflow History and rejection feedback with no TEXT-specific workflow state, in `apps/web/tests/text-workflow/text-rework.test.ts`
- [ ] T090 [P] [US5] Integration test: Undo/Redo covers **span/label/property edits only** under current revision/permission, never undoes workflow/membership/Discussion/another user's committed change, and a conflicting inverse leaves durable content intact, in `apps/web/tests/text-workflow/text-undo-redo-core.test.ts`

### Implementation for User Story 5

- [ ] T091 [US5] Implement the TEXT `flush(assetId)` adapter (pending-save completion → `{ok:true, assetRevision}` / `{ok:false, reason}`) in `apps/web/src/lib/workspace/text-autosave.ts`, registered against the T046 active-engine contract (depends on T046, T078)
- [ ] T092 [US5] Update `apps/web/src/components/workspace/workspace-header.tsx` and `apps/web/src/components/workspace/properties-panel.tsx` to integrate the new TEXT adapter into the existing T046 active-engine save barrier for Submit/Resubmit, previous/next, properties navigation, asset-list selection and route-leave handling, preserving the already-tested IMAGE/VIDEO callers (depends on T091)
- [ ] T093 [US5] Implement pending/saving/saved/failed/conflict autosave state reporting at semantic action boundaries (not per-keystroke/selection/hover) in `apps/web/src/lib/workspace/text-autosave.ts`, and surface it through `apps/web/src/components/workspace/save-conflict-panel.tsx` for TEXT (depends on T091)
- [ ] T094 [US5] Verify the existing foundational editable-asset guard rejects frozen TEXT commands and inverse commands in `apps/web/src/lib/annotations/text-command-service.ts`; add missing regression assertions without postponing this enforcement from T033 (depends on T033).
- [ ] T095 [US5] Implement TEXT Undo/Redo **core** covering span, label, and supported-property edits only: bounded local per-asset command history, revision-checked inverse commands submitted as new commands (never a global snapshot rollback), in `apps/web/src/lib/workspace/text-workspace.ts` — designed to be extended, not to assume classification/relation commands exist yet (depends on T071, T091)
- [ ] T096 [US5] Add browser unload / navigate-away unsaved-work warning for dirty TEXT state, with no source/drafts persisted to browser storage, in `apps/web/src/components/workspace/text-engine.tsx` (depends on T091)
- [ ] T097 [US5] Confirm/adjust `apps/web/src/lib/workflow/asset-workflow-service.ts` Submit/Resubmit entry points consume the flushed current revision from T092 rather than a pre-save snapshot (depends on T092)
- [ ] T098 [US5] Immediately rerun and extend `apps/web/tests/workspace/image-video-flush-regression.test.ts` plus `apps/web/tests/text-workflow/text-save-barrier.test.ts` after all T091–T097 adapters/callers land; cover current revision, failure/conflict and every navigation path across IMAGE/VIDEO/TEXT. Do not advance to US3 with a failed shared-flow gate (depends on T047, T091, T092, T093, T096, T097).

**Checkpoint**: All three P1 stories (US1, US2, US5) are complete — this is the MVP: read, span-annotate, and safely save/review a TEXT asset end to end, with Undo/Redo correctly scoped to the commands that exist at this point.

---

## Phase 6: User Story 3 - Classify a document using its taxonomy (Priority: P2)

**Goal**: Document-level classification (including configured sentiment) with explicit scope, atomic single-label replacement, explicit multi-label policy, and no interference with span annotations.

**Independent Test**: Use datasets configured for single-label and multi-label classification; create, replace, remove, and reload classifications without creating spans.

### Tests for User Story 3

- [ ] T099 [P] [US3] Contract test for `replaceClassification`/`updateClassification` commands (complete expected-members set required, SINGLE allows 0 or 1) in `apps/web/tests/text-annotations/text-classification-commands.test.ts`
- [ ] T100 [P] [US3] Integration test: SINGLE-cardinality replacement is atomic and a stale replacement cannot remove a newer category, in `apps/web/tests/text-annotations/text-classification-single.test.ts`
- [ ] T101 [P] [US3] Integration test: explicit MULTI-label policy allows independently-removable distinct categories that survive reload; duplicate category membership is rejected, in `apps/web/tests/text-annotations/text-classification-multi.test.ts`
- [ ] T102 [P] [US3] Integration test: with no sentiment taxonomy configured, the toolbox offers no sentiment controls; with one configured, sentiment behaves like ordinary classification, in `apps/web/tests/text-annotations/text-sentiment.test.ts`
- [ ] T103 [P] [US3] Integration test: editing/removing a document classification does not implicitly change spans and vice versa, in `apps/web/tests/text-annotations/text-classification-isolation.test.ts`
- [ ] T104 [P] [US3] Integration test: Undo/Redo extended to cover classification replace/update, still never touches spans/relations/workflow, in `apps/web/tests/text-workflow/text-undo-redo-classification.test.ts`

### Implementation for User Story 3

- [ ] T105 [US3] Implement `apps/web/src/lib/annotations/text-classification-service.ts` with document geometry, group membership, source identity, ownership and SINGLE/MULTI cardinality using shared T005 contract, T039 policy and T033 transaction foundation; no import/dependency on text-span-service.ts (depends on T005, T028, T039, T033).
- [ ] T106 [US3] Implement `replaceClassification`/`updateClassification` command handling in `apps/web/src/lib/annotations/text-command-service.ts`, requiring the complete current group membership `{id,revision}` set for replacement (depends on T033, T105)
- [ ] T107 [US3] Run real PostgreSQL classification replacement races and policy-versus-classification writes in `apps/web/tests/text-annotations/text-classification-races.test.ts`, including swap at limit, shrinking legacy-over-limit groups, rejected net-growth, receipt replay and conflict rollback. Validate concrete commands only now (depends on T106, T042, T034).
- [ ] T108 [US3] Wire document propertyPatch updates through the shared validator and `text-custom-properties-editor.tsx`; test merge/unset/null in `apps/web/tests/text-annotations/text-classification-properties.test.ts` ; history coverage is executed at the existing US3 history checkpoint (depends on T106, T084).
- [ ] T109 [US3] Extend the `POST /api/assets/{assetId}/text/annotations` handler (T074) to dispatch classification commands (depends on T074, T106) Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.
- [ ] T110 [US3] Extend `apps/web/src/lib/workspace/text-annotation-client.ts` with classification create/replace/remove methods (depends on T078, T109)
- [ ] T111 [US3] Add document classification controls (including sentiment when configured) to `apps/web/src/components/workspace/text-toolbox.tsx`, gated on eligible CLASSIFICATION/SENTIMENT labels and groups (depends on T081, T110)
- [ ] T112 [US3] Add a classification section to `apps/web/src/components/workspace/text-annotation-list.tsx` / `apps/web/src/components/workspace/text-properties-tabs.tsx` showing current group membership and cardinality (depends on T082, T111)
- [ ] T113 [US3] Add optional `text` document-classification projection to `apps/worker/src/jobs/text-export-serializer.ts` from T085, using the T005 canonical shapes (depends on T085, T105) Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.
- [ ] T114 [US3] Create `apps/web/src/components/labels/text-classification-policy-panel.tsx` and integrate it in `apps/web/src/app/(app)/labels/page.tsx`; Owner/Manager configure groups/cardinality/member labels through T043, handle revision conflicts and invalid references, and refresh policy after save. No direct DB seeding required (depends on T041, T043).
- [ ] T115 [US3] Extend Undo/Redo (`apps/web/src/lib/workspace/text-workspace.ts`, T095) to cover classification replace/update inverse commands, now that classification commands exist (depends on T095, T106)
- [ ] T116 [US3] Run the classification suite including `apps/web/tests/text-workflow/text-undo-redo-classification.test.ts` and UI-only policy setup through `text-classification-policy-panel.tsx`; verify inverse replacement after a remote change conflicts safely (depends on T104, T106, T114, T115).

**Checkpoint**: US1, US2, US5, and US3 all work independently — classification is fully usable alongside spans, and Undo/Redo now covers span/label/property/classification.

---

## Phase 7: User Story 4 - Describe relations between annotated entities (Priority: P2)

**Goal**: Directed, typed relations between two compatible same-document spans, with referential integrity preserved under concurrent edits and endpoint deletion blocked until relations are explicitly removed.

**Independent Test**: With two preexisting spans and an eligible relation taxonomy, create, retarget, relabel, and delete a relation; exercise endpoint deletion and concurrent modification.

### Tests for User Story 4

- [ ] T117 [P] [US4] Contract test for `createRelation`/`updateRelation` commands (both endpoint expected revisions required; strict unknown-field rejection) in `apps/web/tests/text-annotations/text-relation-commands.test.ts`
- [ ] T118 [P] [US4] Integration test: relation references endpoint identities and a configured type without copying ranges; endpoint boundary change retains relation identity and shows the updated range, in `apps/web/tests/text-annotations/text-relation-identity.test.ts`
- [ ] T119 [P] [US4] Integration test: self-relation, duplicate directed pair/type, missing endpoint, incompatible endpoint label, and cross-asset/cross-dataset endpoint are all rejected with no dangling relationship, in `apps/web/tests/text-annotations/text-relation-rejection.test.ts`
- [ ] T120 [P] [US4] Concurrency test: span deletion is refused while a relation references it; concurrent relation-create and span-delete cannot both succeed leaving a dangling reference, against real PostgreSQL, in `apps/web/tests/text-annotations/text-relation-endpoint-race.test.ts`
- [ ] T121 [P] [US4] Integration test: with no eligible relation taxonomy configured, relation creation is unavailable with an understandable reason rather than hardcoded relation types, in `apps/web/tests/text-annotations/text-relation-no-taxonomy.test.ts`
- [ ] T122 [P] [US4] Integration test: Undo/Redo extended to cover relation create/update/delete, still never touches unrelated spans/classifications/workflow, in `apps/web/tests/text-workflow/text-undo-redo-relation.test.ts`

### Implementation for User Story 4

- [ ] T123 [US4] Implement `text-relation-service.ts` in `apps/web/src/lib/annotations/text-relation-service.ts`: same-dataset/asset/source endpoint validation (via generic `Annotation` reads, not `apps/web/src/lib/annotations/text-span-service.ts` business logic), directed `(asset, source, from, to, relationLabel)` uniqueness, endpoint-compatibility check against `apps/web/src/lib/annotations/text-policy-service.ts` (T039) relation types — **no dependency on `apps/web/src/lib/annotations/text-span-service.ts`**, for the same reason as T105 (depends on T039, T033)
- [ ] T124 [US4] Implement `createRelation`/`updateRelation`/relation `deleteAnnotation` command handling in `apps/web/src/lib/annotations/text-command-service.ts`, including the referenced-span-deletion block enforced by the T013 restrictive FK plus an explicit service-level check (depends on T013, T033, T123)
- [ ] T125 [US4] Extend the span relabel path in `apps/web/src/lib/annotations/text-span-service.ts` to revalidate every incoming/outgoing attached relation inside the same guarded transaction: acquire shared dataset→asset write guards before reading relation rows, validate candidate label against each relation type and other endpoint, and reject atomically if any would be invalid. All relation creation/update/deletion uses the same guards, preventing phantoms; no raw SQL FOR UPDATE. Failure changes no span, relation, asset revision, receipt or outbox (depends on T070, T123, T124).
- [ ] T126 [US4] Add and run `apps/web/tests/text-annotations/text-endpoint-relabel.test.ts` against real PostgreSQL: a relabel incompatible with any attached relation fails; mixed incoming/outgoing relation types and a compatible relabel preserve relation identities/revisions. Assert unchanged entire durable state on rejection (depends on T125).
- [ ] T127 [US4] Add and run independent-connection/barrier PostgreSQL relabel-versus-relation-create races in `apps/web/tests/text-annotations/text-endpoint-relabel-race.test.ts`; every serialization commits only compatible states or returns conflict, with rollback assertions and both interleavings exercised (depends on T125).
- [ ] T128 [US4] Run relation command/policy races, duplicate creation/retarget races, at-limit create/replay and relation propertyPatch merge/unset/null cases in `apps/web/tests/text-annotations/text-relation-command-races.test.ts`; wire the shared property editor to relation inspection and validate concrete commands after T124 (depends on T124, T042, T034, T084).
- [ ] T129 [US4] Extend the `POST /api/assets/{assetId}/text/annotations` handler (T074) to dispatch relation commands (depends on T074, T124) Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.
- [ ] T130 [US4] Extend `apps/web/src/lib/workspace/text-annotation-client.ts` with relation create/retarget/relabel/delete methods (depends on T078, T129)
- [ ] T131 [US4] Create `apps/web/src/components/workspace/text-relation-builder.tsx`: source/target span pickers, eligible relation-type selection, inspector navigation to both endpoints without depending on a drawn connector (depends on T082, T130)
- [ ] T132 [US4] Wire `apps/web/src/components/workspace/text-relation-builder.tsx` into `apps/web/src/components/workspace/text-toolbox.tsx` / `apps/web/src/components/workspace/text-properties-tabs.tsx`, hidden with a stated reason when no eligible relation taxonomy exists (depends on T111, T131)
- [ ] T133 [US4] Add optional `text` relation projection to `apps/worker/src/jobs/text-export-serializer.ts`, using the T005 canonical shapes, failing the export safely if a relation does not resolve within the exported set (depends on T085, T123) Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.
- [ ] T134 [US4] Create `apps/web/src/components/labels/text-relation-policy-panel.tsx` integrated beside the classification panel in `apps/web/src/app/(app)/labels/page.tsx`; Owner/Manager edit relation labels, compatible endpoint sets and unlabeled options through T043 with safe conflicts/errors. No direct DB seeding required (depends on T041, T043, T114).
- [ ] T135 [US4] Extend Undo/Redo (`apps/web/src/lib/workspace/text-workspace.ts`, T115) to cover relation create/update/delete inverse commands, now that relation commands exist (depends on T115, T124)
- [ ] T136 [US4] Run the relation suite including `apps/web/tests/text-workflow/text-undo-redo-relation.test.ts` and UI-only relation configuration; verify endpoint-delete races, guarded inverses and exported endpoint closure in `apps/worker/tests/queue/text-export-manifest.test.ts` (depends on T120, T122, T133, T134, T135).

**Checkpoint**: US1, US2, US5, US3, and US4 all work independently — spans, classification, and relations are each fully usable, and Undo/Redo now covers every command kind delivered in this phase.

---

## Phase 8: User Story 6 - Collaborate in the existing workspace (Priority: P2)

**Goal**: TEXT assets participate in existing Responsibilities, Discussion, Activity, notifications, and presence without a second collaboration system, and without leaking source/selection content through realtime or presence.

**Independent Test**: Assign an annotator and reviewer to a TEXT asset, open two sessions, add Discussion, change workflow, and verify Activity, Bell, revocation, and presence using existing collaboration fixtures.

### Tests for User Story 6

- [ ] T137 [P] [US6] Integration test: owner assigns annotator/reviewer Responsibilities to a TEXT asset and existing role/assignment/notification policies apply exactly as for other assets, in `apps/web/tests/text-collaboration/text-responsibilities.test.ts`
- [ ] T138 [P] [US6] Integration test: Discussion/Activity on a TEXT asset use the existing asset conversation and read-only activity projection; annotation custom properties are never used as Discussion storage, in `apps/web/tests/text-collaboration/text-discussion.test.ts`
- [ ] T139 [P] [US6] Integration test: `ANNOTATION_CHANGED`/`TEXT_POLICY_CHANGED` invalidation on reconnect converges authorized reads on durable state without silently replacing unsaved local drafts, in `apps/web/tests/text-collaboration/text-invalidation.test.ts`
- [ ] T140 [P] [US6] Integration test: presence payloads during TEXT editing contain only VIEWING/EDITING awareness and authorized identity/scope — never source text, selected text, offsets, draft content, endpoints, cursors, or search queries, in `apps/web/tests/text-collaboration/text-presence-privacy.test.ts`
- [ ] T141 [P] [US6] Integration test: membership removal or role downgrade denies further protected TEXT reads/writes/realtime access immediately, with stale UI/presence granting nothing, in `apps/web/tests/text-collaboration/text-revocation.test.ts`

### Implementation for User Story 6

- [ ] T142 [US6] Confirm/extend `apps/web/src/lib/collaboration` Responsibilities assignment and notification wiring covers TEXT assets with no TEXT-specific code path (depends on T031)
- [ ] T143 [US6] Confirm `apps/web/src/components/workspace/discussion-drawer.tsx` and the read-only Activity projection render correctly for TEXT assets without modification beyond generic modality support (depends on T060)
- [ ] T144 [US6] Extend `apps/web/src/components/workspace/use-collaboration-realtime.ts` to handle `ANNOTATION_CHANGED`/`TEXT_POLICY_CHANGED`: clean local state applies newer snapshots, dirty state preserves intent and marks a conflict instead of overwriting it (depends on T032, T091)
- [ ] T145 [US6] Extend `apps/web/src/components/workspace/use-workspace-presence.ts` so TEXT reader focus/selection reports semantic VIEWING/EDITING only, never selection ranges or content, and is never treated as a lock (depends on T057)
- [ ] T146 [US6] Confirm revoked-membership denial reaches the TEXT read/prepare/annotations routes (T054, T055, T074) and clears protected client state on revocation (depends on T054, T055, T074, T145) Record evidence in `specs/025-text-workspace-engine/verification/checks.md`.

**Checkpoint**: US1–US6 all work independently — TEXT is a first-class participant in the existing collaboration system with no content leakage.

---

## Phase 9: User Story 7 - Inspect efficiently with keyboard and structural views (Priority: P3)

**Goal**: Full keyboard operability for reading, span/classification/relation CRUD, and review inspection; an offset inspector that never disguises byte/display positions as character offsets; optional deterministic structural views that never gain saved-geometry authority; unambiguous selection of overlapping annotations.

**Independent Test**: Complete span, classification, and relation operations using keyboard controls on the reference document set; compare source ranges before and after display and structural-view changes.

### Tests for User Story 7

- [ ] T147 [P] [US7] Integration test: keyboard-only completion of reading/search, span CRUD, classification CRUD, relation CRUD, and review inspection, with focus/action names available and no accidental Submit/Approve trigger while typing/selecting, in `apps/web/tests/text-accessibility/text-keyboard-only.test.ts`
- [ ] T148 [P] [US7] Integration test: with no authoritative tokenizer/segmenter, durable token/sentence/paragraph indexes are not offered; any explicitly identified view-only tokenization cannot be saved as geometry, in `apps/web/tests/text-accessibility/text-structure-absence.test.ts`
- [ ] T149 [P] [US7] Integration test: nested/same-range annotations remain unambiguously selectable via the annotation list/text labels/focus affordances without relying only on color, in `apps/web/tests/text-accessibility/text-overlap-disambiguation.test.ts`
- [ ] T150 [US7] Implement and run `apps/web/tests/text-performance/text-reference-document.test.ts` using only `specs/025-text-workspace-engine/benchmark/reference.json` and the single fixture generator owned by T003. Follow quickstart.md hardware, topology, browser, cache/warmup and timing protocol; produce exactly 100 open and 100 interaction measurements, nearest-rank p95 and threshold counts. Record correctness failures separately from latency failures; both block acceptance (depends on T003).

### Implementation for User Story 7

- [ ] T151 [US7] Add visible focus states, accessible names, and keyboard operability to `apps/web/src/components/workspace/text-engine.tsx` selection/search and `apps/web/src/components/workspace/text-toolbox.tsx` span/classification/relation controls (depends on T080, T111, T131)
- [ ] T152 [US7] Extend `apps/web/src/components/workspace/use-workflow-shortcuts.ts` to suppress Submit/Approve shortcuts while typing, selecting, or actively building a TEXT range/relation (depends on T080)
- [ ] T153 [US7] Create `apps/web/src/components/workspace/text-offset-inspector.tsx` showing the current selection's offset unit explicitly, distinguishing it from byte positions/display columns (depends on T057)
- [ ] T154 [US7] Implement deterministic token/sentence/paragraph view gating in `apps/web/src/lib/annotations/text-structure-service.ts`: only expose indexes when segmentation is authoritative and reproducible (per G5, none is authoritative in this delivery — implement the absence/guard path, not a tokenizer) (depends on T027)
- [ ] T155 [US7] Ensure `apps/web/src/components/workspace/text-annotation-list.tsx` (T082) provides distinguishing labels/order for same-range/nested annotations beyond color, satisfying SC-006 (depends on T082)
- [ ] T156 [US7] Address any performance findings from T150 in `apps/web/src/components/workspace/text-engine.tsx` rendering (derived-interval highlighting, not per-annotation document copies, per contracts/workspace.md "UI and active-engine contract") (depends on T150)

**Checkpoint**: All 7 user stories are independently functional and accessible.

---

## Phase 10: Polish & Cross-Cutting Concerns

**Purpose**: Contract documentation, database/build/deployment gates, and full regression proof required by FR-045/FR-046/SC-009 before this phase is reported complete. **Skipped integration tests are UNVERIFIED, not passing evidence** — every task below must report executed-passing / failed / unexecuted-skipped explicitly.

- [ ] T157 Merge validated routes/schemas from specs/025-text-workspace-engine/contracts/openapi.yaml into specs/api/openapi.yaml (depends on T054, T055, T074, T043 being final)
- [ ] T158 Run `pnpm run docs:validate-openapi` against the merged spec and fix any errors (depends on T157) Record evidence in `specs/025-text-workspace-engine/verification/openapi-validation.md`.
- [ ] T159 Run `pnpm run docs:bundle-openapi` to regenerate the published bundle (depends on T158) Record evidence in `specs/025-text-workspace-engine/verification/openapi-bundle.md`.
- [ ] T160 Run `pnpm run docs:swagger-ui` and the existing `apps/web/tests/openapi-contract/` tests after bundling; record validation/bundle/UI generation separately in `specs/025-text-workspace-engine/verification/openapi.md` (depends on T157, T158, T159).
- [ ] T161 Re-run `pnpm run db:validate` (`prisma validate`) as a final closure gate, confirming the final Prisma schema remains valid after code-review edits since T016; this is not a database drift check (depends on T019) Record evidence in `specs/025-text-workspace-engine/verification/prisma-validation.md`.
- [ ] T162 Run `pnpm exec prisma migrate status` against the isolated acceptance deployment and record applied/pending results in `specs/025-text-workspace-engine/verification/migration-status.md`; record target rollout status separately when authorized. Do not claim migrate status proves absence of schema drift (depends on T018).
- [ ] T163 Run `pnpm run typecheck` (root — covers `@annotationplatform/web`, `worker`, `domain`, `queue`, `realtime`) Record evidence in `specs/025-text-workspace-engine/verification/typecheck.md`.
- [ ] T164 Run `pnpm run lint` (root, same package set) Record evidence in `specs/025-text-workspace-engine/verification/lint.md`.
- [ ] T165 Run `pnpm run build` (production build of domain → queue → web → worker) Record evidence in `specs/025-text-workspace-engine/verification/production-build.md`.
- [ ] T166 Validate normal Compose with `docker compose -f docker-compose.yaml config --quiet` and approved isolated smoke boot; check new validated config reaches web/worker and pin boundary runtime. Record service health in `specs/025-text-workspace-engine/verification/compose-normal.md`; never print resolved Compose config containing credentials.
- [ ] T167 Validate review Compose with `docker compose -f docker-compose.review.yaml config --quiet` and isolated review-profile smoke boot; record health in `specs/025-text-workspace-engine/verification/compose-review.md`. Do not sync or mutate shared review data.
- [ ] T168 Run the dedicated TEXT PostgreSQL concurrency suite as one aggregate report (T069 span concurrency, T087 stale-review, T120 endpoint-race, and any others) against a real PostgreSQL instance Record evidence in `specs/025-text-workspace-engine/verification/concurrency.md`.
- [ ] T169 Run `pnpm --filter @annotationplatform/realtime test` from `apps/realtime/package.json` plus US6 and existing non-TEXT collaboration suites against real isolated services; record executed/failed/skipped results in `specs/025-text-workspace-engine/verification/realtime.md`.
- [ ] T170 Run the production-style multi-user browser acceptance pass: quickstart.md's full scenario set (all 7 scenarios) with two real concurrent browser sessions against a real PostgreSQL/Redis/MinIO/worker environment Record evidence in `specs/025-text-workspace-engine/verification/browser-acceptance.md`.
- [ ] T171 Run existing IMAGE/VIDEO and Phase 022/023/024 acceptance suites for shared surfaces (Asset Browser, workspace header/navigation, properties panel, workflow, collaboration, exports) and confirm no regression beyond the T047 baseline (SC-009) (depends on T047) Record evidence in `specs/025-text-workspace-engine/verification/image-video-regression.md`.
- [ ] T172 Run one combined Undo/Redo regression exercising span, label, property, classification, and relation edits together in a single editing session, confirming no cross-kind interference (depends on T095, T115, T135) Record evidence in `specs/025-text-workspace-engine/verification/undo-redo-combined.md`.
- [ ] T173 Security review pass: confirm no MinIO/Redis/DB credentials, boundary-artifact keys, or raw upstream diagnostics are reachable from browser responses, logs, queue payloads, or exports across all new TEXT code paths (AGENTS.md "Security rules") Record evidence in `specs/025-text-workspace-engine/verification/security.md`.
- [ ] T174 Run final SC-005/SC-006 acceptance using the same `specs/025-text-workspace-engine/benchmark/reference.json`, generator and corpus digest as T150; store raw samples and separate correctness/performance/keyboard verdicts in `specs/025-text-workspace-engine/verification/performance-accessibility.md`. Reject changed fixture/config digests or environment mismatch rather than generating another reference document (depends on T147, T150, T156, T170).
- [ ] T175 Consolidate dedicated gate evidence and files/commands/environment/migration/limitations/next-phase report in `specs/025-text-workspace-engine/verification/summary.md`; update feature research for implementation decisions and flag architecture drift explicitly rather than rewriting Phase 0 authority to match accidental drift. Do not declare completion with required skipped/failed checks.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately.
- **Foundational (Phase 2)**: Depends on Setup (specifically T002's target inventory before T017 generates a migration). BLOCKS all user stories. Internally ordered: contracts/config → sequential schema validation → source writer/reader and tests → outbox → command/receipts → preparation authorization → policy lifecycle → engine adapters and immediate regression. Consumers follow their contracts; no runtime test gate precedes its required implementation.
- **User Stories (Phase 3+)**: All depend on Foundational completion.
  - US1, US2, US5 are P1 and form the MVP; implement in that order since US2 needs a readable/prepared source (US1) and US5 needs saveable content (US2) to be meaningfully testable, even though each has its own independent test.
  - US3 and US4 (P2) depend on Foundational + the shared command route introduced in US2 (T074) + the shared policy route (T043); their domain services do not depend on each other; shared UI/dispatch/export/history edits are scheduled serially.
  - **Deliberate cross-story exception**: US3's Undo/Redo extension (T115) depends on US5's Undo/Redo core (T095), and US4's Undo/Redo extension (T135) depends on US3's (T115). This is intentional — Undo/Redo can only cover commands that already exist — and full history acceptance follows that order. Domain service tests remain independent; complete story checkpoints include their history extension.
  - US6 (P2) depends on Foundational's invalidation wiring (T031/T032) and benefits from US5's flush contract (T091) but does not require US3/US4.
  - US7 (P3) depends on US2/US3/US4's controls existing to be keyboard-tested, and on Foundational's source/boundary work for the offset inspector.
- **Polish (Phase 10)**: Depends on all seven required user stories being complete.

### Within Each User Story

- Contract/integration tests are written before the implementation they cover and must fail first.
- Service layer (`text-*-service.ts`) before command-service wiring before routes before clients before UI.
- Story complete before moving to the next priority, per the Implementation Strategy below.

### Parallel opportunities and examples per story

Only independent **test authoring** has [P]. All implementation tasks execute sequentially unless a future plan explicitly separates their files. Tests may be authored before a service exists; the story checkpoint requires them executed and passing after implementation. Parallel test execution requires separate database/object fixtures, not shared destructive setup. Closure build/typecheck/Compose/browser gates are sequential because they share generated artifacts and deployment state.

| Story | Safe parallel authoring examples | Prerequisite / independent checkpoint |
| --- | --- | --- |
| US1 | `text-read-route.test.ts` and `text-access-denial.test.ts` | Foundation; open/read/search exact source including reviewer-triggered preparation. |
| US2 | `text-span-offsets.test.ts` and `text-span-concurrency.test.ts` | US1; span CRUD/overlap with exact saved ranges. |
| US5 | `text-save-barrier.test.ts` and `text-undo-redo-core.test.ts` | US2; span/label/property save, review/rework and inverse commands only. |
| US3 | `text-classification-single.test.ts` and `text-classification-multi.test.ts` | Command/policy foundation and US5 history; document-only classification without a span service dependency. |
| US4 | `text-relation-identity.test.ts` and `text-relation-endpoint-race.test.ts` | Span identities and command/policy foundation; same-source relations and guarded inverses. |
| US6 | `text-presence-privacy.test.ts` and `text-revocation.test.ts` | Shared delivery and save integration; authorized collaboration/reconnect/revocation. |
| US7 | `text-structure-absence.test.ts` and `text-overlap-disambiguation.test.ts` | All delivered controls; keyboard CRUD and exact structural absence/offset behavior. |

All examples live in their task's explicit `apps/web/tests/...` path. Shared command dispatch, client, toolbox, export serializer and history modules are edited serially across stories; distinct service files alone do not make entire stories parallel.

---

## Implementation Strategy

### MVP First (User Stories 1, 2, 5 only)

1. Complete Phase 1: Setup.
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories; includes the immediate IMAGE/VIDEO flush regression proof at T047).
3. Complete Phase 3: User Story 1 — **STOP and VALIDATE** independently (open/read/search a TEXT asset).
4. Complete Phase 4: User Story 2 — **STOP and VALIDATE** independently (create/edit spans with verified Unicode fixtures).
5. Complete Phase 5: User Story 5 — **STOP and VALIDATE** independently (save/Submit/Approve/Reject/Rework/Undo, scoped to span/label/property).
6. This is the MVP: a reviewable, revision-safe, Unicode-correct manual span-annotation engine for TEXT.

### Incremental Delivery

1. Setup + Foundational → foundation ready (schema, source read/write authority, policy read/write mechanism, flush contract with regression proof).
2. US1 → US2 → US5 → MVP demo (P1 triad complete).
3. US3 (classification + its policy UI panel + Undo/Redo extension) → demo.
4. US4 (relations + its policy UI panel + Undo/Redo extension) → demo.
5. US6 (collaboration hardening) → demo.
6. US7 (keyboard/structural/performance polish) → demo.
7. Phase 10 (contract docs, database/build/deploy gates, full regression, combined Undo/Redo regression, security review) → feature-complete report per AGENTS.md phase-discipline (files created/modified, commands, env vars, migration changes, known limitations, next phase).

### Dependency graph

```text
Setup → shared contracts/config → sequential schema/migration validation
      → source writer + verified reader/cache → outbox + command/receipt + policy lifecycle
      → active-engine adapters/callers → immediate IMAGE/VIDEO regression
      → US1 → US2 → US5 → immediate three-engine regression
      → US3 (classification history extension) → US4 (relation history extension)
      → US6 → US7 → individually recorded closure gates
```

Service dependencies differ from scheduled UI integration: classification depends on the canonical contract, source context, policy and command foundation, never span implementation. US5 core is testable before classification/relations; its full feature acceptance is extended in those later stories and combined during closure.

---

## Notes

- [P] means independent test authoring in separate files, with prerequisite contracts available; execution uses isolated fixtures.
- Every mutation task routes through the single Foundational transaction guard (T033) — no story should introduce a second write path.
- Every durable TEXT shape (geometry, export projections, boundary contract, decode rules, source limits) is defined once in `packages/domain` (T005–T008) and imported, never redefined, by `apps/web` or `apps/worker` — including worker export code, which must never depend on `apps/web` types.
- The GET source route (T054) and mutation validation (US2's T070) both call the single T028 source read service — neither re-implements decode/identity/limit logic.
- No migration is generated against a shared database: T017 generates and inspects SQL against an isolated development/review-purpose PostgreSQL database; T018 validates it on the disposable acceptance environment; shared rollout follows the existing authorized deployment process.
- Target inventory (T002) precedes migration validation (T018); honor existing authorization for generated-file rewrites and shared rollout without attributing blanket new-migration approval to AGENTS.md.
- Source preparation and source reads are authorized on `dataset.read` (T038), not `annotation.create` — a reviewer or any other read-authorized member is never blocked from inspecting an unprepared or ready TEXT source.
- No raw SQL, no full `Job.input`/annotation content in Redis, no binary data in PostgreSQL, and no provider/storage credentials in browser-reachable code at any task — re-verify against AGENTS.md "Security rules" and "Non-negotiable data rules" during Phase 10's security review (T173).
- Commit after each task or logical group; stop at any checkpoint to validate a story independently before continuing.

## Review resolution (2026-09-15)

The task IDs below refer to this revised file; earlier task numbers were renumbered in execution order. No tasks are marked implemented.

| Requested correction | Owning tasks |
| --- | --- |
| 1. Shared durable contracts | T005, T009, T085 |
| 2. Boundary artifact reader/cache | T026, T029 |
| 3. Authoritative source-read service | T007, T028, T030 |
| 4. Policy writer and product UI | T040, T042, T043, T044, T114, T134 |
| 5. Incremental Undo/Redo | T090, T095, T115, T135, T172 |
| 6. Preparation uses dataset.read | T038, T051, T055 |
| 7. Central validated limits | T008, T025 |
| 8. Immediate shared flush regressions | T046, T047, T098 |
| 9. Separate closure evidence | T158, T159, T160, T161, T162, T163, T165, T166, T167, T169, T170 |
| 10. Real execution dependencies | T006, T020, T105 |



## Follow-up analysis remediation

| Finding | Explicit owners |
| --- | --- |
| I1 | T037, T044, T072, T107, T128 |
| C1 | T125, T126, T127 |
| U1 | T003, T150, T174 |
| I2 | T042, T043, T044 |
| U2 | T004, T073, T084, T108, T128 |
| C2 | T034, T072, T075, T107 |
| C3 | T076, T077 |

Task count: 175. Story counts: US1=14, US2=22, US3=18, US4=20, US5=13, US6=10, US7=10; setup/foundation/closure=68. Implementation started; checked tasks have verification evidence.
