# Phase 029 — final pre-implementation review

Date: 2026-09-30. Status: **proposed for review, not implementation approval**.

This document refines the accepted planning baseline. Where baseline documents listed enforcement alternatives or left EMPTY resolution unspecified, this review proposes the concrete mechanism below. No migration, SQL execution, runtime implementation, data write or new database audit is part of this review. Audit figures in the baseline remain dated evidence.

## 1. Invariants and scope

A resolved Dataset has exactly one modality in IMAGE, VIDEO, AUDIO, TEXT; every belonging Asset, including archived/deleted rows, has that same modality. An unresolved historical Dataset has null modality. New Datasets cannot be unresolved. An assigned modality cannot change or become null, including when the Dataset has no Assets.

Dataset modality chooses the engine; Asset modality validates content compatibility only. Workflow remains independent: exact COMPLETED selects visualization from the catalog; other workflow values select workspace. Phase028 validation remains defensive protection for legacy/corrupt data. No automatic split, move, delete, relabel or annotation rewrite.

## 2. Proposed Prisma diff

Reuse the existing Modality enum. Keep Dataset.type and primaryModality temporarily for compatibility; neither is authoritative. The following is a **proposal**, not an edited schema:

```diff
 model Dataset {
+  modality                   Modality?
+  modalityContentRevision    BigInt    @default(0)
+  modalityResolvedAt         DateTime?
+  modalityResolvedById       String?
+  modalityResolvedBy         User? @relation("DatasetModalityResolver", fields: [modalityResolvedById], references: [id], onDelete: Restrict, onUpdate: Restrict)
   // existing id, owner, assets, workflow and other fields remain
 }
 model User {
+  modalityResolvedDatasets Dataset[] @relation("DatasetModalityResolver")
 }
```

`modalityContentRevision` is a private transaction fence, not a user-visible version or snapshot generation. `modalityResolvedAt` and `modalityResolvedById` record the first assignment, including new creation; they are immutable alongside modality. A reviewed backfill supplies its accountable system ADMIN actor; creation supplies its authenticated actor. The timestamp is set by the DB assignment trigger, not accepted from the browser. The FK prevents deletion of an attributed User until an explicitly reviewed retention/anonymization policy addresses that reference; this tradeoff requires approval.

No new Dataset/Asset model, import table or Job table. No index on modality is proposed absent a demonstrated query need. Existing Dataset PK and Asset(datasetId, modality) index serve lookup and mismatch checks. Do not add compound uniqueness/FK in the first migration. Later, after historical resolution, an optional redundant compound FK can be considered; the trigger mechanism below already enforces equality and does not depend on that later change. Making modality required is a separate migration after zero unresolved rows.

## 3. Exact database enforcement proposal

All objects below would be introduced in a **new additive reviewed migration**. Runtime code and backfill use Prisma only. Custom migration SQL needs explicit Phase029 approval; the earlier visualization SQL approval does not cover it. App/worker DB roles must not own tables or have trigger-disabling/TRUNCATE privileges; inspect role capabilities as a release prerequisite, not assume triggers protect against database administrators.

### 3.1 Objects

| Object | Timing / events | Required behavior |
| --- | --- | --- |
| `dataset_modality_resolution_shape` CHECK | Dataset row checks | Either modality, resolvedAt, resolvedById are all null, or all three are non-null. Enum restricts modality values. Historical null rows are valid. |
| `dataset_modality_insert_guard` trigger | BEFORE INSERT ON Dataset, each row | Reject null modality (`DATASET_MODALITY_REQUIRED`). Require resolver ID; set resolvedAt to transaction timestamp. Thus old writers cannot introduce new unresolved datasets after enforcement activation. |
| `dataset_modality_assignment_guard` trigger | BEFORE UPDATE ON Dataset, each row | If OLD.modality non-null, reject any distinct modality or assignment receipt. If null→non-null, require resolver ID, set DB timestamp, and reject any belonging Asset with modality different from NEW.modality, without active-only filtering. Null→null cannot introduce resolution receipt. Counter-only/ordinary updates remain allowed. |
| `asset_modality_write_guard` trigger | BEFORE INSERT OR UPDATE OR DELETE ON Asset, each row | Acquire/fence affected parent(s) as described below; use current returned parent modality. INSERT, reparent, or modality change rejects unresolved destination; every Asset write with a resolved destination rejects mismatched modality. DELETE remains allowed by DB integrity rules; service authorization still applies. |
| Resolver FK | Dataset.modalityResolvedById → User.id | Restrict deletion/update; historical null allowed. No automatic actor reassignment. |

