-- Phase029 candidate: NOT approved for production execution.
-- Receipt subject is an immutable historical actor ID, deliberately NOT a User FK.
ALTER TABLE "Dataset"
  ADD COLUMN "modality" "Modality",
  ADD COLUMN "modalityContentRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "modalityResolvedAt" TIMESTAMP(3),
  ADD COLUMN "modalityResolverSubject" TEXT;
ALTER TABLE "Dataset" ADD CONSTRAINT "dataset_modality_resolution_shape" CHECK (
  ("modality" IS NULL AND "modalityResolvedAt" IS NULL AND "modalityResolverSubject" IS NULL)
  OR ("modality" IS NOT NULL AND "modalityResolvedAt" IS NOT NULL
      AND "modalityResolverSubject" IS NOT NULL AND length("modalityResolverSubject") BETWEEN 1 AND 128)
);
ALTER TABLE "Dataset" ADD CONSTRAINT "dataset_modality_revision_nonnegative" CHECK ("modalityContentRevision" >= 0);

CREATE FUNCTION phase029_guard_dataset_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."modality" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'DATASET_MODALITY_REQUIRED', MESSAGE = 'DATASET_MODALITY_REQUIRED';
  END IF;
  NEW."modalityResolvedAt" := transaction_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER dataset_modality_insert_guard BEFORE INSERT ON "Dataset"
FOR EACH ROW EXECUTE FUNCTION phase029_guard_dataset_insert();

CREATE FUNCTION phase029_guard_dataset_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."modalityContentRevision" < OLD."modalityContentRevision" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'DATASET_MODALITY_FENCE_REWIND', MESSAGE = 'DATASET_MODALITY_FENCE_REWIND';
  END IF;
  IF OLD."modality" IS NOT NULL THEN
    IF NEW."modality" IS DISTINCT FROM OLD."modality"
      OR NEW."modalityResolvedAt" IS DISTINCT FROM OLD."modalityResolvedAt"
      OR NEW."modalityResolverSubject" IS DISTINCT FROM OLD."modalityResolverSubject" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'DATASET_MODALITY_IMMUTABLE', MESSAGE = 'DATASET_MODALITY_IMMUTABLE';
    END IF;
  ELSIF NEW."modality" IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "Asset" WHERE "datasetId" = OLD.id AND "modality" <> NEW."modality") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ASSET_MODALITY_MISMATCH', MESSAGE = 'ASSET_MODALITY_MISMATCH';
    END IF;
    NEW."modalityResolvedAt" := transaction_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dataset_modality_assignment_guard BEFORE UPDATE ON "Dataset"
FOR EACH ROW EXECUTE FUNCTION phase029_guard_dataset_assignment();

CREATE FUNCTION phase029_guard_asset_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE old_parent TEXT; new_parent TEXT; parent_id TEXT; parent_modality "Modality";
BEGIN
  IF TG_OP <> 'INSERT' THEN old_parent := OLD."datasetId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_parent := NEW."datasetId"; END IF;
  FOR parent_id IN SELECT DISTINCT id FROM unnest(ARRAY[old_parent, new_parent]) AS ids(id)
                   WHERE id IS NOT NULL ORDER BY id LOOP
    UPDATE "Dataset" SET "modalityContentRevision" = "modalityContentRevision" + 1
      WHERE id = parent_id RETURNING "modality" INTO parent_modality;
    IF NOT FOUND THEN
      IF TG_OP = 'DELETE' THEN CONTINUE; END IF; -- legitimate Dataset cascade
      RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'Asset_datasetId_fkey', MESSAGE = 'DATASET_NOT_FOUND';
    END IF;
    IF TG_OP <> 'DELETE' AND parent_id = new_parent THEN
      IF parent_modality IS NULL THEN
        IF TG_OP = 'INSERT' THEN
          RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'DATASET_MODALITY_UNRESOLVED', MESSAGE = 'DATASET_MODALITY_UNRESOLVED';
        ELSIF OLD."datasetId" IS DISTINCT FROM NEW."datasetId" OR OLD."modality" IS DISTINCT FROM NEW."modality" THEN
          RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'DATASET_MODALITY_UNRESOLVED', MESSAGE = 'DATASET_MODALITY_UNRESOLVED';
        END IF;
      ELSIF parent_modality <> NEW."modality" THEN
        RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ASSET_MODALITY_MISMATCH', MESSAGE = 'ASSET_MODALITY_MISMATCH';
      END IF;
    END IF;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER asset_modality_write_guard BEFORE INSERT OR UPDATE OR DELETE ON "Asset"
FOR EACH ROW EXECUTE FUNCTION phase029_guard_asset_write();
