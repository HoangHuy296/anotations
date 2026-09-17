# Proposed TEXT contracts

These contracts describe planned behavior, not currently implemented endpoints. [openapi.yaml](openapi.yaml) is the feature-local machine-readable proposal. Merge validated changes into `specs/api/openapi.yaml` and its referenced source files when implementation lands; regenerate published bundles then. Existing public documentation must not claim these endpoints already work.

## HTTP surface

All routes stay inside the Next.js application. All reads/writes authorize dataset membership and resource scope; same-origin mutation protection follows existing routes. IDs are opaque durable IDs, never paths. Conceal inaccessible resources using existing policy; forbidden capabilities on an otherwise visible resource use 403. Responses and server logs exclude source excerpts, credentials, private locators and raw upstream diagnostics.

| Route | Purpose and success |
| --- | --- |
| `GET /api/assets/{assetId}/text` | 200 source/readiness projection. READY includes exact decoded text, source identity, offset unit, verified lengths, sorted boundary map/profile, safe language metadata and effective limits. Non-ready states include no partial text. `private, no-store`. |
| `POST /api/assets/{assetId}/text/prepare` | 202 common Job ID for an unprepared object-backed source; repeat request reuses the Job. 200 when already prepared. Requires existing `dataset.read`; preparation is an idempotent derivative operation available during read-only review, independent of annotation-create permission. It does not grant generic Job retry/cancel rights. Repairing legacy-only content is explicit maintenance outside this UI. |
| `GET /api/assets/{assetId}/text/annotations` | 200 coherent safe snapshot of annotations, asset revision, source identity, policy revision and capabilities. Unprepared/mismatched source returns 409. No partial annotation set presented as complete. |
| `POST /api/assets/{assetId}/text/annotations` | One semantic mutation command; 200 acknowledgment with operation ID, replay flag, affected IDs/revisions and resulting asset revision. Body contains expected source and policy identity. |
| `GET /api/datasets/{datasetId}/text-policy` | 200 authorized policy/configuration revision plus eligible labels and capabilities. |
| `PUT /api/datasets/{datasetId}/text-policy` | `label.manage`, expected configuration revision and strict policy body; 200 current policy revision. Reject invalidating changes. Same-origin settings UI may use a Server Action calling this same service. |

Existing generic workspace read must expose TEXT asset status/revision and capabilities. Existing generic annotation GET must use a safe TEXT projection. Existing annotation mutators must refuse unsupported TEXT input or dispatch to the guarded TEXT service, never accept text through image geometry validation. Existing workflow, assignments, Discussion, Activity, notification, presence and export routes are reused unchanged except additive safe projections/invalidation support.

Source byte/code-unit limits remain centrally configured. The TEXT annotation count limit is transactional write admission, not a read cap: net-zero/decreasing commands remain allowed at or above the limit, positive growth requires final count within the limit, and receipt replay never consumes capacity. Legacy-over-limit data remains readable through the revision-consistent pagination contract below; no silent truncation or count-only unsupported state.

## Command envelope

Each command contains `operationId`, `sourceIdentity`, `expectedPolicyRevision`, and discriminated `command`. No source text or geometry aliases are accepted. Strict schemas reject unknown fields. Create IDs are server-issued; receipts make retries durable. Updates/deletes include expected annotation revisions. Relation creation/retargeting includes both endpoint expected revisions so a stale inspector cannot silently act on changed endpoints.

| Command | Required command data |
| --- | --- |
| `createSpan` | startOffset, endOffset, nullable labelId, optional validated `properties.custom` (omission means empty) |
| `updateSpan` | annotationId, expectedRevision, nonempty patch limited to range, label and `propertyPatch` |
| `deleteAnnotation` | annotationId, expectedRevision; referenced spans refuse deletion |
| `replaceClassification` | groupId (null for implicit group), complete expectedMembers `[{id,revision}]`, desired distinct labelIds; SINGLE allows 0 or 1 |
| `createRelation` | from/to annotation IDs and their expected revisions, required relation labelId, optional validated `properties.custom` (omission means empty) |
| `updateRelation` | annotationId, expectedRevision, endpoint IDs/revisions, relation labelId and optional validated `propertyPatch` (omission preserves properties); unchanged fields remain unchanged |
| `updateClassification` | annotationId, expectedRevision, validated `propertyPatch` only; use replacement for label membership changes |