Functions: `phase029_guard_dataset_insert()`, `phase029_guard_dataset_assignment()`, `phase029_guard_asset_write()`. Errors use a stable non-secret constraint/error marker mapped to safe API codes. No raw DB exception text is exposed. Constraints/triggers apply to all production and internal writers, nested creates, upserts, retries and direct Prisma access; there is no session bypass flag.

A CHECK alone cannot enforce parent equality or prevent changing one non-null modality to another. An Asset/Dataset FK alone cannot freeze an empty parent's modality. The Dataset assignment trigger is therefore independent of the Asset equality trigger.

### 3.2 Parent fence and lock protocol

For **every** Asset INSERT/UPDATE/DELETE, the Asset BEFORE trigger performs an actual parent row UPDATE:

```text
For each affected existing Dataset ID, ordered lexicographically:
  increment Dataset.modalityContentRevision by 1
  RETURNING Dataset.modality
  retain the parent write lock until transaction end
Validate destination compatibility using the returned modality.
Continue Asset write, or raise an integrity error (rolling back the fence too).
```

For INSERT lock NEW.datasetId; DELETE lock OLD.datasetId; reparent lock both distinct IDs in deterministic order. Ordinary Asset UPDATE also participates, even if it only affects workflow/dimensions. This intentionally conservative scope avoids missing source identity/classification changes and archived-row transitions; it may cause backfill retries on unrelated Asset writes, but does not alter asset revision/workflow semantics. It is narrower than fencing unrelated Dataset/Annotation/Label operations. The extra parent write serializes Asset writers within a Dataset; this adds contention and must pass realistic bulk-import throughput/deadlock tests before deployment. Counter increments are transactional, not an exact user mutation count. No-op and bulk writes may increment more than once; correctness requires monotonic change, not a specific delta.

Parent hard-delete cascades must remain legitimate: DELETE of an Asset whose parent is already absent within the same Dataset cascade does not try to recreate or reject the parent. Missing INSERT/UPDATE destination is rejected by existing referential integrity. Reparent lock order does not eliminate every deadlock with bulk writes/existing triggers; retry the entire transaction on serialization/deadlock failure. Bound retries and return a safe conflict after exhaustion.

Dataset assignment already writes/locks the parent. Before that assignment transaction classifies any children, it claims the same fence through a Prisma parent update. All classification/backfill transactions run **Serializable**, not a read-committed scan followed by a later update. A concurrent Asset writer touching the parent after the assignment transaction's snapshot forces serialization failure on that fence write; an Asset writer starting later waits and then validates the newly assigned parent. The parent scan and assignment cannot silently accept an Asset inserted against an older null state.

The trigger's parent UPDATE RETURNING is deliberate: an unlocked SELECT of parent modality could validate against stale state. Existing visualization-generation triggers remain independent; neither their active-row coverage nor Redis advisory quiescence substitutes for this protocol. Trigger lock ordering, counter-only updates and cascade deletion require integration tests with the existing visualization/relativePath triggers before approval to deploy.

### 3.3 Unresolved historical rows

Existing unresolved rows remain valid at rest. Their existing same-parent/same-modality Asset metadata updates and deletions need not fail a DB integrity check merely because the parent is unresolved; INSERT, reparent INTO unresolved, and modality changes are rejected. Application unresolved mode is stricter: it offers no annotation, label or Asset mutation UI/API operations. Existing owner/admin archive/delete lifecycle permissions remain unchanged; there is no automatic cleanup. This separation preserves legitimate authorized cleanup while preventing new content ingestion or accidental engine selection.

Normal Dataset CRUD excludes modality/receipt/counter. Only the dedicated service and controlled migration tooling issue assignment; DB guards apply regardless of service. DB triggers enforce integrity, not end-user authentication: resolver authority is rechecked server-side.

## 4. Creation and EMPTY-resolution APIs

### New creation

Existing POST `/api/datasets`, `/api/datasets/from-repository`, `/api/imports/local-folder` require Zod enum `modality` with no default/null/inference. Preserve existing names/source/taxonomy validation and creation permissions. Missing/invalid modality: 400 `INVALID_REQUEST`, no Dataset/Job side effects. Dataset and confirmed labels/common Job are created in the same existing transactional boundary. Server supplies actor attribution; safe responses add `modality` and `modalityResolution: "RESOLVED"`.

Include modality and normalized confirmed classes in creation/import idempotency fingerprints. Same key/different modality returns existing 409 idempotency conflict. Preview remains read-only; selecting a modality does not create a Dataset. Append endpoints load the existing parent and never accept a replacement modality. Retired routes remain retired; dormant legacy importer is fenced until it uses this same contract.

### Explicit EMPTY resolution

