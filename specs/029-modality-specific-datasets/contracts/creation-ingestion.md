# Creation and ingestion contracts

Proposed contract delta; all existing auth, request limits, safe responses and route semantics remain unless explicitly listed. OpenAPI changes accompany implementation, not this planning run.

## Creation

POST `/api/datasets`, `/api/datasets/from-repository`, `/api/imports/local-folder`: require `modality` with exactly IMAGE, VIDEO, AUDIO or TEXT. No missing/null/coercion/first-file fallback. Return safe Dataset modality in creation/read projections; compatibility list/read DTOs can contain null for unresolved history. Creation permission remains existing ADMIN/MANAGER policy.

Repository/folder request fingerprints include modality plus normalized confirmed taxonomy; changed payload with reused key returns existing idempotency conflict. Validate class names/colors/scope through existing label rules. Preview is read-only. No credentials/queue inputs/storage references become browser DTO fields.

PATCH `/api/datasets/[datasetId]` cannot change assigned modality. Historical EMPTY resolution is a separate owner/system-admin command contract, not ordinary metadata update; endpoint/event storage must be reviewed before implementation, not invented by this document.

## Append and publication

Append `/api/datasets/[datasetId]/imports/local-folder` reads the authorized parent's fixed modality. A client-supplied value cannot override it. Direct presign, direct complete, prepared capability/complete/commit and repository worker fresh/reuse paths all check current parent eligibility; completion performs definitive classification/equality validation before publication.

Safe proposed errors, after authentication and access checks:

| Condition | Status/code | Effects |
| --- | --- | --- |
| Parent unresolved | 409 DATASET_MODALITY_UNRESOLVED | No new source Asset |
| Definitively classified mismatch | 422 ASSET_MODALITY_MISMATCH | No incompatible Asset/subtype; expected/detected enum only |
| Unsupported/unverifiable media | Existing safe unsupported/invalid media response | No guessed modality or provisional Asset |
| Assigned modality mutation | 409 DATASET_MODALITY_IMMUTABLE | No Dataset/Asset rewrite |
| Revoked/cross-dataset/deleted/archived | Existing authorized route response | No disclosure/bypass |

Outer upload replay, transactional duplicate replay, prepared completed-item replay and repository reconciliation reuse must validate too. Existing object/relativePath/quiescence guards remain additional constraints.

## Content classification boundaries

Repository worker reuses bounded source materialization/media process helpers and installed ffprobe. Probe supported stream metadata, reject malformed/truncated/indeterminate content. Ordinary video with audio is VIDEO; audio-only container is AUDIO when proven; cover-art ambiguity is rejected. Keep existing process/source/output/temp limits; probes run in private processing, not workspace GET.

Direct/prepared web completion may accept only what its bounded verified classifier can establish. Ambiguous containers must fail closed until equivalent object-bound evidence is available. Do not pass ten-minute worker processing into HTTP requests, use extension fallback, or create a fake Asset to schedule metadata verification. A common durable Job pre-publication verification path, if needed for full parity, requires an explicit follow-up contract and review; it is not implicitly added here.

## Incomplete import policy (user confirmed)

Known mismatch blocks acceptance where detectable. Late mismatch preserves already valid Assets and results in failed/incomplete import with safe reason and accurate aggregate counts. No silent skip→success and no automatic rollback/deletion of valid content. Folder commit still requires all expected items; retry cannot mark a rejected item complete without verified compatible bytes. Existing retry/cancellation/cleanup contracts apply; queue contains only `{ jobId }`.
