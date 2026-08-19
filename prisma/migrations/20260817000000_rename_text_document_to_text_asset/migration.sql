-- Rename "TextDocument" -> "TextAsset" so the table name matches the
-- checked-in `prisma/schema.prisma` (which already declares `model
-- TextAsset` / `Asset.textAsset`, no `@@map` override) and the sibling
-- naming convention already used by `imageAsset`/`videoAsset`/`audioAsset`.
-- The schema/migration drift this closes was flagged (and deliberately
-- deferred) by the header comment in
-- 20260814000000_add_ai_model_and_reshape_ai_task/migration.sql:
-- "a separate, unrelated TextDocument -> TextAsset rename is owned by
-- another in-flight change" — that change is this one
-- (021-production-hardening-garbage-collection).
--
-- This is not cosmetic: application code (e.g.
-- apps/web/src/lib/asset-upload.ts's TEXT-modality branch) already writes
-- through the `textAsset` relation the current schema declares. Without
-- this rename, any TEXT-modality asset create/read fails at runtime with
-- "relation \"TextAsset\" does not exist", because the live table was still
-- named "TextDocument".
--
-- Pure rename: no column, type, or data change. Every existing row
-- (created under the old table name) is preserved as-is.

ALTER TABLE "TextDocument" RENAME TO "TextAsset";
ALTER TABLE "TextAsset" RENAME CONSTRAINT "TextDocument_pkey" TO "TextAsset_pkey";
ALTER TABLE "TextAsset" RENAME CONSTRAINT "TextDocument_assetId_fkey" TO "TextAsset_assetId_fkey";
ALTER INDEX "TextDocument_assetId_key" RENAME TO "TextAsset_assetId_key";
ALTER INDEX "TextDocument_assetId_idx" RENAME TO "TextAsset_assetId_idx";
