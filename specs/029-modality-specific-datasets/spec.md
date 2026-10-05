# Phase 029 — Modality-Specific Dataset & Workspace Engine Routing

**Date:** 2026-09-29  
**Status:** Read-only architecture/data audit and proposed specification; implementation NOT authorized by this document.  
**Scope:** Separate from Phase 028 multi-format export. No branch, application change, schema change, migration, generated client change, database write, or historical repair performed for this audit.

## 1. Objective and boundaries

The target invariant is `Dataset.modality ∈ { IMAGE, VIDEO, AUDIO, TEXT }` and, for every belonging Asset, `Asset.modality === Dataset.modality`. Dataset modality is fixed after creation. An empty Dataset still has an explicit modality. Asset modality remains persisted for integrity checks and content rendering; it no longer chooses the workspace engine.

Keep Next.js as the sole public application/backend, PostgreSQL/Prisma as domain and Job authority, MinIO as private binary storage, and the private worker as execution boundary. BullMQ transports only `{ jobId }`. No second Dataset model, catalog, backend, importer bridge, or modality-specific workspace URL. Preserve Dataset/Asset/Annotation/Label IDs, annotation geometry/revision semantics, asset revisions/workflow, source identities, relative paths, membership/RBAC, and durable Job retry/cancellation/idempotency behavior.

This checkpoint changes documentation only. The existing architecture documents and AGENTS.md currently describe Asset-driven engine selection; the approved implementation must update those statements explicitly rather than silently treating them as already changed. Authorities reviewed: `docs/architecture.md`, `docs/job-system.md`; related locks remain `docs/bullmq-postgres-job-flow.md`, `docs/clone-repository-plan.md`, and `docs/phases.md`.

## 2. Current schema and routing audit

### 2.1 Persisted models

Source: `prisma/schema.prisma` (Dataset, Asset, Label, Annotation and related enums).

| Model/field | Current behavior | Phase 029 consequence |
| --- | --- | --- |
| Dataset.type | DatasetType, default MULTI_MODAL; also IMAGE_LABELING, VIDEO_LABELING, AUDIO_LABELING, TEXT_LABELING | Not a reliable modality invariant; retain during compatibility, deprecate as engine selector |
| Dataset.primaryModality | Nullable shared Modality enum; hint, not enforced | Do not rename/backfill blindly or use as migration truth |
| Dataset.modality | Absent | Add nullable shared enum first, no default |
| Asset.modality | Required Modality: IMAGE, VIDEO, TEXT, AUDIO | Keep; enforce compatibility with parent and classified content |
| Asset media | MIME, size, dimensions/duration/text length, private/source references; optional ImageAsset/VideoAsset/AudioAsset/TextAsset children | Audit subtype/content consistency independently from enum grouping |
| Label | Dataset-scoped; nullable modality; scope defaults OBJECT; unique datasetId + normalizedName; persisted colors | Preserve IDs/colors/references and modality/scope semantics, including universal labels |
| Annotation | Required modality, canonical geometry, required revision | Never rewrite annotations as part of modality backfill |
| Dataset lifecycle | metadata.workflowStatus; separate deletedAt/archivedAt | Independent from modality and processing readiness |

`apps/web/src/lib/validation/dataset.ts` currently permits creation without modality, defaults type to MULTI_MODAL, and accepts nullable primaryModality. Updates can alter type/primaryModality. `lib/dataset-metadata.ts` and dataset overview/catalog projections expose the hint; all relevant safe projections need the new field later.

### 2.2 Workspace selection today

`apps/web/src/app/(app)/workspace/[datasetId]/page.tsx` authenticates and reads workspace state, accepts image/video/audio/text selection query parameters and modality filters, calls `ensureDefaultImageLabels`, and passes the selected asset's engine into header/sidebar/engine components. An empty selection renders the generic empty state.

`lib/workspace/workspace-read.ts::readWorkspacePage/readWorkspaceSelection` selects assets, validates requested asset modality, then branches on the persisted Asset.modality to read IMAGE, VIDEO/AUDIO, or TEXT workspace state. Previous/next items carry their own modality. `components/workspace/workspace-engine.tsx` dispatches through `lib/workspace/workspace-engine-registry.tsx` using `selection.engine`. Registry wrappers narrow the selection and supply Engine, Toolbox, PropertiesTabs, StatusFields, and flush behavior. Registry interfaces currently require a non-null selection.

The dependent selection surface includes `lib/workspace/workspace-assets.ts`, `components/workspace/{asset-browser-filters,asset-navigator,workspace-engine,properties-panel,placeholder-properties-tabs,workspace-header,dataset-sidebar}.tsx`, engine adapters, selection DTOs/stores, and links emitted from the asset browser. These must distinguish the Dataset engine from the selected content. Asset-specific query parameters may remain compatible selection locators; they must never override Dataset modality.

**Important existing side effect:** `lib/workspace/label-management.ts::ensureDefaultImageLabels` inserts IMAGE defaults under dataset.read, including when a reader opens a non-image workspace. Do not extend this behavior to all modalities. Design explicit creation-time taxonomy initialization, and ensure engine reads do not seed incorrect labels. Existing label data is not automatically deleted or retagged.

