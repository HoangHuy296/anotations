# AIOZ Annotation Services adapter

## User-approved execution flow (2026-09-10)

The user approved real AIOZ provider execution for AI Detect. Use provider
`aioz-company` and the service origin configured by `AIOZ_ANNOTATION_SERVICES_URL`:

1. The private worker sends `POST /api/v1/tasks/create` with the selected
   model, asset URLs, classes, confidence threshold, and IoU threshold.
2. Persist the returned `data.task_id` in PostgreSQL `AiTask.externalTaskId`.
3. Poll `GET /api/v1/tasks/result/{task_id}` using that persisted ID.
4. On success, normalize the returned detections and persist/render the
   resulting annotations through the existing pipeline.

The supplied ID `0d850d22-c6d0-4a9e-ac96-25c6f977164a` is an example;
never hardcode it for new tasks. Application execution must use real HTTP
requests, with no fallback to the deterministic test provider or fixture
responses. HTTP mocks remain appropriate for automated tests. Provider
requests and credentials remain worker-side. This approval records intended
runtime behavior; it is not evidence that a live detection run succeeded.

The worker adapter lives in `apps/worker/src/providers/ai/aioz-annotation-services-provider.ts` and implements the existing `AiProviderAdapter`. The registry resolves `AiTask.modelId -> AiModel.provider = aioz-company`. The deterministic `aioz-test-result` adapter remains available outside production.

## Contract confirmed 2026-09-09

The service OpenAPI and the supplied successful two-image response define:

- `POST /api/v1/tasks/create`, JSON, `API-Key` authentication. Request: `task_name: "image"`, `files: string[]`, `model_id: UUID`, and optional `classes`, `confidence_threshold`, `iou_threshold`.
- Creation response: `success`, `data.task_id`, `data.status`, `data.created_at`. The adapter saves `data.task_id` in existing `AiTask.externalTaskId`.
- `GET /api/v1/tasks/result/{task_id}` returns `success` and `data` containing `task_id`, `status`, `output`, `error`.
- `create`/`pending` map to `PENDING`; `inprocess` maps to `IN_PROGRESS`; `success` maps to `COMPLETED`; `failed`, `success: false`, or any non-null `error` fail the task. Unknown statuses fail closed.
- Each `output[]` contains `width`, `height`, `image_path`, `class_names`, and `outputs[]`. Each prediction contains `box`, `score`, `class_id`, and `class_name`.
- `image_path` is an exact echo of an input URL. The adapter never uses array position to associate assets.

The confirmed `box` is original-image pixel `[xmin, ymin, xmax, ymax]`. Conversion is full precision:

```ts
{ x: xmin / width, y: ymin / height,
  width: (xmax - xmin) / width, height: (ymax - ymin) / height }
```

The existing strict geometry validator accepts only those four fields. `BOUNDING_BOX` is the separate `Annotation.type`; adding `kind` to geometry would violate that validator. Dimensions must be positive and finite; scores must be finite in `[0,1]`; coordinates must be finite, in bounds, and form positive-area boxes. Invalid data is rejected without clamping. Empty detections are valid only with one explicit output object per submitted image.

`class_name` maps to `labelKey` and `score` to `confidence`. The existing writer resolves dataset labels; missing labels are skipped under its existing policy. This adapter does not create labels. The writer remains the sole Annotation persistence path and creates standard AI/DRAFT bounding boxes.

## Configuration and automatic model discovery

Opening an image AI Toolbox tool calls the authenticated Next.js model route with
`modality=IMAGE&task_name=<tool>`. Video's AI Tracking tool sends
`modality=VIDEO&task_name=tracking`. Next.js calls `/api/v1/models/list` with
lowercase `type` and the selected `task_name`, then validates both fields in each
result. Concurrent reads share a request only when both filters match. Reopening
or retrying reloads the provider catalog. The browser never calls AIOZ directly.

For a discovered `image / detection` model, Next.js automatically creates its
`AiModel` reference with the provider UUID, display name, and the worker's
`DETECT_OBJECTS` task type. The existing unique key arbitrates concurrent
registration. Existing rows are reused without modifying metadata, provider,
capability, or activation state. Inactive or other-provider rows are excluded;
capability conflicts remain unavailable for execution. There is no fixed model
UUID or required registration command.

Video tracking is executable through the video contract documented below. It
registers a `VIDEO / DETECT_OBJECTS` model; the provider-facing catalog task remains
`tracking`. Other image tasks remain discoverable but not executable. Discovery
does not register these unsupported capabilities. Unfiltered catalog reads do not register
models. All task submissions still use internal model IDs and the existing
authorization, Job creation, and worker pipeline.

