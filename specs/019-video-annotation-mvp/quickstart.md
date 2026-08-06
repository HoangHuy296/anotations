# Phase 019 Validation Guide

This guide records how implementation evidence must be collected. It contains
no credentials and does not authorize a schema migration.

## Prerequisites

- Controlled PostgreSQL, passworded isolated Redis, private MinIO, web, and
  worker services are healthy.
- A VIDEO Asset with safe metadata and at least one same-Dataset Label exists.
- Test users are created and authenticated through normal signup/login opaque
  cookies; no DEV_AUTH_EMAIL or bypass is used.
- Any proposed VideoObjectTrack schema extension has separate migration
  approval and controlled backfill evidence before applying it.

## Focused validation

Run independently and record duration and pass/fail/skip counts:

1. Prisma schema audit and validation/generate.
2. Unit geometry, timestamp, interpolation, and safe projection tests.
3. Authenticated HTTP read/track/keyframe/temporal-label tests.
4. Concurrent revision and atomic rollback tests.
5. Video workspace playback, timeline, interpolation, autosave, and conflict
   tests.
6. Existing Phase 017 image, audio, repository-import, local-folder, and queue
   regression suites.

## Required evidence

- One private-video view-capability success with no storage identity in the
  browser response.
- Track creation, two keyframes, deterministic interpolation, Add Keyframe
  Here, edit/delete, temporal-label lifecycle, reload persistence.
- One winner per concurrent track revision and temporal Annotation revision.
- No manual mutation creates a Job, queue payload, Redis entry, provider call,
  or MinIO write.
- Redaction audit of HTTP DTOs, events, UI data, and safe errors.
- Bounded read evidence for a long-video fixture.

## Read-only migration-gate audit

Controlled runtime used: Docker Compose `postgres` service, database
`fieldframe`, user `fieldframe`; host Prisma endpoint `127.0.0.1:5433`.
Passwords and credentials were not recorded.

Executed independently:

- `docker compose ps`
- read-only SQL audit for tracks, linked Annotations, timestamps, duplicate
  timestamps, invalid rows, cross-resource integrity, labels, types, columns,
  and interpolation enums
- `pnpm exec prisma migrate status`

Result: 0 tracks, 0 track-linked Annotations, 0 missing timestamps, 0
duplicate groups, 0 interpolated rows, 0 invalid/cross-resource rows, no empty
tracks, and no interpolation enum. Prisma reported 9 migrations and an up-to-
date schema. No schema or data mutation was performed.

Approved migration applied separately as
`20260729000000_add_video_track_revision_contract`. It adds `revision` default
1, `annotationType` default `BOUNDING_BOX`, and `interpolationMode` default
`LINEAR`, plus the partial unique index
`Annotation_video_keyframe_track_timestamp_key` for persisted VIDEO keyframes
on `(trackId, timestampMs)`. The audit found zero existing tracks, so no row
backfill or annotation rewrite was required.

## Final commands

Use the repository's package scripts for Prisma validate/generate, web and
worker typecheck/lint/build, focused Phase 019 tests, regression suites, and
`git diff --check`. Record exact commands and non-secret output in the phase
evidence before marking tasks complete. Restore the normal Compose namespace
and worker count after controlled tests.

## Implementation checkpoint — revision contract hardening

Executed independently on 2026-07-29 (controlled local environment):

- `node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/annotation-api/video-foundation.test.ts` — 1 suite, 5 assertions, 1 passed, 0 failed, 0 skipped.
- `pnpm --filter @fieldframe/web typecheck` — passed.
- `pnpm --filter @fieldframe/worker typecheck` — passed.
- `pnpm --filter @fieldframe/worker build` — passed.
- `pnpm --filter @fieldframe/web lint` — passed with one pre-existing unused-import warning.
- `pnpm exec prisma validate` — passed.
- `pnpm exec prisma migrate status` — passed; controlled database is up to date.
- `pnpm --filter @fieldframe/web test:workspace` — 18 suites passed, 0 failed, 0 skipped.
- `pnpm --filter @fieldframe/web build` — initial sandbox run was blocked by a process-port permission error; rerun with approved process permissions after final client/store changes compiled successfully, passed TypeScript, generated 24 static pages, and exited 0.

