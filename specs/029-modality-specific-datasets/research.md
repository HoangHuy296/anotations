# Phase 029 research and decision register

Status: planning research complete after user policy confirmation. Implementation and migration release gates remain explicit; no execution approval is implied. This document proposes choices; it does not authorize migration or historical data repair.

## R1. Schema authority

**Decision:** reuse shared Prisma Modality; additive nullable Dataset.modality, no default. Existing Dataset.primaryModality and DatasetType are compatibility hints only. Dataset.modality is fixed once assigned.

**Rationale:** existing schema has no authoritative Dataset field; first-asset assignment in local-folder completion is explicitly a hint. Empty Dataset identity cannot depend on an Asset.

**Alternatives:** rename/backfill primaryModality, derive from first Asset, or create a second enum/model — rejected because they hide ambiguity or duplicate authority.

**Evidence:** `prisma/schema.prisma` Dataset/Asset; `apps/web/src/lib/imports/complete-local-folder-item.ts`; spec sections 2 and 6.

## R2. Equality and immutability are separate

**Decision:** investigate final composite `(datasetId, modality)` → Dataset `(id, modality)` foreign key with non-cascading modality updates after historical resolution. Do not claim it freezes modality when a Dataset has no Assets. Ordinary application updates must prohibit assigned-modality changes; database-level fixedness would need a separately reviewed trigger or equivalent enforcement.

**Rationale:** equality and fixedness are different invariants. A nullable legacy parent cannot satisfy a child's non-null composite reference. An empty parent has no child to prevent a modality change.

**Alternatives:** row-local CHECK cannot alone express cross-table equality; global FK during nullable compatibility rejects historical unresolved children; ON UPDATE CASCADE would rewrite canonical Asset modality and is unacceptable. Trigger design remains an option, not approved SQL.

**Gate:** prototype required in isolated schema after implementation approval; no schema/client generation performed here. Prior visualization migration approval does not approve Phase029 custom SQL.

## R3. Concurrent writers and historical backfill

**Decision:** reject Redis-quiescence-only safety claims. Require a tested shared transaction protocol and drained incompatible writers, or explicitly approved database enforcement. Use Prisma for runtime access; do not add raw SQL lock queries.

**Rationale:** Phase027 quiescence guards are advisory, fail open on Redis failure, and are outside the publication transaction. Replays/reconciliation must also participate. A clean audit followed by an unguarded update is unsafe.

**Evidence:** `apps/worker/src/providers/asset-write-quiescence-guard.ts`; `apps/web/src/lib/asset-write-quiescence-guard.ts`; `asset-upload.ts`; `repository-asset-upsert.ts`.

**Alternatives:** assume Redis lock is authoritative, serialize only the backfill, or check only active assets — rejected. A Serializable protocol is a candidate that requires all competing paths and serialization retries, not a statement that adding one transaction guarantees correctness.

**Gate:** prove insert/backfill, parent update/child publication, deleted-row restore and reparent races. Database serialization cannot guarantee that external object bytes stayed fixed; verify source identity/version independently.

## R4. Content classification

**Decision:** extension/MIME remain preliminary hints; reuse and strengthen server classification before source Asset publication. Do not treat signature-prefix agreement as complete media validation.

**Evidence:** `apps/web/src/lib/upload-verification.ts` reads 64 KiB, treats ftyp as VIDEO, EBML as VIDEO, OggS as AUDIO; text is MIME-assisted UTF-8 prefix validation. `apps/worker/src/jobs/repository-import-source.ts` classifies candidates by extension; publication currently trusts candidate modality.

**Alternatives:** accept extension or existing subtype as migration truth — rejected. Introduce a separate public processing backend — rejected. Reuse available private-worker probing where practical, but exact stream policy and bounded execution must be designed.

**Planning decision:** accept classification only when the existing server tools establish the modality. Inspect container streams: a non-cover-art video stream means VIDEO (audio tracks may coexist); audio streams without video mean AUDIO; cover-art-only, malformed, truncated, unsupported or indeterminate cases fail closed. Streaming text verification must establish supported encoding/no binary NUL under existing upload limits; a prefix alone is not full verification. Worker already includes ffmpeg/ffprobe and bounded media-process/source-materialization helpers (`apps/worker/src/media/policy.ts`, `jobs/video-metadata.ts`, `jobs/audio-waveform.ts`, worker Dockerfile). Reuse these for repository classification before publication. Web completion must reject ambiguous containers unless it has equivalently verified evidence tied to the exact object; do not run a ten-minute worker probe in a request or create a provisional incompatible Asset. This may narrow currently accepted synchronous uploads: explicitly document that release limitation, and require a separately designed common-Job verification path before claiming full ambiguous-container upload parity. No new job kind or dependency is smuggled into this plan.

## R5. Historical data and unavailable sources

**Decision:** preserve the existing dated audit; never present it as a fresh live classification. Re-audit before any backfill.

