# Post-rollout web change set — approved, ROLLOUT-GATED (not started)

**Status: APPROVED by the release owner (2026-10-06), but it may begin only after the frozen Phase 029 rollout (release commit `1ba21bb…`, web/worker images `107602f2…` / `e26aefb6…`) has completed successfully and its required postflight has passed.** Nothing in this document is implemented. The frozen release commit and images are never modified; this work ships as a later, separate release.

Written for: the engineer who will implement it after the postflight gate, and the release owner reviewing it.

## Frozen scope (four items, no more)
1. **Response modality propagation** for repository creation and local-folder preparation.
2. **Dataset-authoritative AI targeting** (IMAGE path; capability matrix stays an evidence classification, not a product policy; HG-1 stays enforced, bulk-result persistence is not widened).
3. **Partial/truncated PNG → `422 INVALID_MEDIA`** instead of a generic 500, with no Asset or publication side effect; only the minimal reviewed validation/error-handling correction for the existing synchronous supported-media path is ported (no other A2 code).
4. **Stale-test repair** limited to this contract (e.g. the mixed-modality case in `ai-batch-targets`, workspace routing tests that need G5 fixtures).
Excluded: A2/M26, any VIDEO/Ogg shortcut or broadened support (T022/A2 owns it), M24/M25, historical backfill/remediation, converting the AI capability matrix into final policy, any G3/G5 claim, shared dev as a test fixture.

## Acceptance gate (owner's addition)
**Three-flow contract tests are written first and must fail before implementation.** Unit or mock tests alone are never conclusive; the final ingestion proof runs in a receipt-owned disposable runtime with real PostgreSQL, Redis and MinIO where those are involved (the approved HTTP-runtime stage-1 design; shared dev is never a fixture).

## Contract per flow, with before → after API shapes (from the current code)
| Flow | Before (current code, frozen images) | After |
| --- | --- | --- |
| `/datasets/imports` — `POST /api/datasets/from-repository` | `data: { dataset: { id, name }, job, progressPath }` | `data.dataset: { id, name, modality }`, `modality` read from the persisted/reused Dataset (fresh 202 and replay 200), never from the request. Content classification stays authoritative: a downloaded object whose class ≠ the bound Dataset modality is rejected item by item (`ASSET_MODALITY_MISMATCH`), nothing published; idempotency/accounting unchanged. |
| `/datasets/local-folder` — `POST /api/imports/local-folder` and the append route | `data: { preparation: { id, datasetId, jobId, expectedItemCount, deadlineAt, items:[{id}] }, replayed, deliveryPending }` | adds `data.dataset: { id, modality }` beside `preparation`, from the committed/reused parent (start, replay, append). Completion keeps classifying the stored bytes; filename, extension, declared MIME and hints never decide the class; mismatch/invalid fails closed with no Asset. No VIDEO/Ogg broadening. |
| `/workspace/{datasetId}` — page props and `GET /api/datasets/{id}/workspace-state` | already `dataset.modality` (+ resolution state); unresolved ⇒ `409 DATASET_MODALITY_UNRESOLVED` | unchanged shape; assert it. Engine, toolbox/tabs and AI targeting derive from `Dataset.modality` only; selected Asset, query modality, filename/MIME or stale state never override; a foreign/forged Asset is rejected/ignored per the existing contract; unresolved Datasets select no engine; no byte probing is added to workspace reads. |
| Synchronous upload — `POST /api/assets/complete-upload` and item completion | a PNG signature with fewer than 24 bytes throws an out-of-range read ⇒ generic 500 (nothing published, staged object cleaned) | deterministic `422 INVALID_MEDIA`, nothing published |
OpenAPI (`schemas/import-repository.yaml`, `openapi.yaml`) and `docs:validate-openapi` are updated with the additive fields.

## Tests first (all must be written and observed failing before any implementation)
| # | Proof | Level |
| --- | --- | --- |
| 1 | repository creation response has authoritative `data.dataset.modality` (fresh and replay) | HTTP runtime / real DB |
| 2 | local-folder start, replay and append responses have `data.dataset: { id, modality }` | HTTP runtime / real DB |
| 3 | workspace response/state has authoritative `Dataset.modality` | real DB + HTTP |
| 4 | client body/query/selected-Asset modality cannot override the Dataset | real DB + HTTP |
| 5 | repository downloaded-byte mismatch rejected server-side, no Asset | disposable runtime (worker + MinIO) |
| 6 | local-folder stored-byte mismatch rejected server-side, no Asset | disposable runtime (MinIO) |
| 7 | spoofed MIME/extension does not establish modality | disposable runtime |
| 8 | truncated/partial PNG ⇒ `422 INVALID_MEDIA`, no Asset, no publication side effect | disposable runtime |
| 9 | replay/idempotency still correct on all responses | real DB |
| 10 | unresolved historical Dataset selects no engine | real DB |
| 11 | IMAGE AI targeting is Dataset-authoritative and keeps the proven limit (N ≤ 3; N = 4 refused) | real DB |
| 12 | HG-1 still enforced; bulk-result persistence capability not widened | real DB + existing guards |
Validation-negative matrix to report: spoofed extension, spoofed declared MIME, garbage bytes, truncated PNG, wrong-class valid media, foreign Dataset Asset, forged selected-Asset modality, mismatched repository blob, unresolved Dataset — each with HTTP status/code and zero Asset/subtype rows.

## Owner clarifications (2026-10-06, checkpoint review)
- **Current state:** frozen rollout NOT EXECUTED; Gate A NOT STARTED; this change set APPROVED BUT ROLLOUT-GATED / NOT STARTED; A2/M26 NOT STARTED; G3/G5 unchanged. No implementation authorization is active.
- **The 12 tests are minimum acceptance proofs, not a limit.** Add cases wherever materially different behaviors would otherwise be combined in one test.
- **RED → GREEN evidence is mandatory and explicit.** Each RED run must fail for the intended missing behavior (for example the absent response field or the 500 instead of 422), not because of a fixture, runtime or environment failure; the RED output is preserved before the implementation exists, then the GREEN run after it.
- **Final proof runtime:** the receipt-owned Stage-1 HTTP runtime (real PostgreSQL, Redis, MinIO) is the default and required proof. **No guarded alternative is pre-approved.** If Stage 1 cannot be used, STOP and present the exact alternative with its evidence and isolation differences for review.
- **Branch:** the implementation branch is not created yet; it is based on the actual released source only after the frozen rollout and its postflight have succeeded.
- Gate A stays blocked until the named operator, the exact bounded duration, the per-run authorization, the private credentials and an explicit shared-dev change freeze all exist.

## Preconditions before any work starts
1. Frozen rollout completed successfully and postflight passed (recorded by the maintenance receipts).
2. A branch based on the *released* source (not the A2 branch), kept separate from A2/M26.
3. The receipt-owned Stage-1 HTTP runtime (`disposable-http-runtime-plan.md`) available for the final proof; if it cannot be used, stop and present the exact alternative for review (none is pre-approved).

## Return when finished
Before/after API shapes, exact tests and run ids per flow, the validation-negative matrix, regression results, then STOP (no automatic move to A2/M26).