## 3. Complete creation and Asset writer inventory

Audit scope: production TypeScript in `apps/web/src`, `apps/worker/src`, shared packages; Prisma create/createMany/upsert, nested relation writes, callers, import routes, and reconstruction paths. Generated/dist code is not an independent writer. Tests/scripts/seeds are identified separately. Inventory reflects the current, already dirty worktree rather than only committed HEAD.

### 3.1 Dataset creation boundaries

| Entry | Authoritative writer | Current behavior / required future change |
| --- | --- | --- |
| POST `/api/datasets` | `apps/web/src/app/api/datasets/route.ts` → db.dataset.create | Require explicit modality in Zod input; safe response includes it; retain existing creation authorization |
| POST `/api/imports/local-folder` | `lib/imports/prepare-local-folder-import.ts` → tx.dataset.create | New upload Dataset and durable prepared-import state; require modality before preparation, include it in request identity |
| POST `/api/datasets/from-repository` | `lib/repository-import/acceptance.ts` → `lib/queue/enqueue-job.ts::createAndEnqueueNewDatasetSourceImportJob` → tx.dataset.create | Serializable Dataset/connection/Job acceptance, re-preflight and idempotency; propagate explicit modality atomically |
| Dormant legacy helper | `lib/dataset-import.ts::persistDatasetImport` → client.dataset.create | Reuses Dataset by owner/repo/ref/root or creates EXTERNAL_REF Dataset; no production caller found. Must fence/adapt before any reactivation |

POST `/api/gitea/import` and `/api/source-import-jobs` return 410; they are not live creation paths. Read-only source preflight does not create Datasets. `/datasets/new` redirects to `/datasets/imports`; it is not a fourth creation implementation. Append POST `/api/datasets/[datasetId]/imports/local-folder` uses the existing Dataset and must not offer a modality change.

Non-production creation also exists in `prisma/review.seed.ts`, `apps/web/scripts/visualization-phase4-smoke.ts`, `scripts/027-verify-trigger.ts`, and test fixtures. These must adopt explicit modality before the eventual required column; do not execute them as part of this audit. `prisma/seed.ts` seeds users/labels, not a separate production Dataset creation service.

### 3.2 Asset publication boundaries

| Flow | Writer and caller chain | Integrity boundary to add |
| --- | --- | --- |
| Direct upload | `/api/assets/presigned-upload` issues capability; `/api/assets/complete-upload` verifies bytes → `lib/asset-upload.ts::publishUploadedAsset` | Reauthorize parent; compare verified modality with current Dataset modality inside publication transaction; validate replay too |
| Local-folder/prepared import, new or append | prepare → `/api/imports/[preparedImportId]/upload-capabilities` → `/api/imports/[preparedImportId]/items/[itemId]/complete` → `lib/imports/complete-local-folder-item.ts` → same publishUploadedAsset | Item MIME/modality hints are provisional; verify bytes, compare parent and item, reject mismatch without Asset/subtype creation |
| Repository import | common IMPORT_DATASET Job → private queue router → `apps/worker/src/jobs/import-dataset.ts` → `repository-asset-upsert.ts::upsertMirroredRepositoryAsset` | Verify downloaded content before create/reuse; parent modality checked on both upsert branches and reconciliation reuse |
| Dormant external-reference import | `lib/dataset-import.ts` → client.asset.upsert with IMAGE | Cannot trust hardcoded IMAGE or extension; keep unreachable or adopt same policy before enabling |

`publishUploadedAsset` has four branches creating Asset plus the corresponding subtype. Source mirror upsert also creates subtype data. Both must preserve Phase 027 relativePath/quiescence/identity-conflict checks, not bypass them through a new writer. Folder completion currently fills **primaryModality from the first verified asset if null**: this is precisely the hint-assignment behavior that must not become Dataset.modality initialization.

Prepared-import commit (`lib/imports/commit-local-folder-import.ts`, `/api/jobs/[jobId]/commit-import`) finalizes existing prepared/uploaded state, not a third independent Asset publisher. The private queue revalidates source connections before import processing. `processImportDataset` returns `local-receipt` for PreparedImport jobs; other imports require MIRROR_TO_MINIO plus valid source input before repository processing. AI processors create predictions/annotations/tracks and update assets, not a separate asset ingestion path. Visualization processors create derived artifacts/snapshots, not new source Assets.

Other Asset writes include image dimensions, engine description updates, workflow claims/transitions, AI revision/duration updates, assignment, collaboration membership cleanup, and bulk status/deletion. They do not choose modality or create content, but database enforcement must allow their legitimate same-modality updates. There is no current production undelete/revival feature; `packages/domain/src/asset-revival.ts` is explicitly forward-looking. Future restore, reparent, bulk create, connect/connectOrCreate, and modality update paths must satisfy the invariant, including previously archived/deleted records.

### 3.3 Reconstructing/cloning/exporting Datasets

