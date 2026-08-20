# Tasks: Video and Audio Readiness

**Input**: Design documents from `/specs/018-video-audio-read-asset/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md),
[research.md](./research.md), [data-model.md](./data-model.md), and
[contracts/](./contracts/).

**Tests**: Required. Every durable media mutation must be validated using
controlled PostgreSQL, passworded isolated Redis, private MinIO, the private
worker, and normal opaque-cookie HTTP sessions. Mocked storage/queue/database
evidence cannot close runtime tasks.

## Blockers and non-negotiable gates

1. **T003 is satisfied**: approval for `ffprobe`/`ffmpeg` is recorded. T017
   still requires a rebuilt-image validation record before it can close.
2. **T005/T006 are design gates**: Phase 017 permits IMAGE annotation writes
   only. VIDEO frame/track/keyframe/temporal mutations require their own
   validated, revision-guarded server contract before VideoEngine is built.
3. **No migration is pre-approved.** T004 must confirm current `Asset`,
   `VideoAsset`, `AudioAsset`, `Annotation`, and `VideoObjectTrack` fields meet
   the MVP. If it finds a real model/index mismatch, stop and request separate
   schema-migration approval; do not silently add fields.

## Format: `[ID] [P?] [Story?] Description`

- `[P]` means different-file work that may run in parallel after its listed
  prerequisite.
- Story labels map to the five user stories in [spec.md](./spec.md).
- Every task has an exact path. No task may weaken the `{ jobId }` transport
  contract or expose credentials, storage identity, raw tool output, or lock
  data.

## Phase 1: Audit and Contract Lock

**Purpose**: Prove the current architecture can support the phase before any
source/runtime mutation.

- [X] T001 Audit existing JobType values, queue routing, recovery eligibility, enqueue/retry identity, and exact queue payload enforcement in `packages/queue/src/job-contract.ts`, `apps/web/src/lib/queue/enqueue-job.ts`, `apps/worker/src/queue/queue-router.ts`, and `apps/worker/src/queue/recovery-scanner.ts`; record findings in `specs/018-video-audio-read-asset/research.md`.
- [X] T002 [P] Audit current Asset/AssetVersion source identity, VideoAsset/AudioAsset fields, Annotation temporal fields, VideoObjectTrack relations, import Asset-commit boundary, and existing subprocess helpers in `prisma/schema.prisma`, `apps/worker/src/jobs/`, and `apps/web/src/lib/`; amend `specs/018-video-audio-read-asset/data-model.md` with the canonical source-of-truth decision.
- [X] T003 Record explicit approval for `ffprobe`/`ffmpeg` in the worker image in `specs/018-video-audio-read-asset/research.md`; approval was supplied and the Dockerfile change is limited to the private worker image.
- [X] T004 Confirm whether the existing schema supports the MVP's one current VideoAsset/AudioAsset result and waveform reference in `prisma/schema.prisma` and `specs/018-video-audio-read-asset/data-model.md`; if not, document the exact mismatch and stop for separate migration approval.
- [X] T005 Define the VIDEO frame/track/keyframe/temporal mutation boundary, revision rules, and concealment behavior in `specs/018-video-audio-read-asset/contracts/workspace-engines.md`; explicitly distinguish it from Phase 017's IMAGE-only `PUT /api/assets/[assetId]/annotations` contract.
- [X] T006 Define safe media scheduling/readiness request and response rules, including no-storage/no-secret projections, in `specs/018-video-audio-read-asset/contracts/media-processing.md` and `specs/018-video-audio-read-asset/contracts/workspace-engines.md`.

**Checkpoint**: The worker-image, schema, video-write, and public-contract
gates are resolved or explicitly blocked; no implementation begins on an
ambiguous boundary.

---

## Phase 2: Shared Foundations

**Purpose**: Implement the safe, single-Asset scheduling and shared modality
read boundaries required by all user stories.

- [X] T007 Add canonical media processor version, credential-free request-identity, finite policy, and safe error schemas in `apps/web/src/lib/media-processing/contracts.ts` and `apps/worker/src/media/policy.ts`; the version is exported from `@annotationplatform/domain/media-processing` to prevent web/worker drift.
- [ ] T008 [P] Extend allowed queue Job type/name validation for `EXTRACT_VIDEO_METADATA` and `GENERATE_AUDIO_WAVEFORM` in `packages/queue/src/job-contract.ts`, `apps/web/src/lib/queue/queue-names.ts`, and `apps/worker/src/queue/queue-names.ts`; preserve exact `{ jobId }` payload tests in `packages/queue/src/job-contract.test.ts`.
- [X] T009 Implement `ensureMediaProcessingJob` with Dataset/Asset authorization, source freshness revalidation, concurrent idempotency, durable commit-before-enqueue, and existing recovery semantics in `apps/web/src/lib/media-processing/ensure-media-processing-job.ts`.
- [X] T010 [P] Implement one safe media-readiness projection and canonical server-side polymorphic workspace read service in `apps/web/src/lib/media-processing/safe-media-readiness.ts` and `apps/web/src/lib/workspace/workspace-read.ts`.
- [X] T011 Add normal opaque-cookie media-processing request/read adapters that delegate only to T009/T010 in `apps/web/src/app/api/assets/[assetId]/media-processing/route.ts` and `apps/web/src/app/api/assets/[assetId]/media-processing/status/route.ts`.
- [ ] T012 [P] Create shared controlled media fixtures, isolated Redis/MinIO snapshot helpers, and no-secret redaction helpers in `apps/web/tests/media-processing/helpers.ts` and `apps/worker/tests/media/helpers.ts`.
- [ ] T013 Add foundation tests for one-Asset request identity, concurrent reuse, post-commit enqueue, exact payload, source freshness refusal, safe projection, and zero-side-effect denial in `apps/web/tests/media-processing/scheduling.test.ts` and `apps/worker/tests/media/queue-contract.test.ts`.

**Checkpoint**: A permitted actor can request/read safe processing for exactly
one eligible Asset; no processor is implemented yet and no non-IMAGE Asset can
fall into ImageCanvas.

---

## Phase 3: User Story 1 — Video Metadata Readiness (Priority: P1) 🎯 MVP

**Goal**: One private VIDEO Asset produces one safe, validated metadata result.

**Independent Test**: Schedule a controlled VIDEO Asset, consume it through the
private worker, and confirm exactly one current VideoAsset reconciliation and
one COMPLETED Job without source/storage/tool leakage.

### Tests for User Story 1

- [ ] T014 [P] [US1] Add VIDEO policy, ffprobe-output parsing/validation, malformed-output, stale-fingerprint, and redaction unit tests in `apps/worker/tests/media/video-metadata.test.ts` (parser coverage has started; stale-fingerprint and redaction assertions remain open).
- [ ] T015 [P] [US1] Add PostgreSQL/MinIO worker integration tests for VIDEO metadata reconciliation, retry, cancellation, stale lock, and no duplicate VideoAsset/terminal event in `apps/worker/tests/media/video-metadata-integration.test.ts`.
- [ ] T016 [P] [US1] Add normal-cookie HTTP owner/member/foreign/unknown/malformed VIDEO readiness scheduling and safe projection tests in `apps/web/tests/media-processing/video-http.test.ts`.

### Implementation for User Story 1

- [X] T017 [US1] After T003 approval, add only approved `ffprobe`/`ffmpeg` packages to `apps/worker/Dockerfile` and record the image validation command/result in `specs/018-video-audio-read-asset/quickstart.md`.
- [X] T018 [US1] Implement bounded child-process execution, output capture, cancellation termination, and Job-scoped temporary cleanup in `apps/worker/src/media/subprocess.ts` and `apps/worker/src/media/temp-workspace.ts`.
- [X] T019 [US1] Implement private source materialization and exact unreferenced-object cleanup guards in `apps/worker/src/media/source-materialization.ts` and `apps/worker/src/media/minio-compensation.ts`.
- [X] T020 [US1] Implement the claim-token-guarded VIDEO metadata processor and atomic VideoAsset/Asset reconciliation in `apps/worker/src/jobs/video-metadata.ts`.
- [ ] T021 [US1] Route `EXTRACT_VIDEO_METADATA` without changing local-folder/repository import routing in `apps/worker/src/queue/queue-router.ts` and `apps/worker/tests/queue/queue-router.test.ts`.

**Checkpoint**: VIDEO readiness is independently demonstrable with a private
source, safe metadata, cancellation/retry behavior, and no duplicate result.

---

## Phase 4: User Story 2 — Audio Waveform Readiness (Priority: P1)

**Goal**: One private AUDIO Asset produces validated metadata and one current
private waveform derivative.

**Independent Test**: Schedule a controlled AUDIO Asset and verify one
completed Job, one AudioAsset result, one private versioned waveform artifact,
and a redacted readiness response.

### Tests for User Story 2

- [ ] T022 [P] [US2] Add waveform peak generation, format-version, finite-size, audio metadata validation, and safe-error unit tests in `apps/worker/tests/media/audio-waveform.test.ts`.
- [ ] T023 [P] [US2] Add private MinIO/PostgreSQL integration tests for AUDIO reconciliation, exact-object compensation, retry, stale fingerprint, and no duplicate waveform result in `apps/worker/tests/media/audio-waveform-integration.test.ts`.
- [ ] T024 [P] [US2] Add normal-cookie HTTP owner/member/foreign/unknown/malformed AUDIO readiness scheduling, status, and redaction tests in `apps/web/tests/media-processing/audio-http.test.ts`.

### Implementation for User Story 2

- [ ] T025 [US2] Implement bounded multi-resolution `fieldframe.audio-waveform.v1` generation and safe metadata parsing in `apps/worker/src/media/waveform.ts`.
- [ ] T026 [US2] Implement immutable attempt-object upload, source-identity reconciliation, and exact unreferenced compensation in `apps/worker/src/media/audio-derivative.ts`.
- [ ] T027 [US2] Implement the claim-token-guarded AUDIO metadata/waveform processor and atomic AudioAsset/Asset reconciliation in `apps/worker/src/jobs/audio-waveform.ts`.
- [ ] T028 [US2] Route `GENERATE_AUDIO_WAVEFORM` without changing existing import/export routing in `apps/worker/src/queue/queue-router.ts` and `apps/worker/tests/queue/queue-router.test.ts`.

**Checkpoint**: AUDIO readiness is independently demonstrable with one private
derivative, safe metadata, retry/compensation behavior, and no duplicate result.

---

## Phase 5: User Story 3 — Duplicate Delivery, Retry, and Cancellation Safety (Priority: P1)

**Goal**: Duplicate delivery, retries, stale workers, and cancellation converge
without duplicate results or unsafe cleanup.

**Independent Test**: Two real workers receive the same Job; controlled
failure/cancellation windows leave one canonical result or one safe terminal
outcome, never a stale mutation.

### Tests for User Story 3

- [ ] T029 [P] [US3] Add two-worker duplicate-delivery and stale-lock refusal tests for both media Job types in `apps/worker/tests/media/two-worker-media.test.ts`.
- [ ] T030 [P] [US3] Add failure-before-source, after-private-upload, after-child-reconciliation, and after-terminal-completion retry tests in `apps/worker/tests/media/media-reconciliation.test.ts`.
- [ ] T031 [P] [US3] Add cancellation tests before claim, during long audio processing, before reconciliation, and after a completed batch in `apps/worker/tests/media/media-cancellation.test.ts`.

### Implementation for User Story 3

- [ ] T032 [US3] Add active-lock cancellation checks before source access, processing, reconciliation, and completion in `apps/worker/src/jobs/video-metadata.ts` and `apps/worker/src/jobs/audio-waveform.ts`.
- [ ] T033 [US3] Add deterministic reconciliation and terminal-event idempotency guards in `apps/worker/src/jobs/video-metadata.ts`, `apps/worker/src/jobs/audio-waveform.ts`, and `apps/worker/src/jobs/job-event-writer.ts`.
- [ ] T034 [US3] Add server-side-only failure injection gates for controlled media tests in `apps/worker/src/media/test-hooks.ts` and `apps/worker/tests/media/helpers.ts`; reject browser-controlled failure input.

**Checkpoint**: Controlled retries, cancellation, and two-worker redelivery
prove one current result/artifact and safe compensation boundaries.

---

## Phase 6: User Story 4 — Safe Media Readiness UI and Authorization (Priority: P2)

**Goal**: Authorized users can understand media readiness without receiving
internal Job/storage/source data.

**Independent Test**: Owner/member can read safe readiness and request
reconciliation; foreign, unknown, and malformed requests are concealed and
produce no Job/queue/storage side effect.

### Tests for User Story 4

- [ ] T035 [P] [US4] Add safe Job/Asset/media-readiness projection and response-redaction tests for queued/running/retrying/completed/failed/canceled cases in `apps/web/tests/media-processing/readiness-redaction.test.ts`.
- [ ] T036 [P] [US4] Add owner/member/foreign/unknown/malformed/cross-Dataset reconcile authorization and no-side-effect tests in `apps/web/tests/media-processing/authorization.test.ts`.

### Implementation for User Story 4

- [ ] T037 [US4] Extend the Asset list/detail safe DTOs with modality-specific readiness and validated metadata only in `apps/web/src/lib/media-processing/safe-media-readiness.ts` and `apps/web/src/app/api/datasets/[datasetId]/assets/route.ts`.
- [ ] T038 [US4] Add Asset detail/list readiness indicators and authorized reconcile controls using safe APIs only in `apps/web/src/components/assets/media-readiness.tsx` and `apps/web/src/components/datasets/dataset-assets.tsx`.
- [ ] T039 [US4] Reuse the safe PostgreSQL Job progress/status projection for media requests in `apps/web/src/app/(app)/datasets/[datasetId]/imports/[jobId]/page.tsx` and `apps/web/src/components/jobs/job-progress-card.tsx`.

**Checkpoint**: Media readiness is usable and authorized without Redis,
BullMQ, storage, source, or credential data entering the browser.

---

## Phase 7: User Story 5 — Modality-Selected Workspace (Priority: P2)

**Goal**: The shared workspace route chooses the correct engine; VIDEO has an
interactive frame/timeline workspace and AUDIO has a safe waveform surface.

**Independent Test**: Open one authorized Asset of each modality and assert the
shared shell selects the right engine; VIDEO work is revision-safe and a
non-IMAGE Asset never renders ImageCanvas.

### Tests for User Story 5

- [ ] T040 [P] [US5] Add shared-shell modality dispatch and non-IMAGE-never-enters-ImageCanvas tests in `apps/web/tests/workspace/workspace-engine-routing.test.ts`.
- [ ] T041 [P] [US5] Add VIDEO player/frame/timeline, shape, track, keyframe, interpolation, temporal-label, autosave/flush, and conflict-draft tests in `apps/web/tests/workspace/video-engine.test.ts`.
- [ ] T042 [P] [US5] Add AUDIO waveform/readiness surface and IMAGE mask-placeholder/read-only regression tests in `apps/web/tests/workspace/audio-engine.test.ts` and `apps/web/tests/workspace/image-engine-regression.test.ts`.
- [ ] T043 [P] [US5] Add normal-cookie workspace authorization/concealment and safe view-capability redaction tests for all modalities in `apps/web/tests/workspace/modality-workspace-http.test.ts`.

### Implementation for User Story 5

- [ ] T044 [US5] Replace the Image-only fallback with exhaustive shared-shell IMAGE/VIDEO/AUDIO/TEXT dispatch in `apps/web/src/components/workspace/workspace-engine.tsx`; keep ImageCanvas IMAGE-only.
- [ ] T045 [US5] Generalize the shared server-side workspace read/projection boundary for selected VIDEO/AUDIO/TEXT Assets in `apps/web/src/lib/workspace/workspace-read.ts`, `apps/web/src/app/(app)/workspace/[datasetId]/page.tsx`, and `apps/web/src/types/workspace.ts`.
- [ ] T046 [US5] Implement the VIDEO engine player, overlay, timeline, toolbox/sidebar/bottom controls, and safe view-capability lifecycle in `apps/web/src/components/workspace/video-engine.tsx`, `apps/web/src/components/workspace/video-canvas.tsx`, and `apps/web/src/components/workspace/video-timeline.tsx`.
- [ ] T047 [US5] Implement validated server-side VIDEO annotation/track/keyframe/temporal services and thin authorized adapters in `apps/web/src/lib/annotations/video-annotation-service.ts`, `apps/web/src/lib/validation/video-annotation.ts`, and `apps/web/src/app/api/assets/[assetId]/video-annotations/route.ts`.
- [ ] T048 [US5] Implement revision-aware VIDEO autosave/flush/conflict state in `apps/web/src/lib/workspace/video-autosave.ts` and `apps/web/src/stores/annotation-store.ts`.
- [ ] T049 [US5] Implement the AUDIO readiness/waveform engine and explicit no-edit state in `apps/web/src/components/workspace/audio-engine.tsx`; implement an explicit safe TEXT engine in `apps/web/src/components/workspace/text-engine.tsx`.
- [ ] T050 [US5] Preserve IMAGE’s five editable tools and show Mask/future shapes as read-only scaffolded controls in `apps/web/src/components/workspace/image-engine.tsx`, `apps/web/src/components/workspace/toolbar.tsx`, and `apps/web/src/components/workspace/canvas-stage.tsx`.

**Checkpoint**: VIDEO no longer presents an unavailable workspace, AUDIO is a
safe waveform/readiness workspace, and ImageCanvas accepts IMAGE only.

---

## Phase 8: Final Validation and Scope Audit

**Purpose**: Close Phase 018 only with real isolated runtime evidence.

- [ ] T051 Run controlled Compose media runtime validation—PostgreSQL, passworded isolated Redis, private MinIO, web, approved worker image, and two workers—and record exact commands/duration/pass/fail/skip/restoration in `specs/018-video-audio-read-asset/quickstart.md`.
- [ ] T052 [P] Run repository-import and local-folder regression suites, broad isolated queue suite, media worker suites, and exact queue-payload audit in `apps/worker/tests/` and `apps/web/tests/`; record executed evidence in `specs/018-video-audio-read-asset/quickstart.md`.
- [ ] T053 [P] Run authenticated media/workspace HTTP authorization, redaction, no-side-effect, and view-capability tests in `apps/web/tests/media-processing/` and `apps/web/tests/workspace/`; record executed evidence in `specs/018-video-audio-read-asset/quickstart.md`.
- [ ] T054 Run Prisma validate/generate, web typecheck/lint/production build, worker typecheck/build, and `git diff --check`; record results in `specs/018-video-audio-read-asset/quickstart.md`.
- [ ] T055 Perform the final architecture and scope audit in `specs/018-video-audio-read-asset/quickstart.md`: PostgreSQL canonical, exact queue payload, no public worker, private binary/derivatives, worker-only credential decryption, shared modality shell, ImageCanvas IMAGE-only, no scheduler/sync/delete propagation/browser credentials, no unapproved migration/dependency.

---

## Dependencies and Execution Order

```text
T001–T006 audit/contract gates
  └─ T007–T013 shared scheduling/read foundations
       ├─ US1 video metadata: T014–T021
       ├─ US2 audio waveform: T022–T028
       ├─ US3 safety: T029–T034 (after US1 + US2 processors)
       ├─ US4 safe readiness: T035–T039 (after T009–T011)
       └─ US5 modality workspace: T040–T050 (after T005/T006/T010)
            └─ T051–T055 closure
