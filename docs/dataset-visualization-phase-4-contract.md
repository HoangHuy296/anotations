# Visualization Phase 4: generation and publication contract

Status: approved migration-only trigger approach; implementing, 2026-09-29. Written before Prisma/worker changes. Phase 1–3 routes and completion/access rules remain authoritative.

## Identity

- Dataset remains the existing Dataset record. No visualization dataset table.
- `Dataset.visualizationGeneration` is a monotonically increasing PostgreSQL bigint fencing token, initially zero. It is not a user-visible version or snapshot. Atomic database triggers increment it in the same transaction as changes to the active Asset set/media identity, Annotation content/revision, Label definitions/colors, or dataset lifecycle/identity. Changes reverted later still advance the token, preventing ABA publication.
- Capture reads one PostgreSQL RepeatableRead transaction: dataset token/lifecycle, active assets and their storage/checksum identity, all persisted annotations on those assets, and label definitions. Canonical, sorted, allowlisted JSON has a SHA-256 content digest. This is NOT Dataset.updatedAt, AssetVersion, Annotation.revision, or a repository commit. Each annotation revision participates as one input, never as the dataset generation.
- A snapshot identity is SHA-256(datasetId, generation fence, capture digest, capture algorithm version). A snapshot references its existing Dataset. Only successfully published immutable captures appear in Versions. There are no synthetic/pre-migration versions.
- Artifact identity is SHA-256(datasetId, snapshot identity/content generation, kind, algorithm version, scope). Supported initial kinds: CAPTURE (frozen content descriptor), SOURCE_IMAGE (pinned immutable bytes), THUMBNAIL/PREVIEW (bounded rasters), PROFILE (statistics and schema profile). Scope is `dataset` or original Asset.id. This identity is also the durable result/cache identity; Redis is not involved.

## Additive persistence proposal

- Dataset: generation fence, publication fence counter, nullable current snapshot reference/identity.
- DatasetSnapshot: deterministic ID, Dataset FK, generation fence, content digest, capture algorithm, safe counts, captured/published timestamp. Published rows are insert-only; failures/pending state belong to Jobs and artifact metadata, not fake Versions rows.
- VisualizationArtifact: deterministic ID, Dataset FK, snapshot identity, kind, algorithm, scope, private bucket/key, SHA-256, size/content type, ready timestamp. Ready artifact references are immutable. No presigned URLs or binary data in PostgreSQL.
- Common Job gains VISUALIZATION_CAPTURE and VISUALIZATION_DERIVE kinds. Existing lifecycle, lease, heartbeat, attempts, retryOfJobId, events and retry succession remain the processing authority. No visualization Job model.
- Pending/processing/failed DTOs derive from common Jobs; ready derives from published rows. A failed retry cannot overwrite a ready reference. Existing ready results remain readable while later generations process or fail.

## Generation fencing: proposed database enforcement

There are more than 100 existing Asset/Annotation/Label write call sites across web and worker. Updating a selection of application services would leave uncovered writers. A generic client hook outside the caller transaction would not be atomic. The proposed enforcement is a small SQL-only migration trigger layer; all application queries and mutations continue through Prisma.

Triggers on Asset, Annotation and Label INSERT/UPDATE/DELETE increment the affected Dataset generation in the SAME transaction. Updates compare relevant fields (excluding timestamps/derived progress) and account for moves between datasets, active-set changes, annotation geometry/revision/label identity, and label definitions/colors. A Dataset BEFORE UPDATE trigger increments generation for workflowStatus, archived/deleted state, name/description changes; derived publication fields do not self-invalidate. Incrementing takes a Dataset row lock. Parent dataset deletion is allowed without attempting to recreate its generation row.

The worker's publication transaction uses Prisma updateMany to compare datasetId + expected generation + exact COMPLETED + not archived/deleted and increments publicationFence. That conditional UPDATE holds the same Dataset row lock until commit. Source writes which already hold the generation lock are observed or cause refusal; later writes wait until publication commits and then increment generation. The capture and publication are therefore one serially ordered generation, not a mixture. There is no heavy I/O inside this transaction. Check the Job lease/cancel fence and publication eligibility in that same transaction.

This migration-only raw SQL requires explicit approval under AGENTS.md: “Use Prisma for database access. Do not use raw SQL unless explicitly approved.” Generated Prisma client refresh also requires approval under the generated-files rule. The user approved this scope; the new additive migration has been applied and Prisma regenerated through its normal command.

## Media immutability