This checkpoint validates strict keyframe authority DTOs, interpolation
foundations, existing workspace regressions, Prisma state, and type safety.
Authenticated track/keyframe HTTP, PostgreSQL race, duplicate-index,
temporal-label, and full production-build evidence remain open; this is not a
Phase 019 closure record.

## Contract-evidence rerun — 2026-07-30

- `pnpm exec prisma generate` — passed with Prisma 6.19.3.
- `pnpm exec prisma validate` — passed.
- `pnpm exec prisma migrate status` — passed; 10 migrations, database up to date.
- `pnpm --filter @fieldframe/web typecheck` — passed.
- `pnpm --filter @fieldframe/web lint` — passed with one existing unused-import warning.
- `pnpm --filter @fieldframe/worker typecheck` — passed.
- `pnpm --filter @fieldframe/worker build` — passed.
- `pnpm --filter @fieldframe/web test:workspace` — 18 passed, 0 failed, 0 skipped.
- Focused foundation and gated HTTP test files — 2 suites passed; HTTP lifecycle suite intentionally skipped because no web service was listening on the configured test port.
- `pnpm --filter @fieldframe/web build` — passed with approved process permissions; TypeScript and 24 static pages completed successfully.
- `git diff --check` — exit 2; only tracked generated Prisma files report trailing whitespace after pinned regeneration (`prismaNamespace.ts` and `VideoObjectTrack.ts`). No exclusions or manual generated-file edits were used.

The authenticated HTTP, two-session PostgreSQL race, duplicate-index,
temporal-label race, and Add Keyframe Here runtime evidence remains open until
controlled PostgreSQL plus web services are started. No Phase 019 closure line
is recorded.

## Controlled runtime checkpoint — 2026-07-30

Services used: Compose `postgres`, passworded `redis`, private `minio`, rebuilt
`web`, and existing `worker`. The controlled database is `fieldframe` on the
redacted host endpoint `127.0.0.1:5433`; no credentials were recorded.

- `docker compose up -d postgres redis minio web worker` — all requested services healthy/running.
- `COMPOSE_BAKE=false docker compose build web && docker compose up -d --force-recreate web` — rebuilt web image; production build completed and video routes were present.
- `NODE_ENV=test VIDEO_ANNOTATION_HTTP_TESTS=1 VIDEO_ANNOTATION_HTTP_BASE_URL=http://127.0.0.1:3000 ... tests/auth-ownership/video-track-keyframe.test.ts` — 1 passed, 0 failed, 0 skipped. Normal opaque-cookie login; lifecycle, duplicate timestamp mapping, foreign/unsafe-field denial, and PostgreSQL no-side-effect assertions passed.
- `NODE_ENV=test VIDEO_ANNOTATION_HTTP_TESTS=1 VIDEO_ANNOTATION_HTTP_BASE_URL=http://127.0.0.1:3000 ... tests/auth-ownership/video-temporal-label.test.ts` — 1 passed, 0 failed, 0 skipped. Create/update/delete, same-revision race, and missing-duration rejection passed.
- `NODE_ENV=test VIDEO_ANNOTATION_RACE_TESTS=1 ... tests/annotations/video-track-race.test.ts` — 2 passed, 0 failed, 0 skipped. Same-revision race produced one winner/one conflict; current-revision duplicate timestamp rolled back without revision change.
- Focused foundation/Add Keyframe Here tests — passed.
- Workspace regression — 18 passed, 0 failed, 0 skipped.
- `git diff --check` after two generate/normalize repetitions — exit 0.
- Web/worker typecheck and Prisma validation — passed; migration status reports 10 migrations and an up-to-date database.

Provider/MinIO/Redis side-effect snapshots are not yet part of the video
mutation fixtures, and full two-session race coverage for every listed delete
ordering remains open. Autosave, complete conflict UI, full manual Video
editing, and Phase 019 closure remain open.

Task status updated from this evidence: T032 and T038 are complete. T026/T027,
T034/T035, T040–T042, and final validation tasks remain open because their full
role, resource, race, and side-effect matrices have not all been executed.

## Race/UI continuation — 2026-07-30