Repository cloning/mirroring is source ingestion into an existing central Dataset, not Dataset cloning. No live Dataset clone, native-manifest restore, or export-to-Dataset reconstruction endpoint was found. The dormant legacy importer is the reconstruction-like risk above. Native `export-manifest.ts` currently projects Dataset type/primaryModality and individual Asset modalities; `export-selected-manifest.ts` also preserves per-asset fields. Extend/version safe contracts in a later implementation; old manifests cannot become authority for a new Dataset without explicit selected modality and revalidation. Do not add an import bridge here.

## 4. Current classification, labels, bulk and AI behavior

### 4.1 Mixed file handling and classification

Direct upload and prepared-folder completion reuse `lib/upload-verification.ts::verifyUploadedObject`: object stat/size, bounded prefix (64 KiB), supported image signatures, MP4/WebM signatures, WAV/MP3/Ogg signatures, and UTF-8 text checks with a supported text MIME hint. MIME/extension UI filters are not its final authority. Prepared item modality is initially derived from candidate contentType, and mixed candidates can currently publish into one Dataset.

Repository candidate classification in `apps/worker/src/jobs/repository-import-source.ts` maps extensions (jpg/jpeg/png/webp, mp4/webm, mp3/ogg/wav, txt/json/csv). `import-dataset.ts` downloads, mirrors bytes, then persists candidate modality. There is no equivalent definitive byte classification in that publication path. Bounded repository preview is a sample/lower bound and cannot certify the whole repository.

The existing signature classifier has limits: ISO BMFF `ftyp` is treated as VIDEO and Ogg as AUDIO without inspecting stream tracks; text validation is prefix-bounded and MIME-assisted. It is not a full decoder or proof that an entire file conforms. Phase 029 must reuse and strengthen existing classification where ambiguous, not substitute filename extensions. Reject unavailable/unclassifiable/conflicting content with a safe reason; never invent a modality. A bounded container-aware probe may be needed in the private worker; tooling/dependency and stream policy require review before implementation.

### 4.2 Labels and taxonomy

Audit found 211 IMAGE/OBJECT labels and 44 universal (null modality)/OBJECT labels. Dataset-level grouped counts are included in the evidence. Current creation/update flows: `/api/datasets/[datasetId]/labels`, `/api/labels/[labelId]`, `/labels` actions, `lib/workspace/label-management.ts`, and `lib/assets/asset-label-service.ts`. Text label eligibility routes use shared guarded text commands and textPolicyRevision/outbox behavior. Labels with references cannot have scope silently changed.

Do not equate a Dataset engine with an annotation scope: VIDEO tracks/temporal labels, AUDIO segments, TEXT span/relation/classification, and IMAGE objects retain their scope-specific validators. Proposal: new explicit Label.modality must match the parent; existing null/universal labels remain subject to engine eligibility checks. Audit incompatible historical labels separately before tightening this rule. Suggested class names are draft taxonomy, not AI output or automatically accepted annotations. Preserve color, normalized-name uniqueness, permissions, and reference locks.

### 4.3 Bulk, export and AI

`lib/assets/asset-bulk-service.ts` resolves selection server-side within datasetId; keep this and the revision/workflow/permission gates. Filters/select-all can currently span modalities. New resolved Datasets have one modality, but legacy query/filter DTOs and per-row validation must remain until resolved.

`lib/ai/ai-target-service.ts` rejects mixed target modalities (`TARGET_MIXED_MODALITY`), derives target modality from target rows, supports IMAGE/VIDEO and bounds VIDEO selection. `lib/ai/ai-target-context.ts`, ai-model-service, task preview/create, ai-detect-dialog and bulk-action-bar need Dataset-driven capabilities, with persisted asset equality checks retained. Do not unlock AUDIO/TEXT AI merely because their engine exists. Worker submit/poll and prediction writers retain authorization, identity, revision and stale-target behavior.

`packages/domain/src/export-format-capability.ts` requires support for every present modality. `apps/worker/src/jobs/image-export-eligibility.ts` separately checks asset modality/dimensions, annotation modality, labels and scopes. Keep Phase 027/028 safety checks and skip accounting. A Dataset field can simplify UI format choices, not authorize partial exports or bypass snapshot/asset eligibility.

## 5. Read-only PostgreSQL and media audit

Evidence: [audit-2026-09-29.json](./audit-2026-09-29.json). Timestamp: 2026-09-29T08:40:29.125Z through 08:40:30.283Z. Scope is the configured local Annotation Platform development PostgreSQL database, not an assertion about production or another environment. All 116 Dataset rows were read, including archived/deleted records: 72 live, 44 archived, 0 deleted. All 609 Assets were included.

Method: Prisma `findMany`/`groupBy` selects in one RepeatableRead transaction for Dataset, Asset, subtype existence, Label groups and Job type/status aggregates. No raw SQL, migrations, update/create/delete, seed, or job enqueue. Classification counts distinct persisted Asset.modality values per datasetId. Both **all belonging assets** and **active assets** (neither archived nor deleted) were computed; their categories/count summaries agree in this database. Archived parents are still included. The target invariant applies to all belonging rows; hiding archived assets is not a backfill policy.