The acknowledgment lists upserted `{id,revision}` and deleted IDs, not copies of source or geometry. After success clients refetch or apply their confirmed semantic change only if the response matches the active asset/operation and is not older than known state. Receipt replay can describe historical revisions and must trigger authoritative refresh rather than overwriting newer state.

## Failures and concurrency

Use a safe error envelope `{error:{code,message}}`, with allowlisted revision metadata only where authorized. 400 is malformed shape; 401 unauthenticated; 403 forbidden capability; 404 concealed/missing resource; 409 includes `REVISION_CONFLICT`, `POLICY_CONFLICT`, `SOURCE_MISMATCH`, `SOURCE_NOT_READY`, `IDEMPOTENCY_CONFLICT`, `ANNOTATION_REFERENCED`, `DUPLICATE_ANNOTATION`, `WORKFLOW_READ_ONLY` or `CLASSIFICATION_CONFLICT`; 413 is request-body limit; 422 includes `INVALID_RANGE`, `INVALID_LABEL`, `INVALID_ENDPOINT`, `UNSUPPORTED_SIZE` or `ANNOTATION_LIMIT`; 503 indicates a retryable source/dependency outage. A readable source readiness response may report invalid encoding/unsupported size with 200 and no content. Clients use codes, not parse message text.

Any failed semantic command leaves annotation data, parent revision, receipt and content outbox unchanged. Revision conflicts require explicit reconcile/reload; transport retry reuses the identical operation ID/payload. Taxonomy policy changes emit a dataset-scoped `TEXT_POLICY_CHANGED` invalidation, including relevant label edits, so clients refresh capabilities. Content changes emit `ANNOTATION_CHANGED` with dataset/asset IDs and optional parent revision only. Add both types to existing worker/gateway/client allowlists. No ranges, endpoints, draft/source/selected text or search queries appear in either event, Job dispatch messages or presence.

## UI and active-engine contract

Use the existing three-column workspace and registry selected by `Asset.modality`. TEXT has read/select, span, classification and relation capabilities only when source and policy support them. Remove unavailable image/AI controls rather than presenting functional-looking placeholders. Read-only review retains reader, search, selection/inspection and authorized Discussion.

Reader renders escaped immutable DOM text and maps DOM text-node offsets to the original UTF-16 source. Maintain a source-indexed segment table; markup/wrapping never supplies the canonical string. Reverse selections normalize direction, then snap outward to supplied grapheme boundaries with a visible preview before commit. Reject collapsed selections; preserve whitespace selections. Pointer/keyboard selection, search and layout do not autosave. Never insert source as HTML. Highlight rendering partitions interval boundaries rather than duplicating document strings per annotation. The list exposes every overlap with label, range and selected state, plus separate relation and classification entries.

Keyboard flows: focus reader, use normal extended text selection, invoke a named create-span action, choose eligible labels, then adjust start/end through grapheme-aware controls. Classification and relation builders use focusable lists/buttons; relation creation offers source and target span pickers and inspector navigation. Escape cancels preview; Enter confirms supported commands. Search uses literal Unicode strings against original text and translates matches to original offsets without normalization/case folding; search hits never become saved annotations automatically. Suppress global workflow hotkeys while typing, selecting, changing range, or building relations. Errors are announced and focus is retained or restored predictably.

`flush(assetId)` must be awaited by header Submit/Resubmit, previous/next, properties navigation, asset list selection, and route-leave handling. Success includes current asset revision. Failure keeps the asset active with retry/reconcile or explicit discard. Browser unload uses the standard unsaved-change warning when pending; no source/drafts are persisted in browser storage to simulate guaranteed recovery. All old image/video callers adopt adapters with tested success/failure semantics.

Remote invalidation or reconnect refetches authorized state. With clean local state apply newer snapshots; with dirty state preserve intent and mark conflicts instead of overwriting it. Removed membership clears protected client state and disables further reads/mutations. Presence uses semantic VIEWING/EDITING only, not a lock. Discussion, Responsibilities, history and notification UI remain existing components in the properties area.

