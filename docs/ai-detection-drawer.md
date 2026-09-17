# AI detection drawer and class selection

The IMAGE and VIDEO AI Detection toolbox buttons open a non-modal drawer at the left edge of the workspace canvas, directly to the right of the toolbox on desktop. The drawer supports Escape, initial close-button focus, focus restoration, model selection, class checkboxes, select/clear all, loading errors, and retry. On the existing single-column mobile layout it sits within the canvas below the toolbox.

Selecting a model calls the authenticated application route `GET /api/ai/models/{modelId}/labels`. The route resolves the platform model ID through the active catalog and fetches `/api/v1/models/labels/{externalModelId}` server-side. It validates `success`, the returned model identity, and `data.classes`, returning only class names. The provider response format was verified with a live read on 2026-09-09.

All classes start selected. A model change clears the old selection, and late responses from previous selections are ignored. Run requires successfully loaded classes and at least one selection. Unconfigured models can be inspected but cannot run. VIDEO models can also be inspected, but Run remains disabled because the existing AIOZ adapter only implements IMAGE/DETECT_OBJECTS.

`POST /api/ai/tasks` now accepts optional `classes: string[]`. Provided lists must be nonempty, unique, bounded, and members of the selected model's current provider labels. The selection is saved in the existing PostgreSQL `AiTask.input` associated with its durable Job. The worker reloads it and overrides model-metadata class defaults for that task; per-task confidence and IoU thresholds override model metadata. New requests default both thresholds to 0.5. Existing persisted tasks without thresholds retain metadata defaults, falling back to 0.5. Legacy callers that omit classes retain metadata class defaults. Queue payloads remain `{jobId}`.

Dataset labels must already exist for predictions to become annotations: class selection does not create dataset labels or change the existing writer's unmatched-label policy.

## Completion report

Files created:

- `apps/web/src/app/api/ai/models/[modelId]/labels/route.ts`
- `apps/web/tests/ai/ai-model-labels.test.ts`
- `docs/ai-detection-drawer.md`

Existing files modified in this update (earlier uncommitted work preserved):

- `apps/web/src/app/api/ai/tasks/route.ts`
- `apps/web/src/components/workspace/ai-detect-dialog.tsx`
- `apps/web/src/components/workspace/image-engine.tsx`
- `apps/web/src/components/workspace/video-engine.tsx`
- `apps/web/src/lib/ai/ai-model-service.ts`
- `apps/web/src/lib/ai/ai-task-api-client.ts`
- `apps/web/src/lib/ai/ai-task-service.ts`
- `apps/web/src/lib/api-response.ts`
- `apps/web/src/lib/validation/ai-task.ts`
- `apps/worker/src/providers/ai/aioz-task-resources.ts`
- `apps/worker/tests/jobs/aioz-provider-pipeline.test.ts`

Commands to run from the repository root:

```bash
pnpm --filter @annotationplatform/web typecheck
pnpm --filter @annotationplatform/worker typecheck
```

Focused web regression checks, from `apps/web`:

```bash
node --require ./tests/auth-ownership/register-server-only.cjs --import tsx --test tests/ai/ai-model-labels.test.ts tests/ai/ai-model-catalog.test.ts tests/ai/ai-task-api-client.test.ts tests/ai/ai-detect-view.test.ts
```

Worker pipeline checks, from `apps/worker`, with local PostgreSQL available:

```bash
node --env-file=../../.env --import tsx --test tests/jobs/aioz-provider-pipeline.test.ts
```

Verification: all four focused web test files passed; all 11 worker pipeline tests passed against PostgreSQL with external detection HTTP mocked, including persistence-to-provider class override. Web and worker typechecks and focused web ESLint passed. No interactive browser or live detection run was performed.

Environment variables: no additions. Uses existing web `AIOZ_ANNOTATION_SERVICES_BASE_URL`; worker uses existing `AIOZ_ANNOTATION_SERVICES_URL`, `AIOZ_COMPANY_API_KEY`, and `MINIO_PUBLIC_ENDPOINT`, together with existing database, queue, and MinIO configuration.