| Category | Datasets |
| --- | ---: |
| EMPTY | 47 |
| IMAGE_ONLY | 57 |
| VIDEO_ONLY | 5 |
| AUDIO_ONLY | 0 |
| TEXT_ONLY | 1 |
| MIXED | 6 |
| Total | 116 |

The 63 single-modality datasets are **enum-unambiguous candidates**, not 63 automatically approved backfills. Neither primaryModality nor type nor first asset was used for classification.

### 5.1 MIXED datasets — no changes made

| Dataset ID | IMAGE | VIDEO | AUDIO | TEXT |
| --- | ---: | ---: | ---: | ---: |
| cms5m6k4y001110fcqkuoviit | 6 | 1 | 0 | 0 |
| cms5yfsgf000g100zf3yfrw7h | 9 | 4 | 3 | 3 |
| cms7al8r5001210cg7zmi72hw | 5 | 1 | 1 | 0 |
| cmshgaiqi018np70kbpzk40g2 | 5 | 1 | 1 | 0 |
| cmswufc1i001dmm0kj4bloc9l | 5 | 1 | 1 | 0 |
| cmudvng90015vpo0k8cr70pci | 16 | 1 | 1 | 0 |

### 5.2 EMPTY datasets

All 47 IDs are listed below and separately identifiable by `all.category == EMPTY` in the evidence. Null/IMAGE/other primaryModality hints do not authorize selecting a modality. Owner/admin choice requires a defined permission and explicit policy, even for archived empty datasets.

| Dataset ID | State |
| --- | --- |
| 10f2a0c4-0507-492d-bf49-018e1bb78cdb | ARCHIVED |
| 1c576d16-68af-4b38-9ad4-a122e30c5617 | ARCHIVED |
| 1d4a63dc-6677-45a2-918a-6dff7ee438d9 | ARCHIVED |
| 29c83a03-0b1c-4198-a45e-7a346c517c94 | ARCHIVED |
| 2b2de6f2-d9ac-4112-9c4f-093525310e7a | ARCHIVED |
| 30fb8ded-f241-4edc-8d07-9c2a79f0916e | ARCHIVED |
| 3b37ef82-8c45-4dd0-a4a4-ea8508972032 | ARCHIVED |
| 3d2d6b5a-5e19-4c8b-a416-da3934a2a76c | ARCHIVED |
| 3e7d5d45-c71a-4376-baca-4d8c8382e39e | LIVE |
| 5dbb7352-0f68-4c2b-8062-7245163b1968 | ARCHIVED |
| 5f0dbdd9-2130-457d-8784-f02d4620e9d6 | ARCHIVED |
| 6a9ec0af-d63c-4656-a462-3c323e33d88c | ARCHIVED |
| 72107362-374c-48a4-92e4-bd722ec3cbbc | ARCHIVED |
| 94958636-595e-437d-a37e-e5711e28563b | ARCHIVED |
| b009e354-0b8d-4eb1-ba4d-c82dd2587166 | ARCHIVED |
| bba56ce0-cd7f-419c-a715-def9d34ac6ae | ARCHIVED |
| bba8463d-18c0-4686-bb5c-967091fb1ff1 | ARCHIVED |
| c61996ac-1234-46e5-a18d-5b924c325c4c | ARCHIVED |
| c830f2d3-9990-4f89-b7f8-9857fbb054ec | ARCHIVED |
| cf17ef5c-4072-4743-8611-247f42276d3d | LIVE |
| cmrono60m000210vay9iqqmfd | LIVE |
| cmrp0c1eq00031017kzplq2lj | LIVE |
| cmrx2whs70005o93kaaasudtk | LIVE |
| cmryqkpnv000710o7ei43qod9 | ARCHIVED |
| cmrys947u006o10o7inr4of2j | ARCHIVED |
| cmrysb8ni006w10o7qt4i38wd | ARCHIVED |
| cmrysifqf007210o7jklk08cr | ARCHIVED |
| cms4c8enj000110nh76vbjimk | ARCHIVED |
| cms4eh8a8000510p4ssfyudm3 | ARCHIVED |
| cms4ei2hc000b10p40uh5ww02 | ARCHIVED |
| cms4uhz66000v105bfydcu5wx | ARCHIVED |
| cms4usc8z0011105ba9i9zlgb | ARCHIVED |
| cms4vmd9x000110sdx7egqbsf | ARCHIVED |
| cms4xsyyt000p10u1bmgjeuwg | ARCHIVED |
| cmsg0jl3d0006p70k1khrwmvp | ARCHIVED |
| cmsh6jjok000310d00xpesg96 | LIVE |
| cmshc5jqf016kp70kfmzwbxgk | LIVE |
| cmshc624j016pp70k61d7sn1d | LIVE |
| cmshc6mkv000110hj6itf5hyo | LIVE |
| cmszvo3ug000310tmq8mbduix | LIVE |
| cmt4v8sv4000310cez6afclud | LIVE |
| cmukyq85x000310sa0gyz9cov | LIVE |
| dc0ae463-416a-4cad-a5bb-b9e687b34d3c | ARCHIVED |
| e241594c-86e9-45d3-b566-38e0c55984fc | ARCHIVED |
| eff0330d-3489-4418-a7a9-4e8eb72d607a | ARCHIVED |
| f8098771-2a39-4f84-b193-b48690b16ea3 | ARCHIVED |
| fc62d3f7-2951-4aa5-bbff-1ee3e96b79e8 | ARCHIVED |