- `NODE_ENV=test VIDEO_ANNOTATION_RACE_TESTS=1 QUEUE_INTEGRATION_TESTS=1 ... tests/annotations/video-track-race.test.ts` — 10 passed, 0 failed, 0 skipped. Covered same-revision create/update races, keyframe delete/update, Track delete/create/update, Track update/delete, stale delete, independent Track A/B, duplicate timestamp rollback, and no-orphan final state.
- Race-suite side-effect snapshot — PostgreSQL Job/JobEvent counts, isolated Redis queue counts, and `phase019-video/` MinIO object list were unchanged before/after manual mutations.
- Added bounded interpolation markers with distinct persisted/derived presentation, explicit Track and Add Keyframe Here controls, and temporal-label create/move/delete controls. Web typecheck/lint and production build pass; the existing unused `SafeMediaReadiness` lint warning remains.
- Rebuilt/recreated Compose web image after UI changes; PostgreSQL, Redis, MinIO, web, and worker remain healthy.

Full role/concealment HTTP matrix, provider-counter assertions, complete manual
track editing, boundary-drag UI, autosave/conflict UI, and final closure remain
open.

## Remaining-slice implementation checkpoint — 2026-07-30

Implemented (runtime evidence still required before task checkboxes change):

- VideoEngine now exposes bounded Track name/label/interpolation controls,
  explicit Track save/delete, persisted-keyframe selection/navigation,
  normalized geometry/time editing, delete, and a distinct save/conflict state.
- Timeline persisted keyframe markers are selectable; derived interpolation
  markers remain visually distinct and local-only.
- Temporal-label panel now supports bounded start/end editing, relabeling,
  explicit interval save, move, and delete; authoritative server duration is
  still enforced by the mutation service.
- Added per-Track and per-temporal-Annotation 1.5-second autosave coordinator
  primitives with one in-flight request, flush, and conflict/error states.
- HTTP role/concealment test coverage was expanded for malformed/unknown/
  unauthenticated resources, member roles, unsafe authority fields, and
  PostgreSQL Job/JobEvent no-side-effect snapshots. Optional GitHub fixture
  counter comparison is enabled with `GITHUB_FIXTURE_BASE_URL`.

Validation after these edits:

- `pnpm --filter @fieldframe/web typecheck` — passed.
- `pnpm --filter @fieldframe/web lint` — 0 errors, one existing unused
  `SafeMediaReadiness` warning.
- The newly expanded authenticated HTTP suite could not execute in this
  checkpoint because `127.0.0.1:3000` was not listening and Docker socket
  access was unavailable in the current shell. No pass is claimed for that
  suite.
- `pnpm --filter @fieldframe/web test:workspace` — 18 passed, 0 failed,
  0 skipped after the UI and autosave-coordinator additions.
- `pnpm --filter @fieldframe/web build` — passed with approved process
  permissions; compilation, TypeScript, and 24 static pages completed with
  exit code 0.
- A second production build after temporal-label boundary/relabel controls —
  passed with exit code 0; 24 static pages generated.
- The selected keyframe overlay now supports bounded pointer drag with
  normalized geometry and an explicit revision-guarded commit; the draft is
  retained when the server reports a conflict.
- Final production build after pointer-edit changes — passed with exit code 0;
  TypeScript completed and 24 static pages generated.

The remaining open evidence is the real authenticated role/resource matrix,
provider counter/access-log proof, two-session race rerun, draggable canvas
editing, temporal boundary interaction, autosave wiring/evidence, browser
workflow, and final Phase 019 audits/build closure.

## Controlled HTTP/race rerun — 2026-07-30

The earlier HTTP attempt was blocked because `127.0.0.1:3000` was not
listening. After restoring the controlled Compose services, the authoritative
rerun used PostgreSQL, passworded Redis DB 15, private MinIO, web, and worker,
with normal opaque-cookie signup/login and no recorded credentials:

- `docker compose up -d postgres redis minio web worker` — all requested
  services healthy.
- `VIDEO_ANNOTATION_HTTP_TESTS=1 ... video-track-keyframe.test.ts` — 2 passed,
  0 failed, 0 skipped. Includes malformed/unknown/unauthenticated resources,
  owner/member roles, unsafe authority-field rejection, duplicate timestamp
  mapping, and Job/JobEvent no-side-effect snapshots.
- `VIDEO_ANNOTATION_HTTP_TESTS=1 ... video-temporal-label.test.ts` — 1 passed,
  0 failed, 0 skipped. Includes create/update/race/delete, malformed/unknown,
  foreign concealment, and missing-duration refusal.
