# Phase 029 data model (proposed)

Design only. No schema/migration/generated client changes have been made.

## Dataset

Add `modality: Modality?` to the existing Dataset. Reuse IMAGE/VIDEO/AUDIO/TEXT; no default. Dataset.id remains the existing identity. New creation requires a non-null value in application validation even while the database column permits historical nulls. Do not automatically rename/backfill primaryModality. Keep type/primaryModality temporarily for old readers but never treat them as engine authority.

States: unresolved null → one explicit modality through an approved historical assignment or creation; assigned modality → same value only. Assignment is not an ordinary PATCH. Non-null→different and non-null→null are prohibited. Even deleting the last Asset does not unlock the modality.

All current Dataset authorization/deleted/archive/workflow predicates remain. Existing immutable snapshots stay unchanged; new safe live DTOs may expose modality independently. Do not retroactively populate it inside historical snapshot bytes.

## Asset

Keep id, datasetId and required modality. Enforce equality with assigned parent for every create/upsert/update/reparent/replay/restore/nested writer, including non-active children in historical verification. Matching subtype creation remains atomic with Asset publication. Actual verified source content must agree; extension/MIME alone is not evidence.

No content moves, enum corrections, annotation revisions or source changes occur as part of Dataset assignment. Full content identity verification is separate from database enum equality. A missing subtype/source remains a flagged exception requiring investigation.

## Labels and annotations

Label identities/colors/normalized names/scope semantics remain intact. Nullable universal labels stay subject to engine eligibility. New explicit modality-specific labels must be compatible with Dataset; referenced labels must not be retagged. Manual draft class creation is validated and user-confirmed. No read request seeds IMAGE defaults for other modalities.

Annotation modality/geometry/revision and asset workflow/revision rules do not change. Dataset modality does not imply annotations are accepted or correct.

## Jobs and prepared imports

Keep existing Job, PreparedImport and PreparedImportItem records; do not add import-specific Job tables. Include modality and confirmed taxonomy in new request/idempotency hashes. A replay with changed parameters is a conflict; existing prepared item `assetId` replay still validates parent and asset equality. Old unresolved jobs/items cannot infer modality from their first completion. Worker loads current parent; queue payload remains `{ jobId }`.

On late mismatch, preserve valid existing assets, persist safe failed/incomplete outcome, never report completed full import. Local-folder commit still requires every expected item; rejected items do not become silently skipped successes. Repository terminal failure retains accurate aggregate counts.

## Historical resolution

Confirmed policy: MIXED and EMPTY remain unchanged/null until explicitly resolved; ingestion blocked. EMPTY resolution requires actual owner or system ADMIN (not dataset.update alone), a transaction confirming zero belonging Assets in all states, and a durable allowlisted audit event. Exact audit-event persistence must be reviewed against existing infrastructure before command release; no new table is assumed.

MIXED has no automatic transition. Splitting/reparenting requires separate approval and cannot be authorized by this design. Enum-single datasets are only candidates: fresh source/subtype audit, approved IDs and race-safe assignment are required. Saved audit counts are not an execution list.

## Constraint and transaction stages

Compatibility uses consistent Prisma transactions and fixed-modality application checks with old writers drained. Replays cannot bypass validation. Serializable retries restart the entire transaction and re-read parent/content metadata. Do not derive correctness from Redis quiescence or visualization generation locks.

Final candidate: compound uniqueness on Dataset(id, modality) and Asset(datasetId, modality) FK, with explicit existing delete semantics and non-cascading updates. Cannot validate across unresolved parents; apply only after historical resolution. This FK does not prevent an empty parent's modality change. Database-level fixedness requires a separately approved additive immutability trigger or equivalent proven design. No runtime raw SQL. Existing migrations are never edited.

Required-field gate: all Dataset rows resolved, all children compatible, constrained concurrent writes demonstrated, old writers retired. Otherwise remain nullable with explicit legacy state; do not advertise final invariant as universally achieved.