Snapshot artifacts cannot rely on a live Asset.storageKey remaining unchanged or surviving deletion. Capture copies supported original image bytes into a private snapshot-owned namespace and records their SHA-256. Descriptor bytes contain captured content and hashed source identity, never provider URLs/bucket keys. Authorized snapshot DTOs project normalized geometry and stable object-scoped artifact IDs. Source metadata/ETags are checked around copying; changed/unavailable required image content fails capture rather than publishing a silently partial snapshot. Source object writes outside the application database protocol are not legitimate content mutations; in-app replacement must update Asset identity and therefore the generation fence.

Snapshot-owned source copies and descriptors remain stable after live asset/annotation/label edits or deletions. Thumbnail/profile derivation reads only frozen captured content. Unsupported modalities are explicit; Phase 4 adds no video/audio/text processing. Define and enforce resource limits before reading/copying large content. No unbounded database transaction or browser payload.

## Submission and publication

- Authorized manager/owner requests or a background scheduler create durable Jobs, then enqueue only `{ jobId }` on the existing queue. Viewer GETs never create Jobs, copies or processing. Read-only viewer interactions stay read-only; processing submission belongs to a separate authorized management boundary.
- Capture submission records the current generation and approved algorithm only. No secret/storage input in queue payloads.
- A worker resolves the Job from PostgreSQL and claims the existing lease. Capture obtains a consistent descriptor and generation fence, copies media/descriptor to deterministic private keys, then conditionally publishes in the fenced transaction.
- Publication atomically inserts the immutable snapshot/artifact references and promotes Dataset's current published snapshot. Stale/reopened/deleted/archived content or an expired/canceled Job cannot publish. Existing published snapshot remains unchanged.
- Derivation consumes the immutable snapshot descriptor/source copies. Preview/profile results must pass a current-generation/current-snapshot fence before becoming current. Old published artifacts remain valid for their original snapshot. No output from a stale worker can replace a newer result.
- Failed preview/profile generation leaves original-media fallback and the last published artifact intact. Dataset COMPLETED eligibility is independent of artifact state.

## Retry/idempotency

- Deterministic snapshot/artifact unique IDs and immutable keys prevent duplicate logical outputs across duplicate deliveries, worker restarts and successor Jobs.
- Same-generation retries reuse verified existing objects or replace unpublished temporary output safely; ready references are never overwritten. Store checksum/size and verify before reuse. Corrupt outputs fail closed.
- Existing common Job retry linkage permits one successor. Visualization retry resolves CURRENT generation under authorization rather than copying a stale input. If content changed, successor targets new generation; if unchanged, it reuses the logical identity.
- Staging keys/attempt ownership must prevent one failed/stale attempt deleting another attempt's published or in-flight object. Check durable references before cleanup. A duplicate delivery of a terminal Job is a no-op through existing dispatch.
- Publish/checkpoint metadata must reconcile a crash after publication but before the Job terminal update; a redelivery cannot manufacture another version.

## Invalidation and reads

Any relevant source/lifecycle write advances the generation fence. Ready artifacts are selected by Dataset + current captured generation + algorithm + query scope. No Dataset.updatedAt shortcut, no Redis result cache, and no presigned URLs in durable data. The old snapshot remains immutable and listable as history, but an old preview must never be overlaid with new annotations on the live Data tab. Pending/failed/current-mismatch previews fall back to the Phase 3 authorized original path.

Every snapshot/artifact/profile read reuses authentication, dataset.read, active-dataset checks, and exact COMPLETED. Cross-dataset IDs are rejected. Only safe, bounded DTOs/authorized media streams reach browsers; raw Job input/result and private artifact storage references never do.

## Retention and deletion

Published snapshots/artifacts are retained while their Dataset is retained; no automatic age-based pruning in this phase. Archival revokes reads/processing and retains immutable data for possible restore. Soft deletion revokes reads and processing immediately and makes snapshot artifacts eligible for the existing delayed dataset cleanup policy; hard deletion cascades metadata. Before physical removal, cleanup captures/checks artifact references and removes bytes idempotently. Source asset deletion must not delete snapshot-owned copies.

Extend the existing orphan-reference checker for snapshot artifacts and protect queued/running visualization namespaces during processing. Unpublished abandoned objects use the existing GC grace period; they are not permanent artifact rows. Cleanup must not delete a ready object just because its creating Job failed after committing publication. No new retention service or Redis authority.

## Verification gates

Test duplicate delivery and successor retries, publication under concurrent annotation/asset/label changes and reopening, ABA status changes, failure preserving ready output, post-publication source edits, immutable media, cross-dataset reads, revocation/archive/delete, deterministic algorithm/scope keys, and original-media fallback. Run worker/web tests, Prisma validation, apply/diff migration on a disposable database, and inspect the migration before applying to the development database. Browser smoke creates two real snapshots from a disposable dataset and proves the first descriptor/bytes remain unchanged.