### 5.3 Persisted metadata and content consistency

Every Asset was checked for exactly one corresponding subtype and MIME-family agreement. **22 assets have no subtype child** (3 VIDEO, 19 IMAGE); their Dataset/Asset IDs are recorded in `metadataIssues`. No contradictory MIME family or wrong/multiple subtype was found by these checks. Missing subtype is an integrity finding, not evidence to rewrite modality.

MinIO reads used the existing server-side provider and bounded production signature/text classifier, with four concurrent reads at most. No object bytes, storage keys, provider URLs, credentials, names, or arbitrary metadata are in the report. Results across all 609 assets:

| Content outcome | Assets | Interpretation |
| --- | ---: | --- |
| MATCH | 86 | Supported bounded classifier agrees with persisted enum; no stored-size disagreement among these |
| MISMATCH | 0 | None detected among successfully classified objects; not a clean bill of health for all assets |
| NO_PRIVATE_MINIO_SOURCE | 19 | No supported private MinIO reference; no external provider download attempted |
| UNVERIFIED | 504 | Source unavailable or unclassifiable; sanitized aggregate does not distinguish missing object, access/transport, or decoder failure |

Per-asset outcomes and metadata exceptions are in the evidence. Five IMAGE_ONLY datasets had every asset classified MATCH (cms4y5wjy000z10u1wx8960wh, cms4yg32a00091066p3pv4ms0, cms4yo8v6000110fcrebi7e56, cmswue27i0017mm0kl4s3qadi, cmt1cyld4007r106km4icuup2); this is evidence only, not permission to backfill them. Four mixed datasets were also entirely classified MATCH, confirming that mixed content is real in at least those cases.

**Limitations/blocker:** 523 assets lack successful content verification, and prefix/container limitations remain. The database snapshot and subsequent object reads are not a distributed atomic snapshot. Re-audit at migration time using stable content identity and scoped writer quiescence/version checks; do not use this dated report as a backfill execution manifest. Investigate unavailable storage/source access with authorized server-only diagnostics before asserting safe content classification. No filename-extension truth was used in the content audit.

## 6. Proposed schema and staged migration (design only)

Initial Prisma shape, reusing the existing enum rather than adding a competing modality enum:

```prisma
model Dataset {
  // existing identity, relations, metadata and lifecycle remain
  modality Modality? // additive; no default, no inference
}
```

Application-facing `DatasetModality = "IMAGE" | "VIDEO" | "AUDIO" | "TEXT"` represents resolved Datasets. Compatibility DTOs must honestly include null for unresolved historical rows. Keep type/primaryModality temporarily; new modality is authoritative wherever non-null. Do not let PATCH update it as an ordinary metadata field. Do not make old fields competing writable sources of truth. Final `Modality` (required) is a separate later migration gate.

| Stage | Change after approval | Exit condition |
| --- | --- | --- |
| 1. Expand | New additive nullable field; normal Prisma generation; no default/backfill | Old app/worker can still read schema; migration reviewed |
| 2. Compatibility | Deploy all creation DTOs/UI and all writer guards together; all new Datasets explicit; reject missing modality from old creation clients | No active writer can create an unresolved Dataset or incompatible Asset; old worker jobs paused/reconciled safely |
| 3. Safe backfill | Re-audit all assets and content evidence, select only unambiguous/conflict-free datasets; set null→explicit with conditional transactional checks | Dry-run and approved IDs; concurrent asset writes cannot race classification/backfill |
| 4. Historical resolution | Resolve EMPTY by explicit authorized choice; MIXED by separate approved policy; investigate missing media/subtypes | Every historical exception has resolution or remains visibly blocked/null |
| 5. Enforce writes | Compatibility-stage application checks become universal; guards cover new/update/reparent/replay/restore/nested paths | Negative/concurrency tests pass and writer inventory is re-audited |
| 6. DB backstop | Reviewed invariant covering parent and child changes; not just a frontend/server convention | Constraint validated against history and compatible with existing triggers |
| 7. Engine switch | Authorize/load Dataset server-side, dispatch solely on Dataset.modality | Empty engine tests; stale asset links cannot change engine; unresolved policy explicit |
| 8. Contract | Only after all historical resolution, make field required; retire legacy writes deliberately | Zero null and zero incompatible assets across all states; rolling deploy safe |

