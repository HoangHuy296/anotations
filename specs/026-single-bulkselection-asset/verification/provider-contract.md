# T006 — deployed AI Service contract evidence (E1)

Date: 2026-09-24 (07:29–07:31 UTC). Authorization: the user's controlled provider-evidence run only (disposable data, configured credentials). No production code, DB rows, annotations or dataset content were touched. Redacted: API key, `API-Key` header, all signed-URL query strings, and the AI Service / MinIO endpoint values (both are private-LAN addresses, plain `http`).

Legend: **PASS** = observed/verified here; **FAIL** = observed to contradict the current adapter or requirement; **UNPROVEN** = not exercised or not contractually guaranteed.

## Gate matrix (this artifact)

| Requirement | Result | Evidence |
| --- | --- | --- |
| Version-identifiable deployed contract | **PASS (schema)** / build id **UNPROVEN** | Unauthenticated `GET /openapi.json` → OpenAPI 3.1.0, `info.title="annotation-services"`, `info.version="0.1.0"`. No build/commit id is exposed. |
| One `POST /api/v1/tasks/create` accepting N>2 files | **PASS at N=3** | Task A: 3 `files`, HTTP 202, one `task_id`. Repeated (task B) and at N=2 (tasks C, D). |
| Maximum files / payload / response size | **UNPROVEN** | OpenAPI declares `files` as an unbounded nullable string array; only N≤3 exercised. The platform ceiling of 200 is **not** provider-verified. |
| Actual external task identity | **PASS** | UUID `task_id` returned by create (e.g. `91d0b23e-…8ae9`); create response `{success, message, data:{task_id,status:"create",created_at}}`. |
| Scalar vs array `model_id` | **PASS** | OpenAPI: `model_id` is `string \| null` (scalar). `input.md`'s array example is wrong. |
| `task_name` doc-vs-adapter disagreement | **RESOLVED** | Deployed schema requires `type` (`image\|audio\|video`) and `task_name` (`detection\|segmentation\|oriented_detection\|classification\|ocr\|transcribe\|tracking`). The adapter (`type:"image", task_name:"detection"`) is right; `docs/aioz-annotation-services.md` line 28 (`task_name:"image"`) is wrong and must be corrected. The deployed request was accepted with the adapter's shape. |
| Status/result response | **PASS (success path)** / **FAIL (status set)** | `GET /api/v1/tasks/result/{task_id}` → `{success,message,data:{task_id,status,output[]\|null,error\|null,created_at,updated_at}}`. Observed statuses: `create`, `inprocess`, `success`, `failed`, **`failed_system`** — the last is absent from the adapter's zod enum (`create\|pending\|inprocess\|failed\|success`); see Findings F3. |
| IMAGE/VIDEO/AUDIO matrix | IMAGE detection **PASS**; VIDEO tracking **UNPROVEN**; AUDIO out of scope | Deployed model list (`GET /api/v1/models/list`, 3 models): `image/detection` (`68d7f474-…`), `video/tracking`, `audio/transcribe`. Only the image model was exercised. |
| Cancellation endpoint | **PASS (unsupported)** | The complete OpenAPI path list has no cancel route (see below). |
| Idempotency / lookup by client id | **PASS (absent)** | No idempotency parameter or lookup route in OpenAPI; identical repeated POST created a second task (recovery-contract.md). |

## Deployed OpenAPI (unauthenticated `GET /openapi.json`, 18,102 bytes)

Paths: `GET /`, `GET /health`, `POST /api/v1/models/create`, `GET /api/v1/models/list`, `GET|PATCH|DELETE /api/v1/models/{model_id}`, `GET /api/v1/models/labels/{model_id}`, `GET /api/v1/tasks/result/{task_id}/format`, `POST /api/v1/tasks/create`, `GET /api/v1/tasks/result/{task_id}`. There is **no** cancel, list-tasks, idempotency or client-id lookup route.