Proposed POST `/api/datasets/{datasetId}/modality-resolution`:

```json
{ "modality": "IMAGE" }
```

Strict body; no owner ID, timestamp, revision counter or bypass flag. Validate ID, authenticate, load current Dataset and authorization. Permit only actual Dataset owner or system ADMIN; dataset MANAGER membership or dataset.update alone is insufficient. Require non-archived/non-deleted Dataset and recheck authority in the assignment transaction. Archived EMPTY requires an independently authorized restoration policy first; this operation does not restore it.

Serializable transaction: claim parent fence, re-read parent, count **all** belonging Assets. If unresolved and count=0, assign modality/actor (DB sets timestamp). If any Asset exists, reject 409 `DATASET_NOT_EMPTY` even if all have one modality; this endpoint is not the backfill tool. Return 200 safe projection `{id, modality, modalityResolution:"RESOLVED", resolvedAt}`. Do not disclose actor or internal counters by default.

Retry semantics: after the same authorized request succeeds, repeating the same modality returns 200 with the original receipt and no additional assignment; different modality returns 409 `DATASET_MODALITY_IMMUTABLE`. Reauthorization happens even on replay. An owner/admin request to a previously resolved Dataset does not acquire a modality-change privilege. 401 unauthenticated; existing safe 403/404 access behavior; 409 `DATASET_UNAVAILABLE` for an authorized archived/deleted target according to existing disclosure policy. Normal PATCH attempting modality changes is rejected and never redirected into resolution automatically.

No automatic resolution UI prompt selects a default. User explicitly chooses IMAGE/VIDEO/AUDIO/TEXT and confirms that it cannot be changed through CRUD.

## 5. State and behavior matrix

Resolution DTO is derived from modality and, only when null, the all-Asset composition; do not persist a competing mutable status field. EMPTY is zero Assets; MIXED is more than one distinct modality. Single-modality-but-unresolved evidence exceptions also exist and must not be mislabeled MIXED.

| Behavior | RESOLVED | EMPTY-UNRESOLVED | MIXED-UNRESOLVED | SINGLE-UNRESOLVED |
| --- | --- | --- | --- | --- |
| Stored modality | Exact enum | null | null | null |
| Creation of new Dataset in this state | Required | Forbidden | Forbidden | Forbidden |
| Source Asset ingestion/reparent into target | Verified same modality only | Rejected 409 | Rejected 409 | Rejected 409 |
| Workspace | Dataset engine; selected Asset optional | Resolution UI; no engine | Legacy resolution notice; no engine | Verification pending notice; no engine |
| Owner/admin resolution endpoint | Same-value replay only | Explicit one-time choice | Rejected NOT_EMPTY | Rejected NOT_EMPTY |
| Automatic backfill | No reassignment | Never | Never | Only fresh verified, approved candidate via controlled tooling |
| Annotation/label/Asset mutation via product | Existing permissions/revisions | Blocked unresolved | Blocked unresolved | Blocked unresolved |
| Catalog/read/export | Existing permissions/lifecycle | Safe read; existing export eligibility | Safe legacy read/export with Phase028 defenses | Safe read/export with defenses |
| Dataset name/archive/delete | Existing permissions | Existing permissions; no modality editing | Same | Same |

No MIXED splitting or reparent tool is part of Phase029. Retaining unresolved history blocks universal NOT NULL adoption; that is explicit, not solved with an invented default. Existing COMPLETED visualization is not converted into an annotation engine and keeps its own guards/read-only supported-media behavior.

## 6. Workspace dataflow

```text
/workspace/{datasetId}
  → authenticate + validate ID
  → load/authorize Dataset, current lifecycle and safe modality
  → null: unresolved response + state-specific UI, no engine mount
  → IMAGE / VIDEO / AUDIO / TEXT: corresponding existing Workspace registry entry
  → optional selected Asset: validate datasetId + active state + matching modality
  → render content inside that already chosen engine
```

Server page renders unresolved UI (normal authenticated page response). Workspace data/selection APIs return 409 `DATASET_MODALITY_UNRESOLVED` with an allowlisted state; mutation endpoints likewise reject unresolved. Wrong-dataset/invalid selection follows safe existing 404 handling; resolved-parent mismatch returns safe 409 integrity conflict, never mounts the other engine. Empty resolved Dataset mounts its engine with a no-content state, not a fake Asset.

Selection/query/client store cannot override engine. Preserve draft flush/navigation and Annotation/Asset revision enforcement. Remove cross-modality default-label seeding from generic reads through creation-time eligible initialization. Keep existing tool maturity; this does not add missing modality tools or visualization Phase5.

