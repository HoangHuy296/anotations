# Phase 018 Validation Guide

## Preconditions

- Controlled PostgreSQL, passworded Redis, private MinIO, web, and private
  worker services are healthy.
- The worker image approval for `ffprobe`/`ffmpeg` is recorded before rebuilding
  the worker image.
- Tests use normal opaque-cookie login; no `DEV_AUTH_EMAIL`, JWT, or browser
  credential bypass is permitted.
- Media fixtures are controlled, small except for the dedicated cancellation
  fixture, and contain no production credentials.

## Required validation scenarios

1. Schedule one VIDEO Asset and verify one durable Job, exact `{ jobId }`
   delivery, active claim, validated metadata, safe completion, and no public
   storage identity.
2. Schedule one AUDIO Asset and verify one durable Job, one private waveform
   derivative, canonical AudioAsset reconciliation, and safe readiness data.
3. Deliver the same Job to two workers, expire/reclaim a lock, retry each
   defined failure window, and verify one canonical child result/artifact.
4. Cancel a long audio fixture before claim, during processing, before
   reconciliation, and after a completed batch; verify no false completion and
   exact unreferenced-object cleanup only.
5. Run normal-cookie owner/member/foreign/unknown/malformed HTTP readiness and
   reconcile tests; audit Job/JobEvent/UI responses for redaction.
6. Open IMAGE, VIDEO, AUDIO, and TEXT Assets using the shared route; verify
   engine selection, VIDEO player/timeline/frame state, AUDIO readiness surface,
   and that non-IMAGE Assets never enter ImageCanvas.
7. Run repository-import/local-folder regressions, queue payload tests, worker
   typecheck/build, web typecheck/lint/build, Prisma validation/generation, and
   `git diff --check`.

## Evidence record rules

- Record each real suite separately with command, duration, pass/fail/skip,
  isolated Redis DB/prefix, MinIO derivative prefix, and normal-runtime
  restoration result.
- Never record or print database URLs, passwords, tokens, cookies, signed URLs,
  source/storage identities, or raw media-tool output.
- Do not mark a task complete on mocked storage/queue/database evidence.

## Executed foundation evidence

- 2026-07-29 — `pnpm --filter @fieldframe/domain build`: passed.
- 2026-07-29 — `node --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/media-processing/contracts.test.ts` from `apps/web`: 1 passed, 0 failed, 0 skipped.
- 2026-07-29 — `pnpm --filter @fieldframe/worker typecheck`,
  `pnpm --filter @fieldframe/web typecheck`, and
  `pnpm --filter @fieldframe/domain typecheck`: passed.

This evidence covers only T007's deterministic, credential-free identity and
finite-policy foundation. It is not worker-image, queue, storage, or runtime
evidence.

- 2026-07-29 — `node --import tsx tests/media/subprocess.test.ts` from
  `apps/worker`: 4 passed, 0 failed, 0 skipped (no-shell execution, bounded
  output, cancellation termination, and temp-workspace cleanup).
- 2026-07-29 — `pnpm --filter @fieldframe/worker typecheck`: passed after the
  media worker primitive addition.
- 2026-07-29 — `node --import tsx tests/media/source-materialization.test.ts`
  from `apps/worker`: 3 passed, 0 failed, 0 skipped (bounded verified source
  materialization and derivative cleanup scope guard). Real private-MinIO
  evidence remains required by the worker integration tasks.
- 2026-07-29 — `COMPOSE_BAKE=false docker compose build worker`: completed.
  The Docker Compose Bake path panicked before build execution; the documented
  internal-builder fallback completed the worker build. Validation inside the
  resulting private image used `docker compose run --rm --no-deps worker sh -lc
  'ffmpeg -version >/dev/null && ffprobe -version >/dev/null'` and returned
  `media-tools-ok` (no versions, credentials, or runtime configuration logged).
- 2026-07-29 — `node --import tsx tests/media/video-metadata.test.ts` from
  `apps/worker`: 2 passed, 0 failed, 0 skipped (bounded ffprobe parsing and
  malformed/unbounded output refusal). `@fieldframe/domain`, queue, web, and
  worker builds/typechecks passed after adding the VIDEO processor and route.
  Controlled PostgreSQL/MinIO worker evidence is still required for T015/T021.