## Export projection

Use existing full-dataset and selected-asset export Jobs and manifest envelope. Add optional `text` to TEXT assets: `{schemaVersion:1,sourceIdentity,sourceEncoding,offsetUnit,sourceCodeUnitLength}`. Add optional `text` to TEXT annotations: `{schemaVersion:1,scope:'span'|'document'|'relation',sourceIdentity,offsetUnit,...}`; span range is projected from geometry, document classification includes resolved group ID and label ID, relation includes from/to annotation IDs and relation label ID. This projection is derived; canonical stored geometry is not duplicated in a second persisted column. Do not export selected excerpts, private storage refs or boundary artifact keys.

Both builders use one shared TEXT serializer and a coherent metadata snapshot. Validate source compatibility and endpoint closure against that exact export set. An unsupported/malformed TEXT row fails the export safely with an allowlisted reason; never silently omit it. Optional extension is additive to current schemaVersion 1; update explicit schemas and strict-consumer contract fixtures before claiming compatibility. Existing IMAGE/VIDEO record shapes and values must be byte-equivalent after stable-key serialization. Original source binary delivery is governed by the existing export scope, not a new implied capability.

## Shared implementation ownership

Canonical geometry, source identity/unit/version and safe serializer input/output contracts live in `packages/domain/src/text-annotation-contract.ts`; named span/document/relation types are consumed by both apps. Boundary schemas live in `text-boundary-contract.ts`, fatal UTF-8/BOM decoding in `text-source-decode.ts`, and validated limits in `text-source-limits.ts` within the same package. No worker import depends on web types; web-only selection/preview DTOs remain in `apps/web/src/types/text.ts`.

`apps/web/src/lib/annotations/text-source-read-service.ts` reads authorized private MinIO source through existing providers, bounds the stream, verifies exact raw digest/length/fingerprint and calls `text-boundary-loader.ts`. The loader validates artifact digest/schema/profile/source/length and sorted bounded endpoints. Its bounded TTL/LRU cache stores only verified maps, keyed by dataset/asset/source/digest/profile; every hit reauthorizes and checks current metadata. Cache source text, credentials and authorization nowhere. Source I/O occurs before command transactions with immutable identity rechecked inside. Routes only authenticate, invoke services and envelope responses.

Policy GET requires dataset.read; PUT and eligibility changes require label.manage. Policy writers use a dataset-only guard, validate current dependent records, reject invalidating edits, increment textPolicyRevision and commit TEXT_POLICY_CHANGED atomically. They never require an editable asset or bump an arbitrary asset review revision. Owner/Manager label-management panels configure both classification and relation policies through this route.

## Follow-up wire contracts

PolicyWrite is exactly `{expectedRevision,policy}` from HTTP to service; do not accept `expectedPolicyRevision` as a PolicyWrite alias. The annotation command envelope separately retains expectedPolicyRevision because it refers to another entity's version. Contract tests reject the wrong PolicyWrite field.

Creates accept bounded `properties.custom`; updates accept `propertyPatch:{set,unset}` per data-model.md Custom property contract. Null is a value; unset is deletion; unknown keys/values fail safely. The same editor/validator supports all three annotation kinds. Read-safe properties expose only validated custom metadata, not arbitrary stored system/provider metadata.

Both `GET /api/assets/{assetId}/text/annotations` and generic `GET /api/assets/{assetId}/annotations` paginate TEXT using `limit` (default 500, max 1000), opaque `cursor`, and `expectedAssetRevision` on continuation. TEXT responses retain annotations plus `textPage:{nextCursor,totalCount,assetRevision,annotationLimit,canCreate}`; the specialized route also retains sourceIdentity/policyRevision/capabilities. No source text, selected excerpts or storage locators enter annotation projections. Canonical safe span/document/relation DTOs preserve endpoint IDs only on relations. IMAGE/VIDEO generic response fields and behavior remain unchanged. Clients fetch/reconcile pages without treating any page as the complete set; a changed snapshot returns 409 and requires restart. Admission limits never deny access to legacy records.