**Evidence:** `audit-2026-09-29.json` has 116 datasets: 47 EMPTY, 57 IMAGE_ONLY, 5 VIDEO_ONLY, 0 AUDIO_ONLY, 1 TEXT_ONLY, 6 MIXED. Of 609 Assets, 86 prefix-classify MATCH, 19 lack supported private MinIO source, and 504 are unavailable/unclassifiable. 22 subtype records are missing. Zero detected disagreements among verified objects does not mean all content is consistent.

**User-confirmed policy:** unresolved MIXED/EMPTY stay unchanged/null; ingestion blocked; explicit authorized EMPTY choice; no auto split or modality guessing. Preserve existing read access before the engine switch where compatible; after switching, null has a resolution-required state, not asset-selected engine.

**Alternatives:** retain legacy ingestion temporarily (requires a clear isolation/rollout boundary), all-at-once forced backfill (unsafe), automatically split MIXED (not authorized).

**Decision:** EMPTY resolution is restricted to the dataset owner or system ADMIN, as confirmed by the user; `dataset.update` alone is insufficient. Use a separately authorized command and bounded audit event through existing durable audit infrastructure after verifying its schema; do not expose generic modality PATCH. No new audit table is planned. The exact persisted event representation must pass implementation review before the command is released.

## R6. Mixed import outcomes

**User-confirmed decision:** preflight rejects known incompatible selections; late mismatch retains valid existing publications but reports failed/incomplete import. Never silently skip and report full success.

**Rationale:** current local-folder commit requires all expected items; repository worker has durable per-item/terminal outcome semantics. An atomic whole-source rollback is not already provided.

**Alternatives:** all-or-nothing requires staging/publication redesign and cleanup policy; silently skipping incompatible media violates the requested invariant/UX. Product choice must be explicit before freezing contracts.

## R7. Engine context and dependent features

**Decision:** introduce server-authorized Dataset context with explicit engine and nullable selected Asset; adapt existing registry, not new routes/services. Assert selected Asset belongs to Dataset and matches its modality. Empty states use the Dataset engine. Keep COMPLETED catalog/viewer routing independent.

**Evidence:** `lib/workspace/workspace-read.ts`, `workspace-engine-registry.tsx`, workspace page and selection DTOs. `ensureDefaultImageLabels` currently runs from generic workspace entry; move eligible default initialization to explicit creation design rather than a cross-modality read side effect.

**Alternatives:** first/current Asset, requested modality query, client store, or primaryModality fallback — rejected. Scope-specific label, AI model, bulk and export defenses remain, including Phase028 mixed-data validation for legacy/corrupt rows.

**Planning decision:** recommendations use existing explicitly modality-compatible definitions where available; otherwise show “No recommended classes available” and keep manual validated class entry. Do not invent AUDIO/VIDEO/TEXT defaults. Class suggestions are not persisted until the user confirms creation.

## R8. UI scope check

**Decision:** preserve user's anchored CRUD requirement; do not bundle an unrelated repositioning patch into modality planning. Current `dataset-row-actions.tsx` still has centered native dialog code (`showModal`, `fixed inset-0 m-auto`). This is an observed implementation discrepancy, not confirmation that anchored UI already exists.

**Acceptance for future UI reconciliation:** adjacent trigger anchor, viewport collision handling/mobile bounds, one panel, correct label/control semantics, outside/Escape dismissal and return focus, unchanged rename/status/archive endpoints and authorization.

## R9. Planning tools/governance

**Decision:** use installed Bash setup equivalent with explicit feature-directory override. Preserve actual Git branch. `.specify/feature.json` now targets Phase029 so a later task command does not accidentally operate on Phase026.

**Findings:** requested PowerShell setup and update-agent-context scripts are absent; constitution remains placeholder text; no extension hooks registered. Use user/AGENTS/Phase0 authority, do not fabricate a constitution or overwrite governance through a substitute agent script.

**Gate status:** policy questions were answered by the user; conservative classification/taxonomy decisions resolve planning scope. Generate design documents, but mark migrations, classifier parity, concurrency proofs and historical backfill as implementation/release gates. No tasks or implementation begun.

## R10. User-confirmed decisions

The user explicitly selected: (1) preserve unresolved MIXED/EMPTY, block ingestion, explicit owner/admin choice for EMPTY; (2) retain already valid assets and report incomplete import on late mismatch. These choices settle product policy, not authorization to apply a migration or repair data.

## R11. Additional enforcement coverage

Guard outer upload replay, in-transaction replay and prepared-item `assetId` replay, plus repository reconciliation reuse and both upsert branches. Visualization generation triggers cover only their own content semantics and skip some inactive-asset cases: they are not a modality lock. New current-dataset modality projection must not rewrite immutable snapshot payloads; any future inclusion in snapshot capture requires a versioned capture contract and additive generation-trigger review.