- 2026-07-29 — `pnpm --filter @fieldframe/domain build`,
  `pnpm --filter @fieldframe/queue build`, `pnpm --filter @fieldframe/web
  typecheck`, `pnpm --filter @fieldframe/worker typecheck`, and `git diff
  --check`: passed after the server-only scheduling/readiness adapters. HTTP,
  PostgreSQL, Redis, and MinIO integration evidence remains open.

## Continued implementation evidence

- 2026-07-29 — `node --import tsx tests/media/waveform.test.ts` from
  `apps/worker`: 2 passed, 0 failed, 0 skipped. This covers bounded ffprobe
  audio metadata parsing, normalized waveform bucket serialization, and the
  versioned `fieldframe.audio-waveform.v1` artifact envelope.
- 2026-07-29 — `pnpm --filter @fieldframe/worker typecheck`,
  `pnpm --filter @fieldframe/worker build`, `pnpm --filter @fieldframe/queue
  build`, and `git diff --check`: passed after adding the AUDIO queue route,
  private processor foundation, bounded ffmpeg decode validation, and exact
  unreferenced derivative compensation guard.

These are source/unit/build results only. Controlled PostgreSQL, private
MinIO, isolated Redis, two-worker, authenticated HTTP, and cancellation
evidence remain open; Phase 018 is not closed.

- 2026-07-29 — `node --import tsx packages/queue/src/job-contract.test.ts`:
  1 passed, 0 failed, 0 skipped. The queue contract accepts both media Job
  types while strict payload parsing still rejects fields beyond `{ jobId }`.
- 2026-07-29 — focused worker media unit run (`waveform.test.ts`,
  `video-metadata.test.ts`, `subprocess.test.ts`, and
  `source-materialization.test.ts`): 11 passed, 0 failed, 0 skipped.
- 2026-07-29 — controlled Compose `MEDIA_RUNTIME_INTEGRATION_TESTS=1`
  audio vertical slice: 1 passed, 0 failed, 0 skipped. The test created one
  AUDIO Job, asserted exact `{ jobId }` delivery, and verified one private
  versioned derivative, one `AudioAsset`, one completion event, and no raw
  ffmpeg data in events.
- 2026-07-29 — controlled Compose two-worker
  `MEDIA_TWO_WORKER_INTEGRATION_TESTS=1` duplicate-delivery test: 1 passed,
  0 failed, 0 skipped. Two delivery records for one Job converged to one
  terminal completion and one AudioAsset reconciliation; the second worker
  could not produce a duplicate result.
- 2026-07-29 — rebuilt worker rerun after bounded PCM peak generation:
  `MEDIA_RUNTIME_INTEGRATION_TESTS=1 node --env-file-if-exists=.env --import
  tsx apps/worker/tests/media/audio-waveform-runtime.test.ts`: 1 passed, 0
  failed, 0 skipped; scaled two-worker rerun: 1 passed, 0 failed, 0 skipped.
- The waveform derivative prefix is `audio-waveforms/<dataset>/<asset>/`;
  compensation is restricted to that prefix and preserves referenced rows.
- 2026-07-29 — after prefix hardening, the rebuilt-worker audio vertical slice
  was rerun: 1 passed, 0 failed, 0 skipped. Worker typecheck/build and
  `git diff --check` passed; Compose was restored to one worker.
- 2026-07-29 — isolated broad `test:queue` with Redis DB 15 and prefix
  `fieldframe-phase018-test`: 26 tests, 22 passed, 0 failed, 4 intentional
  export/storage opt-in skips. Normal runtime was restored to one worker and
  the `annotation-platform` namespace after the two-worker run.
- 2026-07-29 — `pnpm exec prisma validate`, `pnpm exec prisma generate`,
  domain/queue/worker builds, web typecheck, and `git diff --check`: passed.
  `pnpm --filter @fieldframe/web build`: production build completed
  successfully (all routes generated; no secrets or runtime values recorded).
- 2026-07-29 — `pnpm --filter @fieldframe/worker test:repository-import`:
  27 tests, 13 passed, 0 failed, 14 explicit controlled-runtime skips. The
  non-runtime repository regressions remained green; skipped cases require
  their separately gated provider/MinIO/two-worker fixtures.
