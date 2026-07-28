-- Approved schema-alignment rename. PostgreSQL preserves all existing values.
ALTER TABLE "Dataset" RENAME COLUMN "sourceBranch" TO "sourceRef";
ALTER TABLE "Asset" RENAME COLUMN "sourceBranch" TO "sourceRef";
ALTER TABLE "AssetVersion" RENAME COLUMN "sourceBranch" TO "sourceRef";
