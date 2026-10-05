-- specs/027-coco-dataset-export §10, Phase EXPAND, step 1.
-- PREPARED, NOT APPLIED. Not placed in prisma/migrations/. Requires a
-- separate approval gate before running against any real database.
--
-- Schema-only. No data write. Trivially reversible (DROP COLUMN).
-- The column stays nullable INDEFINITELY -- see spec §10's steady-state
-- invariant: non-null-ness for new rows is an application-layer guarantee
-- (the shared normalizeAssetRelativePath() rejecting the write outright),
-- never a NOT NULL constraint. Nothing in this design ever requires the
-- column itself to reject NULL, which is exactly what lets the 66+ known
-- historical duplicates (spec §5) and this DB's ongoing concurrent-writer
-- activity (spec §11c: 597 -> 609 -> presumably more by the time this runs)
-- coexist with the invariant without any data mutation.

ALTER TABLE "Asset" ADD COLUMN "relativePath" TEXT;