- `VIDEO_ANNOTATION_RACE_TESTS=1 QUEUE_INTEGRATION_TESTS=1 ...
  video-track-race.test.ts` — 10 passed, 0 failed, 0 skipped. Same-track,
  delete/update, stale-delete, independent-track, duplicate-timestamp, and
  no-orphan assertions passed; PostgreSQL/Redis/MinIO snapshots remained
  unchanged for manual mutations.

The optional GitHub provider counter comparison runs when
`GITHUB_FIXTURE_BASE_URL` is configured. Gitea access-log proof and the full
browser-level workflow remain open and are not claimed here.

## Temporal boundary and autosave wiring checkpoint — 2026-07-30

- The temporal-label UI now provides pointer-draggable start/end handles and a
  draggable interval body. Local draft bounds are always clamped to
  `0 <= startMs < endMs <= durationMs`; whole-interval moves preserve length
  at either boundary. The server remains the final duration authority.
- Boundary, move, and relabel edits only change local draft state while the
  pointer is moving. They schedule the per-Annotation coordinator with a
  1.5-second delay; explicit Save flushes the same coordinator. A conflict
  leaves the local interval draft intact.
- The Track coordinator is now used by Track metadata/interpolation changes
  and keyframe create/update/delete. It serializes all mutations for a Track,
  uses the latest successful Track revision for work queued while a request is
  in flight, and is flushed by workspace navigation alongside image autosaves.
- `pnpm --filter @fieldframe/web exec vitest run
  tests/workspace/video-autosave.vitest.spec.ts
  tests/workspace/video-temporal-boundary.vitest.spec.ts --environment node`
  — 2 files, 5 passed, 0 failed. Covers fake-timer debounce, later edit while
  an older request is in flight, no automatic conflict retry, independent
  temporal revision use, and interval-bound invariants.
- `pnpm --filter @fieldframe/web typecheck` — passed.
- `pnpm --filter @fieldframe/web lint` — 0 errors; one existing unused import
  warning in `workspace-read.ts`.
- `pnpm --filter @fieldframe/web build` — passed with exit code 0; TypeScript
  completed and 24 static pages generated after the coordinator wiring.
- `pnpm --filter @fieldframe/web test:workspace` — 18 passed, 0 failed,
  0 skipped after navigation began flushing Video coordinators.

This is implementation and focused unit evidence only. A delayed real-HTTP
autosave test, drag interaction browser test, provider/Gitea no-call evidence,
and the end-to-end private-MinIO browser workflow remain open.

## Video read-service evidence — 2026-07-30

- `VIDEO_ANNOTATION_READ_TESTS=1 ...
  tests/auth-ownership/video-annotation-read.test.ts` — 2 passed, 0 failed,
  0 skipped against controlled Compose web/PostgreSQL. Owner, member, and
  ADMIN received the safe persisted read DTO; foreign, cross-Dataset, unknown,
  malformed, and unauthenticated resources were concealed or rejected without
  Track, Annotation, Job, or JobEvent mutation.
- `VIDEO_ANNOTATION_READ_MODEL_TESTS=1 ...
  tests/annotations/video-read-model.test.ts` — 2 passed, 0 failed,
  0 skipped against controlled PostgreSQL. Empty Video assets return empty safe
  arrays. Windowed reads derive interpolation using bounded persisted bracketing
  keyframes while omitting out-of-window keyframe rows from the browser DTO.

Tasks T016 and T017 are marked complete from this evidence. At this checkpoint
T018 was still pending its direct-MinIO capability run.

## VIDEO direct-capability evidence — 2026-07-30

- `VIDEO_VIEW_INTEGRATION_TESTS=1 ...
  tests/workspace/video-engine-read.test.ts` — 2 passed, 0 failed, 0 skipped
  against controlled Compose web/PostgreSQL/MinIO. A normal opaque-cookie owner
  received a short-lived object capability with an approved host-runner origin;
  the test fetched the bytes directly from MinIO. The browser DTO omitted
  storage identity, foreign access was concealed, and the VideoEngine source
  was checked for capability use rather than a Next.js video-binary proxy.

T018 is marked complete. The test verifies capability, direct byte retrieval,
and the engine contract; a full browser media-decoding/seek automation remains
part of the later end-to-end workflow evidence.

## Track/keyframe service-contract evidence — 2026-07-30

