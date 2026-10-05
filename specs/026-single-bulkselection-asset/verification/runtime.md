# T077–T087 (pre-write portion) — runtime and browser verification

Date: 2026-09-24. User-authorized rebuild of the dev `web` (3×) and `worker` (1×) containers; only those two were rebuilt/restarted, and the worker was stopped/started around scenarios that must not reach the provider. Real PostgreSQL, Redis (DB 15, prefix `annotation-platform`), MinIO, web, worker and the deployed AI Service. Disposable data only (datasets `rt026-*`, users `rt026-*@test.invalid`, MinIO objects under `evidence-026/rt/`); the stale `AiModel` was not touched. **HG-1 was not crossed: nothing attributes provider results to Assets or writes predictions.**

Scripts and raw per-check results are in the session scratchpad (`rt/state.json`); evidence lines below are copied from them. Browser checks were driven with the installed headless Google Chrome over the DevTools protocol (no packages added); screenshots were inspected.

## Result per task

| Task | Result | Evidence |
| --- | --- | --- |
| T077 rebuild/start services | **PASS** | `docker compose up -d --build web worker` (web again after two fixes); web/worker/realtime healthy; `/api/ai/tasks/preview` present (401 unauthenticated) |
| T078 current-Asset run to completion | **PENDING** | Completing an operation runs the existing prediction writer (attribution + writes) — excluded by the HG-1 instruction. Current-Asset acceptance/queueing/cancel is verified (below) |
| T079 select several same-modality Assets | **PASS** | Browser: 3 `IMAGE` assets ticked in the Assets tab → bulk bar "3 selected" |
| T080 one platform Job per batch | **PASS** | 3-asset EXPLICIT request (HTTP 202) → 1 `Job` (`AI_PREANNOTATE_DATASET`, `totalItems=3`) + 1 `AiTask`; same from the browser Run |
| T081 BullMQ transport is only `{jobId}` | **PASS** | Redis DB 15 job hash `data` for a current-Asset, a one-member EXPLICIT and a retry-successor Job each = `{"jobId":"…"}` exactly; no asset list, URL, model or configuration |
| T082 one external task for N inputs | **PARTIAL (unchecked)** | Real run: exactly one `externalTaskId` recorded and a reservation manifest of 3 inputs (digests only, no URL). The raw outbound request body was not captured at runtime (the service has no request echo); "exactly one POST with N `files`" is proven by the worker fault-injection tests |
| T083 every result maps to its Asset | **BLOCKED (HG-1)** | not started |
| T084 predictions persist after refresh | **BLOCKED (HG-1)** | not started |
| T085 Asset revision semantics | **BLOCKED (HG-1)** | not started |
| T086 mixed-modality creates no external task | **PASS** | Mixed IMAGE+VIDEO, VIDEO batch, AUDIO, over-limit, ineligible, foreign: all rejected (422/409) with **0 Jobs and 0 AiTasks** created; no external id for any rejected/queued/canceled/dispatch-failed operation |
| T087 delayed result vs review freeze | **BLOCKED (HG-1)** | not started |

## Pre-write pipeline checks (stage 1/2, real services)

