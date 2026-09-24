# AI Batch Application API (provisional)

Research gates E1–E3 must close before implementation. Existing authentication, same-origin mutation protections, rate limits, error envelope and Dataset concealment apply. Browser calls only Next.js.

## Target input

New `target` is one of:

```json
{"mode":"CURRENT_ASSET","assetId":"<asset-id>"}
```

```json
{"mode":"BULK_SELECTION","selection":{"mode":"EXPLICIT","assetIds":["<asset-id>"]}}
```

```json
{"mode":"BULK_SELECTION","selection":{"mode":"FILTERED","query":{"modality":"IMAGE"}}}
```

Reuse the Phase 022 bulkSelectionSchema and bulkSelectionQuerySchema exactly for selection/filter fields. No page, limit, cursor, sort, order, filename identity, client file locations or full records. Dataset is the authenticated top-level request scope, not a selection-controlled override. Explicit input-shape ceiling remains 1000 IDs; deduplicate before applying the effective execution limit of at most 200. Missing explicit members invalidate the whole request without listing concealed IDs.

## POST /api/ai/tasks/preview (new, read-only)

Body: datasetId, target, optional modelId; strict Zod validation. Authorize annotation.create, resolve the whole target, and report safe mode/count/modality plus eligibility, effective limit and reason code. With no selected model, report only verified modality-level capabilities; with a model, apply its lower limit. The response includes an opaque previewFingerprint covering Dataset, actor scope, accepted ordered IDs/source identities, target mode, model/capability/limit context. Never return storage locations or inferred count for unauthorized selections.

Preview performs no Job creation or provider task submission. Model/class catalog access uses existing server services only. Unknown/unauthorized scope follows current 404/403 rules. Empty/mixed/ineligible targets can return a safe invalid preview; no current-Asset substitution.

## POST /api/ai/tasks (existing, extended)

Keep datasetId, modelId, classes, confidence_threshold and iou_threshold (defaults 0.5); add target and previewFingerprint for the new UI. Support existing assetIds callers through a mutually exclusive legacy branch normalized to explicit selection. Reject requests containing both target and assetIds. Both branches use the same strict selection/eligibility/limit checks. Legacy IDs are not trusted resolved records.

Repeat authorization, selection resolution, active model/modality/task support, class and threshold validation. Within a transaction, freeze target order/source identity, compare new UI previewFingerprint, and create Job + AiTask. A mismatch returns 409 TARGET_CHANGED with a safe refresh instruction and no operation; equality does not replace authorization. No provider/network operation inside the database transaction. Enqueue only after commit with `{jobId}`.

Accepted response remains 202 with taskId and jobId, plus a safe accepted target summary. If enqueue fails after durable acceptance, preserve those references and leave delivery recovery to the existing scanner; do not misrepresent the operation as never accepted or encourage a second submission. A pre-commit rejection creates no Job, external task or predictions.

Status mapping is a finalization requirement of T018 (finding I3) and must follow existing conventions: over-limit 422 (like `SELECTION_TOO_LARGE`), whole-batch membership failure 409 `ASSET_NOT_IN_DATASET` (existing AI route), malformed/empty 400, mixed modality or ineligible 422 (like `MEDIA_ASSET_INELIGIBLE`), `TARGET_CHANGED`/`AI_CAPABILITY_UNVERIFIED` 409. The sentence below that assigns 409 to over-limit and 400 to mixed targets is superseded by this mapping once T018 confirms it.

Proposed safe additions to existing errors: TARGET_EMPTY, TARGET_TOO_LARGE (effective limit only), TARGET_MIXED_MODALITY, TARGET_INELIGIBLE, TARGET_CHANGED, AI_CAPABILITY_UNVERIFIED. Model inactive/conflict and validation retain existing semantics. HTTP 400 covers malformed/empty/mixed targets; 409 covers changed/ineligible/over-limit/unverified execution. Concealed resources use the existing Dataset/task not-found policy and do not expose individual foreign IDs. Provider discovery unavailability retains safe 502 behavior.

## GET /api/ai/tasks/{aiTaskId} (existing, extended)

Retain existing fields. Add authoritative jobStatus, target mode/count/modality, processed/succeeded/failed/skipped/canceled counts, ordered per-Asset outcomes (bounded by accepted limit), and recovery availability/reason. Status derives from common Job; AiTask is a projection. Reauthorize dataset.read on each read; revoked/unknown access => concealed 404. Each outcome includes authorized assetId, status, prediction count and safe reason, never provider URLs/IDs, storage keys, reservations, raw output or lock fields.

Existing Job views receive the same safe summary, so reopening after navigation can discover accepted work without localStorage authority. Historical tasks can report unavailable detailed outcomes rather than inventing them.

## Existing prediction/cancel/retry routes

Prediction/task and Asset AI-result reads must expose committed successful outputs from failed or canceled aggregate tasks under existing Dataset authorization. Terminal failure does not erase successes. No browser-derived predictions become authoritative.

POST /api/ai/tasks/{aiTaskId}/cancel continues delegating to common Job cancellation. Current Job cancellation semantics apply; no invented remote cancellation endpoint.

The existing common Job retry action is extended, not replaced: require job.retry plus current annotation.create access, retain unique successor lineage, accept only server-derived allowlisted recovery context, and return existing successor on repeats. Unknown submission or insufficient historical evidence returns a safe 409 recovery conflict. No arbitrary external ID or retry payload from the browser is accepted.