- `NODE_ENV=test VIDEO_ANNOTATION_SERVICE_TESTS=1 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotations/video-track-contract.test.ts tests/annotations/video-keyframe-contract.test.ts` — 2 passed, 0 failed, 0 skipped (1.82 s) against the controlled PostgreSQL database.
- Track creation started at revision `1`; an authorized metadata update advanced it once; a stale update did not change persisted metadata or revision; deletion removed the Track.
- Keyframe create/update/delete used only `expectedTrackRevision`; the linked Annotation remained at revision `1`. A current-revision duplicate timestamp returned the safe duplicate result and rolled back the Track revision; a negative timestamp was rejected.

Tasks T024 and T025 are marked complete only for the executed service-contract cases. The separate authenticated role/concealment and complete two-session race matrices remain open.

## Interpolation and temporal service-contract evidence — 2026-07-30

- `node --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotations/video-interpolation.test.ts` — 1 test file passed, 0 failed, 0 skipped (0.45 s). It proves deterministic midpoint/non-midpoint bounding-box derivation; exact keyframe timestamps, out-of-range timestamps, `NONE`, and one-keyframe Tracks return no derived persisted row.
- `NODE_ENV=test VIDEO_ANNOTATION_SERVICE_TESTS=1 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotations/video-temporal-label-contract.test.ts` — 1 passed, 0 failed, 0 skipped (0.99 s) against controlled PostgreSQL. The contract creates, moves/resizes, relabels, rejects a stale revision and an out-of-duration interval, then deletes. Its Track remained revision `1` throughout.
- The bounded read-model service test recorded above proves that interpolation is calculated from persisted bracketing keyframes while the browser only receives the requested window. Derived interpolation remains DTO-only; it does not persist an Annotation.

Tasks T034, T037, and T040 are marked complete from this executed evidence. HTTP Add-Keyframe-Here, workspace-state, temporal race/authorization, and all final audits remain open.

## Temporal-label race evidence — 2026-07-30

- `NODE_ENV=test VIDEO_ANNOTATION_RACE_TESTS=1 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotations/video-temporal-label-revision.test.ts` — 2 passed, 0 failed, 0 skipped (1.05 s) against controlled PostgreSQL.
- Same-revision updates produced one commit and one `CONFLICT`; independent temporal labels advanced independently; update-versus-delete reached one terminal state. The unrelated VideoObjectTrack remained at revision `1` in every case.

T041 is marked complete from this service-level race evidence. The broader authenticated authorization/no-side-effect matrix remains T042 and is still open.

## Focused service regression — 2026-07-30

- `NODE_ENV=test VIDEO_ANNOTATION_SERVICE_TESTS=1 VIDEO_ANNOTATION_RACE_TESTS=1 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/annotations/video-track-contract.test.ts tests/annotations/video-keyframe-contract.test.ts tests/annotations/video-temporal-label-contract.test.ts tests/annotations/video-temporal-label-revision.test.ts` — 5 passed, 0 failed, 0 skipped (3.39 s) against the controlled PostgreSQL database.
- `pnpm --filter @fieldframe/web typecheck` — passed after the focused additions. `git diff --check` — exit 0. Lint continues to have no errors and one pre-existing unused `SafeMediaReadiness` warning.

## Rebuilt authenticated mutation HTTP checkpoint — 2026-07-30

- Docker Compose's Bake path panicked during the first build attempt. Re-running `COMPOSE_BAKE=false docker compose build --progress=plain web` completed successfully, then `docker compose up -d --force-recreate web` recreated the web service. Local readiness returned HTTP 200 from `/login` before tests ran.
- `NODE_ENV=test VIDEO_ANNOTATION_HTTP_TESTS=1 VIDEO_ANNOTATION_HTTP_BASE_URL=http://127.0.0.1:3000 node --env-file-if-exists=../../.env --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test --test-concurrency=1 tests/auth-ownership/video-track-keyframe.test.ts tests/auth-ownership/video-temporal-label.test.ts` — 3 passed, 0 failed, 0 skipped (3.07 s), using normal `/api/auth/login` opaque-cookie sessions against Compose web/PostgreSQL.
- The refreshed web image maps stale Track-linked keyframe mutations to `409 VIDEO_TRACK_REVISION_CONFLICT`; current-revision duplicate timestamps remain `409 VIDEO_KEYFRAME_TIMESTAMP_CONFLICT`. The suite also passed malformed/unknown/unauthenticated handling, role-policy checks, temporal authoritative-duration refusal, and existing Job/JobEvent no-side-effect checks.