Stage 5 is completion/verification of enforcement introduced in stage 2, not permission to accept incompatible new writes until backfill finishes. During the compatibility period null historical datasets should reject ingestion (`DATASET_MODALITY_UNRESOLVED`, proposed 409). Existing read-only access may remain under legacy behavior before stage 7. At stage 7, null must render an explicit resolution-required state, never select an engine from an asset. Preserve existing IDs and data while blocked.

### 6.1 Historical policy options requiring approval

- **EMPTY:** explicit owner/manager (exact permission to approve) chooses once after a transaction confirms it is still empty; include archived rows in the resolution plan. Retain null and block new ingestion if no decision. No default IMAGE and no inference from old labels, type, names or primaryModality.
- **MIXED:** recommended initial compatibility policy is retain null, preserve all assets/annotations, block new ingestion, and provide authorized inspection/export for resolution. No single modality can satisfy the invariant while incompatible Assets still belong to it. A later approved reassignment/split would require its own identity, RBAC, annotation, lineage, snapshot and export design; it is NOT authorized here. Retaining mixed datasets forever means NOT NULL/universal enforcement cannot complete; record this explicitly rather than pretending a default solves it.
- **Enum-single but evidence incomplete/conflicting:** quarantine from automatic backfill pending source/subtype review. Missing media is not grounds to delete the Asset. Repairing subtype/enum/content metadata is a separately approved operation.

### 6.2 Database enforcement options

A row-local CHECK alone cannot express parent/child equality. Preferred option to prototype after approval: unique `(Dataset.id, Dataset.modality)` plus composite Asset foreign key `(datasetId, modality)` referencing it, preserving the existing Dataset identity and relation semantics. RESTRICT/NO ACTION for modality updates; do not cascade a Dataset modality change into Asset modality. This is attractive for the final required field but unresolved null parents cannot accept matching non-null children under the composite relation; do not enable it indiscriminately during nullable compatibility.

Alternative transitional backstop: migration-only constraint triggers validate child insert/update of datasetId/modality and parent null→value/value changes, with a shared parent-lock/serialization strategy to prevent write skew; allow legitimate unrelated updates. This requires **new explicit raw-SQL approval for Phase 029**. Previous Phase 4 trigger approval does not cover this feature. Review coexistence with relativePath and visualization content-generation/immutability triggers. Application/worker access remains Prisma-only in either design.

Backfill must run only with approved writer quiescence or a tested Prisma Serializable transaction/conditional update strategy shared by writers, bounded retries, and content identity recheck. No read-then-write outside a transaction. Parent modality is fixed once assigned; a later reclassification is a separate migration, not a user PATCH. Database tests must prove insert-versus-backfill and parent-change-versus-child-update races cannot commit mismatches.

Rollback: additive nullable schema can remain if application rollout is reverted; do not erase assigned values or reverse historical asset operations. Pause incompatible old ingestion/worker versions rather than redeploy a writer that ignores enforced modality. Final required/constraint rollout is separately reviewed after data resolution. No existing migration is rewritten.

## 7. Proposed workspace and ingestion contracts

### 7.1 Dataset engine resolver

```text
/workspace/{datasetId}
  authenticate → validate ID → authorize current Dataset + lifecycle
  load safe Dataset context including modality
  unresolved null → explicit historical-resolution state
  IMAGE → ImageWorkspace
  VIDEO → VideoWorkspace
  AUDIO → AudioWorkspace
  TEXT  → TextWorkspace
  optional selected Asset → belongs-to + active-state + modality equality checks
```

Introduce a typed Dataset workspace context independent of nullable selection. Adapt existing registry/engine wrappers rather than creating parallel navigation. Existing image/video/audio/text engines can back the named workspace branches; do not imply all modalities have equal tool maturity. Empty Dataset renders its modality's shell, toolbox capability/empty instructions and authorized upload affordance without fabricating an Asset. Cross-dataset or wrong-modality selected IDs fail closed; URL/client state never chooses the engine. Selection changes within a Dataset preserve the engine. Keep existing flush-before-navigation and revision-safe editing behavior.

Catalog lifecycle resolver stays unchanged: exact `metadata.workflowStatus === "COMPLETED"` opens `/datasets/visualize/[datasetId]`; all other values go to `/workspace/[datasetId]`. Viewer guards continue reauthorization, deletion/archive checks, exact COMPLETED, and reopened 409/redirect behavior. Modality does not imply review acceptance or annotation correctness. Visualization remains image-only where currently supported; other Dataset modalities show the existing unsupported state. Do not start Visualization Phase 5.

### 7.2 Server ingestion enforcement