- `AIOZ_ANNOTATION_SERVICES_URL`: shared server-side URL for web and worker.
  Both Compose files pass it to both processes. There is no implicit endpoint. Both processes accept the older
  `AIOZ_ANNOTATION_SERVICES_BASE_URL` and `AIOZ_COMPANY_API_BASE_URL` aliases
  when the canonical variable is absent.
- `AIOZ_COMPANY_API_KEY`: worker-only secret for prediction requests. Catalog and
  class discovery currently require no authentication upstream.
- `AIOZ_ANNOTATION_SERVICES_TIMEOUT_MS`: worker request timeout. Web catalog/class
  reads use a 15-second timeout and reject redirects.
- `MINIO_PUBLIC_ENDPOINT`: must be reachable by the AIOZ host and worker for
  prediction image URLs.

Optional model defaults can still live in existing model metadata:

```json
{"aioz":{"classes":["person","car"],"confidence_threshold":0.5,"iou_threshold":0.5}}
```

The optional operator utility remains available for explicit registration:

```bash
node --env-file=.env --import tsx scripts/register-aioz-model.ts --apply <model-uuid> "<display-name>"
```

It accepts only the implemented image-detection capability and rejects conflicts.
Toolbox users do not need this utility. No environment files, existing model rows,
or migrations were rewritten as part of implementing automatic discovery.

## Durability, cancellation, and retry limits

Only stored MinIO images or valid cached MinIO image binaries are supported. Remote-only assets must be materialized through the existing import/cache path first; raw provider/source URLs are not forwarded. The worker signs an object-specific GET capability with a 20-minute expiry, exceeding the existing 15-minute polling budget.

Before submission, a conditional Prisma update reserves `AiTask.summary.aiozSubmission` with version 1, phase `SUBMITTING`, and `{assetId,urlDigest}` entries. The digest is SHA-256 of the exact submitted URL. No signed URL or key is persisted. Subsequent polls reload that manifest from PostgreSQL using `externalTaskId`, hash the returned `image_path`, and associate the current raw output without dependence on process memory or array ordering.

The external ID and `nextPollAt` are saved together, so a crash before the submit processor's remaining bookkeeping still leaves a discoverable task for the existing scanner. Same-task re-entry with an ID reuses it without another POST. A competing reservation loses without submitting.

AIOZ documents no idempotency key, cancellation endpoint, or lookup by client correlation ID. A crash/timeout after external acceptance but before saving its ID cannot be automatically reconciled. The reservation causes later same-task submission to fail with `AIOZ_SUBMISSION_AMBIGUOUS`; do not clear it and resubmit blindly. The generic Job retry service currently rejects AI job types; it does not create an AI successor. A newly submitted AI task may create another external task. This implementation cannot promise exactly-once external creation across that remote/local commit gap.

There is no new queue or polling loop. The existing PostgreSQL scanner uses 2-second exponential backoff capped at 30 seconds, 60 polls, and a 15-minute budget. Local cancellation is checked before the HTTP request and again after it returns. An external task may continue running after local cancellation. HTTP/network/timeout/invalid-response failures become safe terminal failures; no upstream response body is copied into durable errors. Failed polls are not silently treated as successful empty results.

The Annotation writer conditionally claims completion inside its transaction, preventing duplicate persistence on replay and preventing an already accepted cancellation from committing predictions. Failure of any annotation write rolls back Job completion and Asset changes together. Queue payloads remain `{jobId}`; no schema migration is needed.

## Verification

Unit tests mock HTTP and use the supplied real pixel values. PostgreSQL pipeline tests use isolated fixtures and mock only external HTTP/URL signing; they exercise the real registry contract, resources, submit processor, scanner-compatible poll processor, and Annotation writer.

```bash
cd apps/worker
node --env-file=../../.env --import tsx --test --test-concurrency=1 \
  tests/jobs/ai-*.test.ts tests/jobs/aioz-provider-pipeline.test.ts tests/providers/ai/*.test.ts
```

Normal tests do not call the colleague's service. Live prediction additionally requires a configured key/model, externally reachable MinIO images, and the desired dataset labels. A passing mocked-HTTP PostgreSQL test is not a live AIOZ prediction claim.

### Verification evidence (2026-09-09)

