-- specs/027-coco-dataset-export §6, §10, Phase ENFORCE.
-- PREPARED, NOT APPLIED. Not placed in prisma/migrations/. Requires:
--   1. Phase EXPAND-1 + EXPAND-2 + GATE (§10) confirmed complete, AND
--   2. Phase BACKFILL (scripts/027-backfill-relative-path.ts --apply)
--      confirmed complete with ZERO remaining LIVE (deletedAt IS NULL)
--      relativePath IS NULL rows -- no residual tolerance for live rows
--      (archived/deleted rows may still carry NULL; see §10a),
-- run inside the writer-quiescence window, immediately after the final
-- dry-run/apply, per §10's exact procedure.
--
-- TWO mechanisms, doing two different jobs:
--
-- (1) CHECK CONSTRAINT: "a live Asset must have a non-null relativePath."
--     A plain, native Postgres constraint -- no trigger needed for this
--     rule. Critically, ALTER TABLE ... ADD CONSTRAINT validates every
--     EXISTING row at add time (a full table scan, trivially fast at this
--     table's size): if even one live row still has relativePath IS NULL,
--     this statement fails outright and nothing below it runs -- an
--     atomic, DB-enforced proof that BACKFILL actually reached zero live
--     NULLs, not merely a report claiming so. This is also what makes a
--     future revival (clearing deletedAt) impossible without simultaneously
--     providing a valid relativePath, DB-enforced independent of any
--     application-layer check (spec §10's steady-state invariant, corrected
--     to have no permanent live-NULL exception, including for revival).
--
-- (2) The identity-uniqueness trigger (unchanged from the prior draft):
--     "no two live Assets share a (datasetId, relativePath)." Spike-verified
--     mechanism (§11c). Enforces uniqueness of an ALREADY-normalized value;
--     contains no normalization logic itself.
--
-- Error shapes, both spike-verified, deliberately different in ergonomics
-- because they serve different audiences:
--   - Mechanism (2)'s conflict is a ROUTINE, expected condition during real
--     imports -- its marker is P2002 + meta.target === null
--     (packages/domain/src/asset-identity-conflict.ts), clean enough for
--     the application to translate into IMPORT_ITEM_CONFLICT.
--   - Mechanism (1)'s violation should be UNREACHABLE in normal operation,
--     because the application layer's own pre-check (never implemented
--     into a real revival path yet -- none exists today, see the writer
--     inventory) is the primary, user-facing guard; the constraint is a
--     backstop for a bug or bypass, not a routine condition. Verified: a
--     violation surfaces via a typed Prisma call as
--     `PrismaClientUnknownRequestError` with `code: undefined`,
--     `meta: undefined` -- no clean structured signal, confirmed by spike.
--     packages/domain/src/asset-revival.ts's best-effort message-matching
--     detector exists for logging/diagnostics only, never as the primary
--     mechanism -- exactly per instruction ("never invent a path... reject
--     the revival with an explicit APPLICATION error" first).

ALTER TABLE "Asset" ADD CONSTRAINT asset_live_requires_relative_path
  CHECK ("deletedAt" IS NOT NULL OR "relativePath" IS NOT NULL);

CREATE OR REPLACE FUNCTION asset_relative_path_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."relativePath" IS NULL OR NEW."deletedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  -- Serializes all concurrent writers targeting the same (datasetId,
  -- relativePath) key so the existence check below cannot race. Released
  -- automatically at transaction end (commit or rollback).
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."datasetId" || ':' || NEW."relativePath", 0));

  IF EXISTS (
    SELECT 1 FROM "Asset"
    WHERE "datasetId" = NEW."datasetId"
      AND "relativePath" = NEW."relativePath"
      AND "deletedAt" IS NULL
      AND id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'IMPORT_ITEM_CONFLICT: % already used in dataset %', NEW."relativePath", NEW."datasetId"
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'asset_relative_path_guard';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER asset_relative_path_guard_trigger
  AFTER INSERT OR UPDATE OF "relativePath", "deletedAt" ON "Asset"
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION asset_relative_path_guard();