1. Authenticate and authorize the current Dataset and existing operation permission; preserve workflow/quiescence checks.
2. Load explicit Dataset modality from PostgreSQL, not request hints or Job input alone. Null historical targets fail closed under the proposed compatibility policy.
3. Preliminary file filters/preview may reject likely mismatches early, but content bytes and persisted source identity determine final classification.
4. Verify actual source through the existing server/provider boundary; reject unsupported/ambiguous/disagreeing classification. For repository reuse, verify trusted content-classification evidence bound to exact content identity, not an extension or stale Asset row alone.
5. Publish Asset + matching subtype only in a guarded transaction; verify parent/equality again on retries, duplicate-object replay, reconciliation reuse and append. No partial incompatible Asset/annotation writes. Cleanup unreferenced objects through existing cleanup policy; never delete an already referenced source object on mismatch.
6. Proposed safe errors: `DATASET_MODALITY_UNRESOLVED` (409), `ASSET_MODALITY_MISMATCH` (422), and existing safe unsupported-media codes. Return allowlisted expected/detected modalities if authorized, no provider diagnostics or object internals.
7. Include chosen Dataset modality and draft taxonomy in durable request/idempotency fingerprints; a changed selection with the same request key is a conflict. Queue payload stays `{ jobId }`; workers load persisted parent and Job state. Old queued/prepared requests are inventoried and paused/revalidated if target modality is unresolved, not assigned from the first completed item.

Mixed source proposal: reject known incompatible selection before new work when detectable; late byte-detected mismatches fail that item/import through existing durable outcome policy, retain already valid published items, and report explicit counts/reasons. Never silently omit incompatible files and claim the whole source imported successfully. Whole-batch rollback is not assumed and would require a separate contract. User decision on partial-import UX is a gate below.

## 8. Creation UI requirements

`/datasets/imports`: adapt `components/imports/import-form.tsx` and `imports-screen.tsx` within the existing AppShell. Add left-side Dataset modality selection before Start Import, preserving branch/ref/commit and credential controls. Use visible IMAGE/VIDEO/AUDIO/TEXT labels and existing icon primitives; icons alone cannot communicate the choice. No automatic modality selection based on preview sample. Preview is read-only; only Start Import creates Dataset/Job/confirmed labels.

`/datasets/local-folder`: adapt `components/imports/local-folder-import-form.tsx` with a modality + recommended-classes card. Append mode displays the authorized existing Dataset modality as fixed. Direct Dataset creation/upload entry points must also collect modality before creation. Changing a draft modality invalidates incompatible preview/class selection confirmation and request fingerprint; it does not mutate an existing Dataset.

Recommended classes are removable, non-interactive badges with separate icon-only buttons named `aria-label="Remove <class name>"`. Manual entry/search uses a labeled editable input with `role="combobox"`, controlled `role="listbox"` popup, synchronized `aria-expanded`/`aria-controls`, stable option IDs/`role="option"`, `aria-selected`, and input-held focus via `aria-activedescendant`. Arrow keys navigate; Enter selects/adds validated text; Escape closes without committing; Tab retains normal traversal. Remove active descendant when popup closes/options disappear. No autofocus on mount. Announce empty results/validation safely; deduplicate normalized names. Modality recommendations need explicit maintained product defaults; do not invent server taxonomy or call AI to manufacture them.

## 9. Compatibility with Phases 022–028 and visualization

| Phase | Preserve | Required adaptation |
| --- | --- | --- |
| 022 Asset browser/dataset management | Authorized pagination, selection, dataset IDs, navigation | Dataset engine context; empty engine; modality filter becomes redundant for resolved datasets but remains defensive for legacy |
| 023 Annotation/review workflow | Asset/Annotation revisions, transition permissions, accepted/rejected semantics | Validate invariant without resetting status or claiming all assets reviewed |
| 024 Collaboration | Dataset membership/invitations, assignment, realtime/outbox and revocation | Project safe modality in authorized contexts; no permission shortcuts for resolution |
| 025 TEXT workspace | Canonical text/source identities, span offsets, relation/classification rules, textPolicyRevision guards | Dataset-driven TEXT mount; preserve scope eligibility and pending draft flush |
| 026 Single/bulk AI | Target fingerprints, model/provider capability checks, task retries and stale-target rejection | Dataset-driven model suggestions; keep TARGET_MIXED_MODALITY and per-asset equality defenses |
| 027 COCO/relativePath | Canonical relativePath, quiescence, deterministic IDs, annotation eligibility and skip reasons | Writer enforcement composes with existing guards; COCO still IMAGE only |
| 028 Multi-format export | Capability matrix, every-present-modality validation, format-specific serializers and no silent partial selection | Use Dataset modality for primary capability UI; mixed validation becomes defensive legacy/corruption handling, not deleted |
| Visualization 1–4 | COMPLETED guard, safe DTOs, authorized media, generation-safe immutable snapshots/artifacts, original fallback | Add safe field when appropriate; modality resolution must not rewrite snapshots. Review generation invalidation when current Dataset semantic metadata changes; old snapshot bytes remain immutable |

## 10. Acceptance and validation plan for later implementation