## 7. Every ingestion boundary and partial outcomes

| Path | Checks before durable publication |
| --- | --- |
| Direct presign + complete | Current parent authorization/resolution; provisional upload filters; actual supported content classification, stable object identity; transactional publisher + DB guard |
| Folder new/append + prepared completion | New Dataset selected modality or fixed existing modality; each item's bytes verified; outer completed-item replay and shared publisher replay revalidate parent/equality |
| Repository import | User chooses modality at acceptance; private worker probes actual supported bytes/streams before Asset insert; fresh upsert, update, reconciliation reuse and retries all validate current parent/content identity |
| Generic/internal Prisma/nested/bulk Asset write | Shared service guard where reachable; DB trigger is mandatory backstop; no importer bypass |
| Legacy queued Jobs/import helper | Do not infer from input/first Asset; reject unresolved target and expose safe failure; dormant helper cannot reactivate without shared policy |

Extensions/MIME are UX/preflight hints only. Proven VIDEO may include audio streams; proven audio-only container is AUDIO. Ambiguous/malformed/truncated/unsupported content is explicitly rejected, not guessed. Worker uses existing bounded ffprobe/materialization infrastructure. Synchronous completion cannot claim verification from a prefix-only ambiguous signature; fail closed if definitive verification is unavailable. Full asynchronous verification-before-Asset for such uploads would need a separately reviewed common Job contract, not a provisional incompatible Asset or hidden new backend.

Confirmed partial policy: retain successfully published valid assets; reject incompatible items with `ASSET_MODALITY_MISMATCH`; report incomplete/partial results explicitly. Keep common Job lifecycle: a terminal mismatch uses FAILED with safe `IMPORT_INCOMPLETE`, and an allowlisted summary `{ outcome:"incomplete", publishedCount, rejectedCount, unprocessedCount }`. Do not add a PARTIAL enum merely for UI. Define counts over the accepted candidate set; mismatch contributes to rejected, never skipped. If processing stops on first mismatch, remaining candidates are unprocessed, not implicitly rejected. Folder commit cannot report COMPLETED unless all expected items succeeded. Existing successful item receipts remain stable across retry; a successor Job follows existing lineage/idempotency rules. No automatic deletion of valid Assets to simulate atomic import rollback.

A mismatch in the first item may yield zero published; the UI still explains rejection, not a successful empty import. Object cleanup only removes unreferenced unpublished objects through existing policy. No storage/provider details in failures or Job DTOs.

## 8. Staged migration/backfill with concurrency protection

1. **Review first:** approve this design and separately scope custom SQL/client generation. Validate trigger interaction and role privileges on disposable DB. No existing migration rewritten.
2. **Expand:** add nullable fields, receipt CHECK/FK and counter default. Existing history gets null modality/receipt and zero counter, never inferred values. Coordinate write maintenance for activation; old readers may remain, old creation/publisher workers must not keep silently operating across cutover.
3. **Activate enforcement:** install all three triggers under normal transactional DDL/table locks after draining old writer transactions; deploy explicit-modality creation and all service guards. New inserts immediately reject null. Release traffic only once compatible web/worker versions are running. Redis pause is advisory; stopped/drained processes and DB locks/guards establish the boundary.
4. **Fresh read-only dry run:** classify all belonging Asset rows, inspect source identity/content and subtype evidence. Do not backfill unavailable/unverified records. EMPTY/MIXED stay unchanged. Record candidate Dataset ID, proposed modality, parent counter and safe evidence references; do not persist object credentials.
5. **Per-candidate assignment:** verify bounded source evidence outside a long-held DB lock, then Serializable Prisma transaction claims parent fence and requires the returned counter to equal the dry-run counter plus this transaction’s single fence increment, re-reads all Asset IDs/modality/source-identity metadata and Dataset state, rejects stale evidence, and conditionally assigns only null parent. DB guard repeats all-child equality. Counter/content mismatch or P2034/deadlock aborts the whole attempt and restarts classification/evidence validation; never retries an old decision blindly.
6. **Object identity prerequisite:** DB locks protect rows, not external byte overwrites. Use exact immutable/versioned source identity or prove source writers cannot overwrite the object during verification/publication. If unavailable, block that candidate; do not claim counter equality freezes MinIO/provider bytes. No new storage versioning migration is silently assumed.
7. **Historical operations:** explicit EMPTY endpoint applies the same fence/Serializable protocol; MIXED requires separate future policy/action approval. No automatic composition repair.
8. **Routing switch:** only Dataset-driven selection; unresolved UI/409 fully deployed. Legacy export checks remain. Catalog workflow routing unchanged.
9. **Final contract:** NOT NULL only when every Dataset is resolved and no mismatch remains across all states. Optional final FK must not replace immutability trigger. If unresolved history remains, stop at transitional nullable schema and report that final tightening is blocked.

