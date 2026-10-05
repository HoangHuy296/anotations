# T101 — local `AiModel` vs deployed AI Service catalog (read-only drift report)

Date: 2026-09-24. Read-only: one `SELECT` on `AiModel` and one authenticated `GET /api/v1/models/list`. **No data was written**; no registration/sync script was run. Credentials and endpoint values are not recorded.

## Result

| | Count |
| --- | --- |
| Local `AiModel` rows | 22 (all `isActive=true`); providers: `aioz-company` 19, `aioz-test-result` 3 |
| Fixture/test-like rows (`ai-worker-model-*`, `ai-happy-path-model-*`, "Fixture Model") | 19 |
| Deployed catalog models | 3 (`image/detection`, `video/tracking`, `audio/transcribe`) |

Non-fixture local rows versus the deployed catalog:

| Local `key` (= provider `model_id`) | Local name | Modality / task | In deployed catalog? |
| --- | --- | --- | --- |
| `68d7f474-6982-446c-8c5a-121d56d12dc9` | yolo26s | IMAGE / DETECT_OBJECTS | **yes** — the model v1 uses |
| `cb29e022-1ba7-4349-9dce-4fb3074e84d6` | bytetrack_yolox_s_coco | VIDEO / DETECT_OBJECTS | yes (VIDEO deferred in v1) |
| `0307ee22-5bfa-4f68-bcb5-42fef7d26de3` | YOLO26s_COCO | IMAGE / DETECT_OBJECTS | **NO — stale** (provider answers 422 "Model … does not exist") |

Deployed `e1182c0c-…` (audio/transcribe) has no local row (out of scope).

## Findings

1. **The v1 image model is correctly registered and active locally** (`68d7f474-…`), so runtime proof (T077–T078) does not need a registration change for it.
2. **Model discovery already follows the deployed catalog** (`apps/web/src/lib/ai/ai-model-service.ts`, `loadModels`: iterates the provider catalog and joins local rows), so the stale row is not offered by the UI list.
3. **Gap (DI-5): `createAiTask` checks only the local row** (`ai-task-service.ts`: `findUnique` + `isActive`), not membership in the deployed catalog. A request that names the stale local model (direct API call, old tab, script) creates a Job/AiTask and only fails later at the provider with a 422. T016/T019 must add the deployed-catalog membership check (read outside the transaction) and return a safe rejection before any Job exists.
4. **Local cleanup is a data write and is not done here.** Proposal for the user's approval only: mark `0307ee22-…` inactive (or remove it) through the existing registration tooling; 19 fixture rows are created by test suites and are out of scope.

Status: T101 complete (report). Any catalog synchronization that writes data still needs the user's explicit approval.