- Dataset creation requires explicit four-value modality through every live path; invalid/missing values rejected. All legacy clients and fixtures accounted for.
- Every asset publisher and upsert/replay path rejects parent mismatch, spoofed MIME/extension, missing/ambiguous bytes, wrong child type, and cross-dataset IDs. Test direct, folder/new/append, repository fresh/reused/retry and dormant helper fencing.
- Empty Dataset mounts correct engine without any asset; asset selection/filter/query manipulation cannot change it. Null legacy state is explicit. Back/forward/navigation and unsaved-edit behavior remain correct.
- DB/backfill concurrency tests: asset insertion/deletion/reparent during classification; parent assignment and simultaneous child insert; duplicate job delivery; restore attempts; serializable retry. No mismatched commit or annotation rewrite.
- Permission/revocation, archived/deleted, lifecycle COMPLETED/reopen, workspace revision/workflow and queue payload regression suites stay intact.
- Accessible modality selector/combobox/badges: keyboard, names, roles, active descendant, focus, escape, no autofocus; client filters cannot bypass server checks.
- Historical dry-run categories and per-ID evidence match approved snapshot; mixed/empty untouched until specific approval. Raw content cannot be treated as verified on unavailable sources.
- Export tests cover new single modality plus old mixed datasets, unsupported format, all-selected semantics, deterministic identity; do not remove Phase 028 mixed rejection tests.
- Run web/worker/domain tests, typecheck, lint, production build, Prisma and new migration validation, OpenAPI checks and authorized disposable browser import/workspace smoke only after implementation is separately approved.

This audit ran Prisma read queries and bounded media reads, plus documentation/evidence consistency validation. It did not run a production build, migrations, schema generation, seeds, application test fixtures, or mutating browser smoke because there is no runtime change to validate and this checkpoint forbids data writes.

## 11. Approval gates and next step

1. Approve nullable compatibility rollout and blocking ingestion for unresolved historical Datasets; decide whether their old read workspace remains available before the engine switch.
2. Choose who may resolve EMPTY datasets and how that choice is audited. No empty dataset is inferred automatically.
3. Choose a MIXED resolution policy. Keeping all current content/IDs untouched is the safe immediate choice but blocks final universal NOT NULL adoption; splitting/reparenting is a distinct approval.
4. Restore/diagnose source access for 523 unverified assets and investigate 22 missing subtype rows before approving specific backfill IDs. Agree definitive container/text classification policy.
5. Confirm late mismatch/partial-import semantics and recommendation taxonomy/defaults; do not silently discard incompatible files.
6. Select and prototype the final DB constraint strategy; any transitional raw-SQL triggers need their own narrowly scoped approval. No Phase 029 SQL is authorized by the earlier visualization approval.

Next step is review of this specification and policy gates, then an implementation/migration plan. **Stop here: no Phase 029 schema, data, migration, workspace, or Phase 028 implementation changes are included.**


## 12. Checkpoint artifacts and verification

Created only:

- `specs/029-modality-specific-datasets/spec.md` — architecture/writer audit and staged proposal.
- `specs/029-modality-specific-datasets/audit-2026-09-29.json` — safe per-Dataset classification and per-Asset outcomes, without storage references or source bytes.

Existing files modified by this checkpoint: none. The worktree already contains unrelated implementation changes; these were inspected, not reverted or attributed to this audit. Environment variables added: none. Migration changes: none. Next recommended work: review Phase 029 policy decisions and prepare its implementation plan, separately from Phase 028.

Evidence validation passed: JSON parses; 116 unique Dataset identities; category counts sum to 116; belonging Asset totals and 609 unique per-Asset outcomes agree; metadata exception count is 22; all 47 EMPTY and 6 MIXED IDs appear in this specification. Explicit repository file references were checked. No runtime tests/build/typecheck were run for these documentation-only additions.

Read-only command to inspect the saved evidence: `python3 -m json.tool specs/029-modality-specific-datasets/audit-2026-09-29.json`. A fresh database audit must use the select-only Prisma methodology in section 5 against the intended environment; do not run a seed, migration or import to reproduce it.

## 13. Planning checkpoint — confirmed policies (2026-09-29)

During the speckit-plan review the user explicitly confirmed these decisions, superseding the corresponding open product-policy questions in section 11:

1. Preserve unresolved MIXED/EMPTY datasets unchanged; block new ingestion. EMPTY resolution requires explicit owner/admin choice. No auto-determination, split, asset move or annotation rewrite.
2. If verified incompatibility is discovered after valid assets were published, retain those valid assets and report failed/incomplete import. Never silently skip incompatible media and report full success.

See [plan.md](./plan.md), [research.md](./research.md), [data-model.md](./data-model.md), [creation/ingestion contract](./contracts/creation-ingestion.md), [workspace/UI contract](./contracts/workspace-ui.md), [rollout contract](./contracts/migration-rollout.md), and [quickstart.md](./quickstart.md). Planning defaults reject unclassifiable content and avoid invented class recommendations; unsupported synchronous container verification is an explicit limitation requiring review before release, not an extension-based fallback.

Migration approval, historical approved-ID backfill, source/subtype remediation, concurrency proof and any custom Phase029 SQL remain separate gates. A final composite FK enforces equality but does not alone freeze an empty Dataset's modality. Existing Redis quiescence and visualization triggers are not a complete modality lock.

The CRUD panel must remain anchored beside its trigger as requested. This planning review found that the current worktree still contains centered `showModal()` positioning; it records that discrepancy without changing UI code or claiming the anchored refactor was verified.