This is a runtime checkpoint, not closure for T026/T042: the broader non-member, cross-Asset/cross-Dataset, and every-denial external snapshot matrix remains open.

## Expanded mutation-denial HTTP checkpoint — 2026-07-30

- `VIDEO_ANNOTATION_HTTP_TESTS=1 ... tests/auth-ownership/video-track-keyframe.test.ts` — 3 passed, 0 failed, 0 skipped (1.90 s) through normal opaque-cookie login against rebuilt Compose web/PostgreSQL. The added denial case confirmed concealed non-member and non-VIDEO Asset requests, cross-Dataset Label refusal, and foreign keyframe mutation refusal without Track/Annotation/Job/JobEvent mutation or unsafe response content.
- `VIDEO_ANNOTATION_HTTP_TESTS=1 ... tests/auth-ownership/video-temporal-label.test.ts` — 2 passed, 0 failed, 0 skipped (1.29 s). The added temporal denial case confirmed foreign, non-VIDEO, and cross-Dataset Label requests remain concealed/refused and leave Track/Annotation/Job/JobEvent snapshots unchanged.

T026 and T042 remain open. These focused snapshots do not yet cover the full required cross-Asset mutation matrix nor independent Redis, MinIO, and provider-call snapshots for every denial.

## Isolated transport/storage denial evidence — 2026-07-30

- Track/keyframe command: `VIDEO_ANNOTATION_HTTP_TESTS=1 PHASE019_EXTERNAL_SIDE_EFFECT_TESTS=1 QUEUE_INTEGRATION_TESTS=1 REDIS_HOST=127.0.0.1 REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase019-test REDIS_TEST_PREFIX=fieldframe-phase019-test MINIO_ENDPOINT=http://127.0.0.1:9000 MINIO_PUBLIC_ENDPOINT=http://127.0.0.1:9000 ... tests/auth-ownership/video-track-keyframe.test.ts` — 3 passed, 0 failed, 0 skipped (2.44 s). PostgreSQL Track/Annotation/Job/JobEvent snapshots, isolated BullMQ counts, and `phase019-video/` MinIO object keys were unchanged for the denial group.
- Temporal command used the same isolated Redis and MinIO settings with `tests/auth-ownership/video-temporal-label.test.ts` — 2 passed, 0 failed, 0 skipped (1.81 s), with the same no-side-effect assertion for temporal denials.
- GitHub fixture counter: **N/A — controlled counter unavailable** from this host runner; the test helper now records unavailable instead of treating it as a product failure. Gitea request counter and SourceConnection credential-load counter are also **N/A — controlled counter unavailable**. They are not claimed as provider no-call proof.

These runs advance the external snapshot portion of T042 but do not close it: the full actor-by-operation and every-denial provider-counter matrix remains open.

## Actor-by-operation checkpoint — 2026-07-30

- `VIDEO_ANNOTATION_HTTP_TESTS=1 ... tests/auth-ownership/video-track-keyframe.test.ts` — 4 passed, 0 failed, 0 skipped (3.24 s). OWNER, MANAGER, REVIEWER, and LABELER all created Tracks/keyframes through normal cookies; `annotation.updateAny` allowed owner/manager/reviewer Track and keyframe edits and correctly refused LABELER. Unauthenticated creation returned 401. The test left Job and JobEvent counts unchanged.
- `VIDEO_ANNOTATION_HTTP_TESTS=1 ... tests/auth-ownership/video-temporal-label.test.ts` — 3 passed, 0 failed, 0 skipped (2.30 s). OWNER, MANAGER, LABELER, and REVIEWER each created, updated, and deleted their own standalone temporal labels according to `annotation.create` and `annotation.updateOwn`; unauthenticated creation returned 401; Job and JobEvent counts were unchanged.

This is not task closure. T026/T042 still require the remaining malformed/unknown/cross-resource cases per operation and controlled provider-call evidence where counters are available.

## Approved provider no-call compensating evidence — 2026-07-30