- AI worker/provider suite: 55 passed, zero skipped, with real PostgreSQL and mocked external HTTP/signing. Includes replay, concurrent submission reservation, cancellation during polling, transaction rollback, and review-frozen Asset protection.
- Focused Phase 023 revision/stale-review/workflow-integrity regressions: four passed against PostgreSQL.
- Strict standalone typechecking of the new test files passed (worker production typecheck excludes tests).
- Canonical production build passed after moving the prior `.next` directory to a recoverable temporary backup. No migration, generated Prisma edit, dependency installation, or live external prediction was required.

## Automatic discovery completion report (2026-09-11)

1. **Files created:** None. Some modified files were already untracked before this change.
2. **Files modified:**
   - `.env.example`
   - `apps/web/src/app/api/ai/models/route.ts`
   - `apps/web/src/components/workspace/ai-detect-dialog.tsx`
   - `apps/web/src/components/workspace/video-engine.tsx`
   - `apps/web/src/components/workspace/video-toolbox.tsx`
   - `apps/web/src/lib/ai/ai-detect-view.ts`
   - `apps/web/src/lib/ai/ai-model-service.ts`
   - `apps/web/src/lib/ai/ai-task-api-client.ts`
   - `apps/web/src/types/ai.ts`
   - `apps/web/tests/ai/ai-model-catalog.test.ts`
   - `apps/web/tests/ai/ai-task-api-client.test.ts`
   - `apps/worker/src/providers/ai/aioz-model-registration.ts`
   - `apps/worker/tests/providers/ai/aioz-model-registration.test.ts`
   - `scripts/register-aioz-model.ts`
   - `docker-compose.yaml`
   - `docker-compose.review.yaml`
   - `docs/aioz-annotation-services.md`
3. **Commands to run:**

   ```bash
   pnpm --filter @annotationplatform/web typecheck
   pnpm --filter @annotationplatform/worker typecheck
   cd apps/web
   node --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/ai/ai-model-catalog.test.ts tests/ai/ai-task-api-client.test.ts tests/ai/ai-model-labels.test.ts tests/ai/ai-detect-view.test.ts
   ```

   Both typechecks, all four focused test files, and ESLint on the changed web
   files passed. The optional worker registration validation passed; its database
   integration test was skipped without a configured test database. Live read-only
   checks confirmed `task_name` in both image/detection and video/tracking responses.
4. **Environment variables needed:** `AIOZ_ANNOTATION_SERVICES_URL` for catalog
   configuration; existing task execution uses `DATABASE_URL`,
   `AIOZ_COMPANY_API_KEY`, and `MINIO_PUBLIC_ENDPOINT` plus existing queue/storage settings.
5. **Database migration changes:** None. Automatic discovery uses the existing
   `AiModel` table and unique key.
6. **Known limitations:** Video tracking and non-detection image tasks are
   discoverable but execution remains unsupported. The browser UI and live
   prediction execution were not exercised. Existing disabled/conflicting model
   records retain their restrictions. Deploy/restart the changed application to
   use discovery in an already-running environment.
7. **Next recommended phase:** No new phase proposed; validate this change in the
   intended deployed workspace. No future processing phase was implemented early.


## Task-type correction (2026-09-11)

The earlier `VIDEO / DETECT_OBJECTS` mapping was incorrect. New tasks now use
`TRACKING / VIDEO`; image tasks use `DETECTION / IMAGE`. These values correspond
to the provider model catalog's `task_name` and `type`, respectively, normalized
to the platform's uppercase enum convention. The task-creation endpoint has a
separate contract: its `task_name` is still `video` or `image`, as confirmed in
the supplied successful request.

The failed task `cmtwmtx4r00ey1045of4idj5j` has no external task ID. Inspection of
the running development worker confirmed it rejects every non-IMAGE task before
submission. Therefore changing the browser payload alone cannot fix this
failure: the updated private worker must be rebuilt and restarted.

The additive migration `20260911090000_ai_provider_task_types` adds `DETECTION`
and `TRACKING` without deleting legacy values or changing historical task rows.
When the Toolbox reloads a supported model, discovery upgrades only its legacy
`DETECT_OBJECTS` model capability using fresh provider metadata and a conditional
Prisma update. It preserves the model ID, activation setting, and metadata.
Historical tasks retain their recorded type and terminal outcome. The worker
continues accepting legacy task snapshots, and image prediction reads support
both `DETECT_OBJECTS` and `DETECTION`.

Completion status for this correction:

1. **Files created:** `prisma/migrations/20260911090000_ai_provider_task_types/migration.sql`.
2. **Files modified:** `prisma/schema.prisma`,
   `apps/web/src/lib/ai/ai-model-service.ts`,
   `apps/web/src/lib/ai/ai-task-service.ts`,
   `apps/web/src/lib/ai/ai-prediction-results.ts`,
   `apps/worker/src/providers/ai/aioz-task-resources.ts`,
   `apps/worker/src/providers/ai/aioz-model-registration.ts`,
   `apps/worker/src/jobs/ai-prediction-writer.ts`,
   `apps/worker/src/jobs/ai-video-prediction-writer.ts`,
   `scripts/register-aioz-model.ts`,
   `apps/web/tests/ai/ai-model-catalog.test.ts`,
   `apps/worker/tests/providers/ai/aioz-model-registration.test.ts`,
   `apps/worker/tests/jobs/aioz-video-pipeline.test.ts`, and this document.
3. **Commands to run after required approval:** `pnpm exec prisma generate`,
   `pnpm exec prisma migrate deploy`, `pnpm typecheck`, and the video/image
   pipeline commands below. Rebuild/restart the development worker before
   creating a new Toolbox task. Catalog regression tests pass; generated-client
   typechecking and new-enum database tests await approval.
4. **Environment variables needed:** Existing database, provider, and queue
   configuration only.
5. **Database migration changes:** Two additive enum values. Applying the
   migration and regenerating the client are pending explicit approval.
6. **Known limitations:** The existing failed task is unchanged. Local source
   edits alone do not replace the running image-only worker. The older mapping
   described in the historical report below is superseded by this correction.
7. **Next recommended phase:** Finish generation, migration, regression checks,
   and deployment of this correction. No future feature phase was implemented.

## Video tracking contract (2026-09-11)

The existing external task `7632d9ff-dc0a-43ac-9bc3-eb291f28c70b` was fetched
successfully. Its output describes a 1280 × 720 video at 29.907 FPS with 850
frames, 10 track identities, and 38 observations. The normalized, URL-free result
is saved in `artifacts/ai-video/normalized-result.json`. This is an inspection
artifact; the externally created task has not been imported into the dataset.

### Submission and polling

The Toolbox discovers models with `type=video&task_name=tracking`. The authenticated
Next.js task route checks dataset permissions and model/asset modality, creates
the existing durable Job and AiTask, then enqueues only `{jobId}`. The database
uses the existing `VIDEO / DETECT_OBJECTS` capability for object detection across
frames; no new enum or schema is required.

The private worker generates fresh object-scoped MinIO capabilities and submits:

```json
{
  "task_name": "video",
  "files": ["<worker-generated object-scoped view URL>"],
  "model_id": "<discovered provider model UUID>",
  "classes": ["person", "bicycle", "car"],
  "confidence_threshold": 0.5,
  "iou_threshold": 0.5
}
```

The response's `data.task_id` is saved as `AiTask.externalTaskId`. The existing
scanner calls `GET /api/v1/tasks/result/{task_id}`. Polls use PostgreSQL to recover
the expected media type and URL digests. `video_path` must match exactly the URL
submitted for that Asset, regardless of output order. URLs and provider response
bodies remain transient; no signed URL is written into Job input, results, or
annotation properties. Submission reservation, cancellation, timeout, and ambiguous
external-acceptance behavior are the same as the image pipeline.

### Output mapping

| Provider field | Platform field/behavior |
| --- | --- |
| `video_path` | Resolve Asset using the durable submitted URL digest |
| `width`, `height` | Convert pixel `bbox_xyxy` to existing frame-relative `Annotation.geometry` |
| `frame_id` | `Annotation.frameIndex` (zero-based) |
| `fps` | `timestampMs = round(frame_id * 1000 / fps)` |
| `track_id` | A new `VideoObjectTrack` scoped to this task and Asset; retained as `properties.providerTrackId` |
| `bbox_xyxy` | `{kind: "BOUNDING_BOX", x: xmin/width, y: ymin/height, width: (xmax-xmin)/width, height: (ymax-ymin)/height}` |
| `score` | `Annotation.properties.confidence` |
| `class_id`, `class_name` | Safe prediction provenance; resolve matching VIDEO-compatible dataset labels when available |
| Empty `tracks` | No keyframe; no inferred object or interpolation |

For example, frame 54 becomes timestamp 1806 ms. All observed boxes become
`source=AI`, `status=DRAFT`, revision 1 keyframes under their corresponding track.
Tracks default to interpolation `NONE`, so gaps remain empty. The workspace
merges completed results without replacing local edits and displays AI boxes at
the matching playback frame. Existing manual annotations are preserved.