## Proposed implementation files and risks

Create shared visualization processing contracts and identity functions; a reviewed additive migration; worker capture/derive processors and storage helpers; web management submission service/route, Versions/artifact reads; tests and completion report. Modify Prisma schema/client (after approval), common Job queue mapping/dispatch/retry handling, existing GC reference checks, and Phase 3 readiness/Insights/Versions presentations.

Main risks: broad write coverage, row-lock contention/deadlocks during concurrent bulk writes, correct immutable media ownership, lease-expiry publication, reference-aware deletion, and existing uncommitted work. Preserve unrelated changes; use existing ffmpeg bounded subprocess support for raster previews rather than adding packages.


## Approved trigger scope and rollback semantics

The user approved migration-only SQL and normal Prisma generation on 2026-09-29. Runtime access remains Prisma-only. The complete additive migration is `prisma/migrations/20260929013000_visualization_snapshots/migration.sql`.

- `visualization_asset_generation`: AFTER INSERT/UPDATE/DELETE on Asset; compares id, datasetId, filename, modality, MIME type, dimensions, size, primary storage identity, checksum/fingerprint, deletion/archival. An UPDATE where both old/new assets are inactive is ignored. Assignment, description, sync status, cache status, asset workflow status, and timestamp-only writes do not invalidate a capture.
- `visualization_annotation_generation`: AFTER INSERT/UPDATE/DELETE on Annotation; compares id, dataset/asset/label IDs, type, modality, canonical geometry, revision, status, source. Other properties/timestamps are not part of this initial snapshot contract and do not invalidate it. Annotation changes on inactive assets conservatively advance generation; this cannot expose or promote stale content.
- `visualization_label_generation`: AFTER INSERT/UPDATE/DELETE on Label; compares id, datasetId, name, color, modality, scope, description. Hotkeys, normalized search names, properties and timestamps are outside this capture contract.
- `visualization_dataset_generation`: BEFORE UPDATE on Dataset; compares name, description, exact JSON workflowStatus, archivedAt/deletedAt. Publication-fence/current-snapshot updates and unrelated metadata do not self-invalidate.
- `visualization_snapshot_immutable` and `visualization_artifact_immutable`: BEFORE UPDATE/DELETE on published reference tables. UPDATE always fails; DELETE is allowed only with an absent/deleted parent Dataset. Rows are inserted only at publication, so legitimate creation is unaffected.

A changed row advances its affected Dataset once (both parents, in sorted order, for a move); a multi-row/cascading transaction can advance several times. The token is a fence, not an edit count or version ordinal. Same-value writes do not advance it. All increments roll back with the source transaction, including constraint failures and deadlock victims. No trigger performs external work or queues Jobs. On deployment failure, roll back the migration transaction; do not edit old migration history. Operational rollback after committed publication must first preserve/export retained artifact references and stop writers/workers; use a new reviewed forward migration to remove triggers/tables, never silently delete published history.

## Operational bounds and delivery

Capture is deliberately all-or-nothing: at most 1,000 active assets, 100,000 persisted annotations, 10,000 labels, 25 MiB per required image, 512 MiB total image bytes and a 32 MiB descriptor. Unsupported modalities retain identity/annotation metadata but are not rendered or processed. Required image content that is missing, unreadable or outside the bound fails capture; the live viewer remains accessible. Captured images have independent immutable storage ownership.

Capture publication also creates one deterministic `VISUALIZATION_DERIVE` Job in the same PostgreSQL transaction. Existing pending-delivery recovery enqueues it on its next 60-second scan, including after a crash; no custom scheduler or queue payload is introduced. Viewer GETs never submit work. The separate `POST /api/datasets/{datasetId}/visualization-processing` management API accepts only `{}`; existing failed-Job retry resolves the current generation and creates/reuses one successor. Generic foundation submission refuses visualization types so callers cannot supply a generation or bypass the management permission.

Derivation atomically publishes one profile plus all image thumbnails/previews. One failed required image leaves the derivation failed and all prior ready output intact. Profile reads retain the most recent valid profile and explicitly report whether its snapshot matches current content. Data previews require the current generation and algorithm; missing/corrupt/failed previews fall back to authorized original media. Historical capture inspection uses the frozen original artifact identity so its DTO is unchanged when previews finish later.

No Redis result cache or persisted presigned URL exists. Deterministic artifact IDs are the reuse keys and include every required identity axis. All browser results and media responses use private/no-store. The host development shell has no ffmpeg; the existing worker image already includes it. Deployment must run these jobs in that worker environment. No new dependency or environment variable is required.