Rollback preserves assigned modality/receipts and enforcement; do not redeploy old writers that omit modality or disable triggers to make them work. A corrective migration must be separately reviewed. SQL exception/transaction rollback undoes counter increments and partial metadata writes in the failing transaction; previously committed valid import items remain.

## 9. Phase022–028 compatibility

| Phase | Preserved/adapted |
| --- | --- |
| 022 dataset/browser | IDs, pagination, selection and permissions; engine context changes, empty/unresolved UX explicit |
| 023 workflow | Annotation/Asset revisions, transition authorization and review semantics unchanged |
| 024 collaboration | Membership/revocation/outbox behavior preserved; EMPTY resolution owner/admin only, not manager privilege escalation |
| 025 TEXT | Source/offset identity, taxonomy eligibility and revision guards preserved; Dataset selects engine |
| 026 AI | Dataset narrows model suggestions; per-Asset equality, mixed rejection, supported modalities and stale target checks remain |
| 027 relativePath/COCO | Canonical path, uniqueness, export identity and write guards preserved; Redis not promoted into lock authority |
| 028 export | Keep all-present-modality and format/annotation eligibility checks as legacy/corruption defenses; no silent partial export |

Visualization1–4 retains safe reads, exact COMPLETED/reopen guards, immutable snapshots and authorized media. Assignment does not mutate old snapshots. Dataset.modality is live routing metadata in this proposal, not retroactive snapshot content; any future snapshot-format inclusion requires separate versioned contract review.

## 10. Tests and acceptance criteria

- Direct DB integration: new null Dataset rejected; historical null retained; non-null→different/null and receipt change rejected even with zero Assets; same-value no-op permitted.
- All-Asset checks: insert/update/upsert/nested create/reparent into wrong or unresolved parent rejected; archived/deleted children count; matching workflow/dimension updates and legitimate delete cascades still work.
- Two-connection races: writer before/during/after backfill fence; empty resolution versus insert; reparent both directions; concurrent null assignment; content/source metadata change; deadlock/serialization retry. Never commit resolved parent with incompatible child. Rollback counter/receipt consistency verified.
- Role tests: OWNER and ADMIN explicit empty choice; MANAGER/reviewer/labeler denied; revocation, unavailable Dataset and idempotent replay reauthorized.
- Every source path: spoofed extension/MIME, ambiguous media, missing subtype/source, duplicate delivery, all replay shortcuts, changed source identity and queued old jobs. No first-file engine or modality inference.
- Partial import: correct published/rejected/unprocessed counts; valid Assets preserved; mismatch never skipped; folder completion never falsely successful; retry no duplicates.
- Workspace: four empty resolved engines; unresolved EMPTY/MIXED/SINGLE no engine; selection/client/query cannot override; draft flush/revisions and lifecycle destinations preserved.
- Historical dry run unchanged data/IDs; backfill only approved verified candidates; no automatic split/move/delete/relabel.
- Regression: Phase022–028 + visualization, worker/import suites, web/worker typecheck/lint/build, Prisma/schema and reviewed migration validation, OpenAPI, keyboard/browser smoke on disposable fixtures. Do not execute mutating tests against historical user datasets.

Acceptance: zero mismatched commit for resolved Datasets across all tested paths; explicit rejection of unresolved ingestion; immutable resolved modality including empty datasets; visible incomplete imports; no implicit engine fallback; no regression in permissions/revisions/queue contracts. Do not claim universal required modality while historical nulls remain.

## 11. Decisions requested before implementation

1. Approve the proposed migration-only triggers and private counter/receipt fields. This is a new Phase029 SQL approval, not inherited from Phase4.
2. Approve resolver attribution's User FK Restrict behavior (or choose an explicitly reviewed alternative retention design before migration).
3. Approve the owner/admin endpoint, state matrix, unresolved mutation restrictions and FAILED/incomplete summary contract.
4. Confirm the fail-closed upload support limitation for ambiguous formats until verified pre-publication evidence exists; full synchronous/asynchronous parity is not invented here.
5. Approve coordinated writer cutover and isolated concurrency/trigger tests. Production backfill still needs fresh verified approved-ID evidence and a separate execution decision.

Confirmed historical and partial-import policies are not reopened. MIXED splitting remains outside Phase029. Centered CRUD positioning is documented separately in the baseline/UI report; no unrelated UI cleanup belongs to this plan.

**Stop:** review only. No runtime code, Prisma schema, generated client, migration, user data or live service changes.