PASS: previews (CURRENT_ASSET, EXPLICIT 3, FILTERED resolved server-side across the dataset — 3 matches; ineligible targets return `eligible:false` with reason and **no count/ids**; non-member 404; unauthenticated 401); create rejections before any provider work — 4 explicit assets and legacy 4 `assetIds` and a filtered match over the limit → **422 `TARGET_TOO_LARGE` (limit 3; nothing was submitted)**, mixed 422, VIDEO batch 409, missing size 422, missing storage location 422, foreign asset 409 (no per-id detail), `target`+`assetIds` 400, client-supplied `url` inside `target` 400, stale local model absent from the deployed catalog 409 `AI_MODEL_INACTIVE`, stale preview fingerprint after a source change 409 `TARGET_CHANGED`, non-member 404; accepted 3-asset batch (202) with target summary, versioned `Job.input` (3 ordered targets with digests, no URL); one real provider submission then cancel → operation CANCELED, all 3 targets CANCELED, none written; **real provider whole-batch failure** (one unreachable source object among 2 files): `PROVIDER_DEGRADED` (`failed_system`) was observed and handled non-terminally, then `failed` → task/Job FAILED, both targets FAILED with `AI_PROVIDER_FAILED`, counters reconciled, no annotations, **no signed-URL material, signature or storage host in any Job/AiTask row or the web/worker container logs**; batch read projection (counts, per-Asset outcomes, `retryable`) without provider/storage detail and concealed from a non-member; retry restrictions — canceled operation 409, provider-failed operation with a recorded external task 409 (no successor), non-member 404, dispatch-time failure (Asset archived after acceptance, no provider call) `retryable=true`, retry refused whole while a member is archived, then 4 concurrent retries → HTTP 201/200/200/200 and exactly one successor with its own AiTask, predecessor untouched, successor delivery `{jobId}`; single-Asset VIDEO through the unified path (accepted as one `AI_PREANNOTATE_ASSET`/VIDEO operation, AiTask type follows the model as before) and a VIDEO batch refused; CURRENT_ASSET and a one-member EXPLICIT selection create identical Job targets/projection.

## Browser checks (headless Chrome, logged-in UI)

All PASS: no selection → the existing panel targets the current Asset ("Run AI Detection"); selecting 3 assets → bulk bar "3 selected"; "AI Detect" opens the same panel showing "3 image assets selected · AI runs on at most 3 assets at a time" and "Run AI Detection on 3 assets"; 4 selected → reason states the limit (3, never 200) and Run unavailable; mixed image+video → "must all be the same type", Run unavailable; asset without a source → "cannot be processed", Run unavailable; "Clear selection" returns to the current-Asset target; a source changed after the preview → "The selection changed…", no Job created, no auto-resubmission (only "Try again"), preview refetched; Run on 3 selected → exactly one Job + AiTask (`EXPLICIT`, 3 targets); Cancel from the panel → operation CANCELED, panel text "This AI task was canceled.", never reached the provider. **SC-009 (five-annotator usability) remains PENDING** — no participants took part.

## Findings fixed during verification

1. **Cancel of a still-queued operation left `AiTask.status = QUEUED` forever** (Job CANCELED). `cancelAuthorizedAiTask` now closes the AiTask and accounts for every accepted target as CANCELED; tested (`ai-batch-task-creation.test.ts`). Older AiTask rows from earlier runs in the dev database still show QUEUED (not migrated).
2. After a successful cancel the panel kept the last polled status text ("Waiting for a worker…"); it now shows "This AI task was canceled."
3. The route rate-limits AI task requests to 10/minute/user and counts rejected requests too (existing behavior; the scripts paced around it).
4. Test-script mistakes (superseded, not product defects): an over-limit "filtered" query that matched only one asset; passing the provider key instead of the local model id when building the preview fingerprint; wrong `AiTask.type` expectation for VIDEO (it follows the model's task type, as before); a wrong response field in the concurrent-retry assertion; a stale-model expectation count.

## Disclosure — unintended exercise of the existing write path

An early stage-2 script aborted after enqueueing two current-Asset operations and its `finally` restarted the worker before cancelling them. The worker ran both to completion (`COMPLETED`/`SUCCEEDED`) through the **existing, pre-026 prediction writer** on one disposable Asset (0 Annotation rows were created; the panel later listed 5 previews from those runs). This was not intended, is not counted as evidence, and no HG-1-blocked task was marked. The script now cancels queued operations before restarting the worker.

## Still open

T078, T082 (raw body capture), T083–T085, T087 (HG-1), the runtime part of T095, T093 (latency), T094 / SC-009 (five real annotators), limit step-up beyond 3, expired-link/TTL at larger batches.