- Project-owner approval: `APPROVE B` for unavailable provider/credential counters. No provider or credential instrumentation was added.
- Fixture-only GitHub counter is available through the controlled Compose network and host runner. The isolated Track/Keyframe HTTP suite passed 4/4 (3.05 s) with a zero counter delta.
- Gitea has no deterministic counter. A fresh authenticated temporal mutation run (`3 passed, 0 failed, 0 skipped`, 2.32 s) was followed by an access-log query scoped from its start timestamp; it returned no repository/API path matching a manual mutation. Health checks are excluded from this evidence.
- SourceConnection loader/decrypt, repository-preflight, and provider binary-fetch counters remain **N/A — controlled counter unavailable**. The server-only manual Track, Keyframe, and Temporal service/route import graph contains no provider or SourceConnection dependency.
- This compensating evidence is approved only for the unavailable counters. PostgreSQL, isolated Redis/BullMQ, and MinIO zero-delta assertions remain mandatory and are retained in the corresponding suites.

## Current Compose web-image deployment evidence — 2026-07-30

- Strategy 1 (`setsid`/`disown`) wrote its PID/start metadata and initial log, but the execution environment removed the process tree before it could write an exit-status file. It is environment-classification evidence only, not a production-build PASS.
- Strategy 2 recorded the pre-build image ID `sha256:d46…`, then started the Compose build in an observed detached session. Docker daemon log ended with `web Built`; daemon image ID changed to `sha256:9456…`. The client exit-status file was unavailable after sandbox cleanup, but the daemon-visible completed image is recorded in `evidence/strategy2-*`.
- `docker compose up -d --force-recreate web` created container `ab86…` from `sha256:9456…`, with a later start timestamp. `/login` returned HTTP 200.
- Deployment probe: the current strict temporal DTO/no-side-effect HTTP suite ran against that recreated container with PostgreSQL, isolated Redis DB 15/prefix `fieldframe-phase019-test`, and MinIO `phase019-video/`: 3 passed, 0 failed, 0 skipped (2.73 s). The validation-body cases prove the strict current source boundary is serving; PostgreSQL, isolated queue, MinIO, and response-redaction assertions passed for the denial group.

The daemon-visible image completion and route probe allow current-source runtime work to resume. The missing detached client exit code is explicitly retained as an execution-environment limitation; it is not represented as a standalone local `pnpm build` PASS.

## Slice B Track/keyframe validation checkpoint — 2026-07-30

- `NODE_ENV=test VIDEO_ANNOTATION_HTTP_TESTS=1 VIDEO_ANNOTATION_HTTP_BASE_URL=http://127.0.0.1:3000 ... tests/auth-ownership/video-track-keyframe.test.ts` — 5 passed, 0 failed, 0 skipped (4.12 s) against the daemon-confirmed current Compose web image.
- The table-driven matrix covered malformed/unknown/foreign Asset and Track identities, non-member concealment, malformed/unknown/cross-Dataset Labels, strict ownership/authority fields, malformed/stale Track revision values, negative/beyond-duration/frameIndex-only timestamps, malformed/out-of-bounds geometry, and unsafe keyframe client fields.
- Each denial returned a safe validation or concealed response before any guarded revision claim. The target Track stayed at revision `2` and the persisted keyframe at Annotation revision `1` throughout the denial rows; after fixture cleanup, Track/Annotation/Job/JobEvent snapshot exactly matched the pre-test state.

T026 remains open: the complete update/delete cross-resource matrix (including temporal/Image/non-keyframe annotation IDs) and every required actor/resource cell still needs its dedicated evidence.

## Canonical keyframe resource-kind and foreign-track evidence — 2026-07-30

- `VIDEO_ANNOTATION_HTTP_TESTS=1 PHASE019_EXTERNAL_SIDE_EFFECT_TESTS=1 QUEUE_INTEGRATION_TESTS=1 REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase019-test REDIS_TEST_PREFIX=fieldframe-phase019-test MINIO_ENDPOINT=http://127.0.0.1:9000 MINIO_PUBLIC_ENDPOINT=http://127.0.0.1:9000 GITHUB_FIXTURE_BASE_URL=http://127.0.0.1:18080 ... tests/auth-ownership/video-keyframe-resource-kind.test.ts` — **6 passed, 0 failed, 0 skipped** (2.66 s) against the current Compose web service and controlled PostgreSQL.
- Each independent normal opaque-cookie test used the canonical `PATCH` or `DELETE /api/video-keyframes/[annotationId]` route. Temporal-label and IMAGE Annotation IDs, plus foreign/cross-Dataset persisted VIDEO keyframes, each returned concealed `404` before a Track revision claim; none returned `VIDEO_TRACK_REVISION_CONFLICT`.
- Per-test PostgreSQL snapshots preserved the target Annotation and Track state plus global Annotation, Job, and JobEvent counts. Isolated Redis DB 15 / `fieldframe-phase019-test` queue counts, the `phase019-video/` MinIO object set, and the GitHub fixture counter were unchanged. Response redaction assertions passed.