Database migration changes: None.

Known limitations: video execution is unavailable in the current provider adapter; unconfigured models cannot run; selected classes still require matching dataset labels. Browser appearance has not been interactively verified.

Next recommended phase: validate the IMAGE flow in the running workspace. VIDEO execution needs its own approved provider/annotation contract before implementation. This update does not implement future phases early.


## Threshold controls and execution (2026-09-10)

The drawer includes Confidence threshold and IoU threshold number controls, initially 0.5. Right-side buttons and arrow keys adjust by 0.1 and clamp to [0, 1]. Manual decimals such as 0.55 and 0.65 are accepted without rounding to a step multiple. Empty or out-of-range values disable Run; server validation independently rejects invalid numbers.

Run sends selected classes and numeric `confidence_threshold` / `iou_threshold` to same-origin `POST /api/ai/tasks` (on `10.0.0.123:3001` when served there). The API persists these values in `AiTask.input` alongside a durable Job before enqueueing `{jobId}`. The worker signs the selected assets' MinIO images, submits `task_name`, `files`, external `model_id`, classes, and thresholds to `/api/v1/tasks/create`, and saves the returned ID in `AiTask.externalTaskId`. Existing polling calls `/api/v1/tasks/result/{task_id}` and uses `normalizeAiozOutput` before the existing annotation writer. The supplied image URLs are examples; actual requests use the selected assets' signed URLs.

Files created: none. Modified for this update: the drawer, AI request client/service/schema, worker AIOZ task resources, web model-label tests, worker provider-pipeline tests, and this document. No environment variables, packages, or database migrations were added. Existing environment configuration described above still applies.

Verification: web and worker typechecks, focused ESLint, three focused web test files, provider and normalization test files, and all 11 PostgreSQL pipeline tests passed. The pipeline confirms decimal threshold overrides and external ID persistence through polling and annotation writes with mocked external HTTP. No live detection request or interactive browser verification was performed.

Commands: use the typecheck and focused test commands above; provider/normalization tests can additionally be run from `apps/worker` with `node --import tsx --test tests/providers/ai/aioz-annotation-services-provider.test.ts tests/providers/ai/aioz-annotation-services-normalization.test.ts`.

Next recommended step: verify the controls and run IMAGE detection in the deployed workspace with an active configured model, reachable MinIO assets, and matching dataset labels. Existing video and unconfigured-model limitations still apply.

## Result-display diagnosis (2026-09-10)

Inspected AiTask `cmtvdi9q001wfof0khnzont6d`, external task `80cd746b-5888-44e5-b8e2-969c90829294`, through read-only Prisma queries. AiTask is SUCCEEDED and its Job is COMPLETED. Stored normalized output contains five predictions: motorcycle, car, bus, bicycle, and boat. There are zero persisted annotations for this task. None of these class names matches the dataset's current normalized label names, so the existing writer skips them.

The existing worker already calls the result endpoint with externalTaskId, normalizes successful output, and stores predictions. The workspace displays persisted annotations, not all normalized predictions. Unmatched-class presentation (preview, new labels, or explicit label mapping) requires a product choice; no dataset labels or task records were changed during this diagnosis.

Completion report for the diagnostic wording fix:

- Files created: None.
- Files modified: `apps/web/src/components/workspace/ai-detect-dialog.tsx`, `docs/ai-detection-drawer.md`.
- Commands to run: from `apps/web`, `pnpm exec eslint src/components/workspace/ai-detect-dialog.tsx`.
- Environment variables needed: None added.
- Database migration changes: None.
- Known limitations: unmatched predictions remain stored in AiTask output and do not appear as canvas annotations. The drawer now correctly says that no draft annotations were added instead of claiming the provider returned no detections.
- Next recommended phase: choose the unmatched-class display behavior before implementing it. No future phases were implemented early.