`AnnotationTaskRequest` required: `type`, `task_name`; optional nullable: `files` (string[]), `model_id` (string), `classes` (string[]), `confidence_threshold`, `iou_threshold` (numbers). `AnnotationTaskResponse.output` is `array of free-form objects | null` — **the per-item shape and the correlation field are not specified by the schema**; they are known only from observation (correlation.md).

## Exercised requests (all `type:"image"`, `task_name:"detection"`, `confidence_threshold=0.5`, `iou_threshold=0.5`)

| Run | Files | HTTP | Timeline (ms from POST) | Terminal |
| --- | --- | --- | --- | --- |
| attempt 1 (stale model) | 3 | **422** | — | `detail: "Model with ID 0307ee22-… does not exist in the database."` |
| A | 3 | 202 | create 71 → inprocess 2,080 → success 14,134 | success, 3 groups |
| B (identical retry of A) | 3 | 202 | 55 → 2,069 → 14,125 | success, 3 groups |
| C (duplicate URL ×2) | 2 | 202 | 23 → 2,030 → 14,075 | success, 2 groups |
| D (1 valid + 1 unreachable) | 2 | 202 | 24 → 2,035 → failed_system 12,069 → inprocess 14,076 → failed_system 24,110 → inprocess 28,123 → failed_system 40,163 → inprocess 44,178 → **failed 54,212** | failed, `output:null` |

Test data: two public sample images (810×1080 and 1280×720) and one generated flat-gray 640×480 image, uploaded as three objects `…/a/img.jpg`, `…/b/img.jpg`, `…/c/img.jpg` (same basename, different keys) under a disposable `evidence-026/<run>/` prefix of the configured bucket, and **removed afterwards** (3 objects). No database rows were created or modified.

## Findings

- **F1 — stale local model catalog.** The local `AiModel` row for `YOLO26s_COCO` uses provider id `0307ee22-5bfa-4f68-bcb5-42fef7d26de3`; the deployed service rejects it (422). The deployed image/detection model is `68d7f474-6982-446c-8c5a-121d56d12dc9`. The real-runtime proof (T077+) needs the local catalog registered against the deployed model (existing `scripts/register-aioz-model.ts`, **not run** here).
- **F2 — provider errors echo the full signed URL.** Task D's `error` string contained the complete signed submission URL. Raw provider error text must never be persisted, logged or shown (the adapter already avoids copying it; this proves the rule is load-bearing).
- **F3 — `failed_system` is a real intermediate status.** The service retries an unreachable input internally (three `failed_system` → `inprocess` cycles) before `failed`. The current adapter's status enum lacks it, so the first `failed_system` poll fails schema validation (`AIOZ_INVALID_RESULT_RESPONSE`). Whether a `failed_system` task can ever recover to `success` is **UNPROVEN** (in D it did not). T035/T063 must decide handling (treat as non-terminal until `failed`, or as failure) from evidence.
- **F4 — model catalog.** The deployed catalog (3 models) does not include the locally registered id; audio/transcribe exists but is out of scope.
- Environment observations: the AI Service and MinIO addresses are private LAN IPs over plain `http`; a 3-image batch completed in ≈14 s.

**Still open for T006 (not PASS):** maximum files/payload/response size; VIDEO batch support; deployment build identity; behavior of an expired signed URL (see source-access.md).

## Disposition under the IMAGE detection v1 gate (2026-09-24)

Per the user's reconciliation: the only provider-evidence **start gate** is deterministic/contractual correlation (HG-1, OPEN — see correlation.md). Maximum batch size, expired-link/TTL behavior, `failed_system` recoverability, reorder/unknown/partial groups, VIDEO/AUDIO and build identity are **closure evidence** (VIDEO/AUDIO deferred). The observed hazards (F1–F3, non-idempotency, whole-batch failure) are handled by design decisions D-FS, D-NI, D-SAN, D-LAYER, D-STALE in `research.md`, not by waiting for more evidence.