The supplied output labels every observation `unknown`, with class IDs such as
56 and 33 despite the requested person/bicycle/car list. These are retained as
unlabeled draft tracks. The platform does not use `class_names` as a positional
lookup for those IDs, invent dataset labels, or silently discard the observations.
The provider's class filtering/mapping needs investigation separately.

Video validation rejects failed per-file results, invalid FPS, truncated or
duplicate frames, duplicate track observations, class-ID changes within a track,
invalid boxes, and mismatched input associations before persistence. Pixel bounds
are strict; normalized edge rounding is capped only after valid pixel bounds are
confirmed (the supplied frame 330 exercises this floating-point case).

Tracks and keyframes commit in one Prisma transaction with the Job terminal
transition, guarded by worker lock ownership and cancellation state. Replayed
completion cannot append duplicate tracks. Reviewed/frozen assets receive no
late writes. Annotation insert failure rolls back tracks, asset revisions, and
Job completion together. Video task output stores safe counts; canonical results
live in VideoObjectTrack and Annotation.

### Video completion report

1. **Files created:**
   - `apps/worker/src/providers/ai/aioz-video-normalization.ts`
   - `apps/worker/src/jobs/ai-video-prediction-writer.ts`
   - `apps/worker/tests/providers/ai/aioz-video-normalization.test.ts`
   - `apps/worker/tests/providers/ai/fixtures/aioz-video-output.json`
   - `apps/worker/tests/jobs/aioz-video-pipeline.test.ts`
   - `apps/web/tests/ai/video-ai-results.test.ts`
   - `artifacts/ai-video/normalized-result.json`
2. **Files modified:**
   - `packages/domain/src/ai-provider.ts`
   - `apps/worker/src/providers/ai/aioz-annotation-services-provider.ts`
   - `apps/worker/src/providers/ai/aioz-task-resources.ts`
   - `apps/worker/src/jobs/ai-prediction-writer.ts`
   - `apps/web/src/lib/ai/ai-model-service.ts`
   - `apps/web/src/lib/ai/ai-task-service.ts`
   - `apps/web/src/lib/ai/ai-detect-view.ts`
   - `apps/web/src/components/workspace/ai-detect-dialog.tsx`
   - `apps/web/src/components/workspace/video-engine.tsx`
   - `apps/web/src/lib/workspace/video-annotation-client.ts`
   - `apps/web/src/stores/video-annotation-store.ts`
   - `apps/web/tests/ai/ai-model-catalog.test.ts`
   - `docs/aioz-annotation-services.md`
3. **Commands to run:**

   ```bash
   pnpm --filter @annotationplatform/domain build
   pnpm --filter @annotationplatform/worker typecheck
   pnpm --filter @annotationplatform/web typecheck
   cd apps/worker
   node --env-file=../../.env --import tsx --test --test-concurrency=1 tests/jobs/aioz-video-pipeline.test.ts tests/jobs/aioz-provider-pipeline.test.ts tests/providers/ai/aioz-video-normalization.test.ts tests/providers/ai/aioz-annotation-services-provider.test.ts tests/providers/ai/aioz-annotation-services-normalization.test.ts
   cd ../web
   node --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/ai/video-ai-results.test.ts tests/ai/ai-model-catalog.test.ts tests/ai/ai-detect-view.test.ts tests/ai/ai-task-api-client.test.ts
   ```

   The 14 image/video PostgreSQL pipeline regression tests passed with real
   database transactions and mocked external HTTP/signing. Live GET verified the
   supplied task; no second external task was submitted.
4. **Environment variables needed:** Existing `DATABASE_URL`,
   `AIOZ_ANNOTATION_SERVICES_URL`, `AIOZ_COMPANY_API_KEY`, `MINIO_PUBLIC_ENDPOINT`,
   and the existing MinIO/queue settings. No additional variables.
5. **Database migration changes:** None; generated Prisma files were not changed.
6. **Known limitations:** Constant FPS timestamps follow this provider contract;
   variable-frame-rate timestamps are not supplied. Existing video reads are
   bounded to 100 tracks and 1,000 annotation rows; large results may not all be
   visible in the current UI. Provider responses remain limited to 8 MiB and the
   existing 15-minute poll budget. Browser end-to-end execution and deployment
   were not performed. The manually created external task remains an inspection
   result rather than a platform Job; starting a Toolbox task uses the managed
   lifecycle and new signed URLs.
7. **Next recommended phase:** Validate the current change in the deployed video
   workspace. This implements the requested video contract only; other image
   tools and future processing phases remain unchanged.
