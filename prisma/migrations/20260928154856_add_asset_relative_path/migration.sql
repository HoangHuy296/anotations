-- specs/027-coco-dataset-export §10, Phase EXPAND-1.
--
-- Schema-only. No data write. Trivially reversible (DROP COLUMN).
-- The column stays nullable INDEFINITELY -- see spec §10's steady-state
-- invariant: non-null-ness for new rows is an application-layer guarantee
-- (the shared normalizeAssetRelativePath() rejecting the write outright),
-- never a NOT NULL constraint. Nothing in this design ever requires the
-- column itself to reject NULL, which is exactly what lets the 66 known
-- historical duplicate Assets (spec §5) coexist with the invariant without
-- any data mutation.
--
-- BACKFILL and ENFORCE (the CHECK constraint + identity trigger) are
-- separate, later migrations/approval gates -- this migration does not
-- install either.

ALTER TABLE "Asset" ADD COLUMN "relativePath" TEXT;