```

T003 gates any worker-image change. T005/T006 gate all VIDEO write/VideoEngine
work. T004 gates any migration proposal. No task may bypass these gates.

## Parallel Opportunities

- After audit gates: T007/T008/T010/T012 can proceed in separate files.
- VIDEO and AUDIO parser/HTTP tests (T014–T016, T022–T024) can be prepared in
  parallel after the shared contracts exist.
- US4 read-model tests (T035/T036) can proceed alongside processor tests once
  T009/T010 are stable.
- US5 routing/read tests (T040/T043) can proceed while VIDEO UI tests/design
  are prepared, but T044–T050 remain blocked on T005/T006.
- Final suite commands T052/T053 may run in parallel only after their runtime
  namespaces are isolated; T051 records the consolidated result last.

## Implementation Strategy

### MVP first

1. Complete the audit gates, especially recorded worker-image approval.
2. Deliver shared scheduling plus **US1 VIDEO metadata** only.
3. Prove one private source → one safe VideoAsset result → one completed Job.
4. Stop and validate before adding waveform, video editing, or broad UI work.

### Incremental delivery

1. Add US2 audio derivative after US1's worker safety is proven.
2. Add US3 real failure/cancellation/two-worker proof across both processors.
3. Add US4 safe operational read model.
4. Add US5 modality shell and video workspace only after the VIDEO mutation
   contract is approved and tested.
5. Close only after all runtime suites and scope audit are green.