This advances T026 but does not close it: the remaining full actor/resource matrix and the separate temporal-label T042 matrix are still required.

## Current web build and Slice C temporal boundary checkpoint — 2026-07-30

- `COMPOSE_BAKE=false docker compose build --progress=plain web` — **exit 0** (about 52 s). The production build completed TypeScript, page-data generation, static-page generation, and image export. `docker compose up -d --force-recreate web` then recreated the service; `/login` returned HTTP 200 before the runtime suite.
- `VIDEO_ANNOTATION_HTTP_TESTS=1 PHASE019_EXTERNAL_SIDE_EFFECT_TESTS=1 QUEUE_INTEGRATION_TESTS=1 REDIS_DB=15 REDIS_TEST_DB=15 BULLMQ_PREFIX=fieldframe-phase019-test REDIS_TEST_PREFIX=fieldframe-phase019-test MINIO_ENDPOINT=http://127.0.0.1:9000 MINIO_PUBLIC_ENDPOINT=http://127.0.0.1:9000 GITHUB_FIXTURE_BASE_URL=http://127.0.0.1:18080 ... tests/auth-ownership/video-temporal-label.test.ts` — **4 passed, 0 failed, 0 skipped** (2.92 s) using normal opaque-cookie login against the recreated Compose web service.
- The added route-kind test confirms that temporal PATCH/DELETE conceal persisted keyframe, IMAGE Annotation, and foreign temporal IDs as `404` before revision handling. The strict DELETE DTO rejects browser-supplied `trackId` as `400` without changing the owned temporal row. PostgreSQL Track/Annotation/Job/JobEvent snapshots, isolated Redis/BullMQ, `phase019-video/` MinIO objects, GitHub counter, and redaction assertions all remained clean.

T042 remains open: these cases do not yet constitute its complete operation-by-actor, malformed/unknown-resource, and provider-evidence matrix.

## T026 coverage-ledger and persisted keyframe-kind checkpoint — 2026-07-30

- The audited Test-ID ledger is [t026-coverage-ledger.md](./t026-coverage-ledger.md). It maps existing current-source evidence to the documented `TC`, `TU`, `TD`, `KC`, `KP`, `KD`, and `S` matrix groups before adding any test.
- `... tests/auth-ownership/video-keyframe-persisted-kind.test.ts` with normal opaque-cookie authentication, Redis DB 15 / `fieldframe-phase019-test`, MinIO `phase019-video/`, and the GitHub fixture counter — **5 passed, 0 failed, 0 skipped** (2.41 s). It proves canonical PATCH conceals a VIDEO Annotation with no Track, a Track-linked non-keyframe, a persisted interpolated fixture, and a Track-linked row missing `timestampMs`; canonical DELETE conceals the non-keyframe/interpolated fixtures. Each test independently preserved target durable fields, Track revision, Job/JobEvent counts, isolated queue state, MinIO object set, and GitHub request count.
- A genuine regression was fixed in `video-keyframe-service.ts`: PATCH and DELETE now require a resolved persisted VIDEO `BOUNDING_BOX` keyframe with non-null `timestampMs` before access/revision logic. A malformed persisted row no longer reaches semantic validation or reveals itself as a `400` request failure.
- The affected web image was rebuilt and recreated successfully: `COMPOSE_BAKE=false docker compose build --progress=plain web && docker compose up -d --force-recreate web` — exit 0; `/login` returned 200.
- Current source runtime matrix command for `tests/auth-ownership/video-track-keyframe.test.ts` — **5 passed, 0 failed, 0 skipped** (3.38 s). The focused service/real-PostgreSQL command for Track contract, keyframe contract, and race suites — **12 passed, 0 failed, 0 skipped** (3.31 s), including same-revision conflict mapping, duplicate timestamp rollback, and atomic delete/update outcomes.

T026 remains open. The ledger still identifies missing independent HTTP evidence for the full Track update/delete and keyframe DELETE actor matrices, plus explicit service-level mismatched Asset/Dataset relationship tests. A requested final lint execution was not attempted after the environment's external execution approval was denied due to its usage limit; no lint result is claimed for this checkpoint.
