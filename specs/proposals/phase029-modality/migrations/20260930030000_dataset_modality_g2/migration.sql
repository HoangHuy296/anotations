-- NEW G2 additive candidate, after the 23-migration recovery baseline.
-- ISOLATED REVIEW ONLY. Production cutover/backfill and G3 performance approval remain HOLD.
-- Receipt subject is an immutable historical actor ID, deliberately NOT a User FK.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '120s';
LOCK TABLE public."Dataset", public."Asset" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE public."Dataset"
  ADD COLUMN "modality" public."Modality",
  ADD COLUMN "modalityContentRevision" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "modalityResolvedAt" TIMESTAMP(3),
  ADD COLUMN "modalityResolverSubject" TEXT;
ALTER TABLE public."Dataset" ADD CONSTRAINT "dataset_modality_resolution_shape" CHECK (
  ("modality" IS NULL AND "modalityResolvedAt" IS NULL AND "modalityResolverSubject" IS NULL)
  OR ("modality" IS NOT NULL AND "modalityResolvedAt" IS NOT NULL
      AND "modalityResolverSubject" IS NOT NULL AND length("modalityResolverSubject") BETWEEN 1 AND 128)
);
ALTER TABLE public."Dataset" ADD CONSTRAINT "dataset_modality_revision_nonnegative" CHECK ("modalityContentRevision" >= 0);

CREATE FUNCTION public.phase029_guard_dataset_insert() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW."modality" IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'DATASET_MODALITY_REQUIRED', MESSAGE = 'DATASET_MODALITY_REQUIRED';
  END IF;
  NEW."modalityResolvedAt" := transaction_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER dataset_modality_insert_guard BEFORE INSERT ON public."Dataset"
FOR EACH ROW EXECUTE FUNCTION public.phase029_guard_dataset_insert();

CREATE FUNCTION public.phase029_guard_dataset_assignment() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
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
    IF EXISTS (SELECT 1 FROM public."Asset" WHERE "datasetId" = OLD.id AND "modality" <> NEW."modality") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ASSET_MODALITY_MISMATCH', MESSAGE = 'ASSET_MODALITY_MISMATCH';
    END IF;
    NEW."modalityResolvedAt" := transaction_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER dataset_modality_assignment_guard BEFORE UPDATE ON public."Dataset"
FOR EACH ROW EXECUTE FUNCTION public.phase029_guard_dataset_assignment();

CREATE FUNCTION public.phase029_guard_asset_write() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE old_parent TEXT; new_parent TEXT; parent_id TEXT; parent_modality public."Modality";
        requires_fence BOOLEAN := TRUE;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_parent := OLD."datasetId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_parent := NEW."datasetId"; END IF;
  IF TG_OP = 'UPDATE' THEN
    -- Fence membership, modality, and persisted source/classification identity.
    -- Display/workflow fields (including filename: extensions are only hints)
    -- do not change approved backfill evidence and must not serialize otherwise
    -- unrelated Asset writers on the Dataset row. Keep the full evidence set in
    -- sync with the approved backfill evidence DTO:
    -- datasetId, modality, sourceMode, storageProvider/Bucket/Key, checksum,
    -- externalRepositoryId, sourceProvider/Ref/Revision/Path, relativePath,
    -- sourceFileSha, sourceBlobSha, sourceLfsOid, sourceEtag, sourceUrl,
    -- sourceFingerprint, currentVersionId, mimeType, sizeBytes, width, height,
    -- durationMs, and textLength.
    requires_fence := ROW(
      OLD."datasetId", OLD."modality", OLD."sourceMode", OLD."storageProvider",
      OLD."storageBucket", OLD."storageKey", OLD."checksum", OLD."externalRepositoryId",
      OLD."sourceProvider", OLD."sourceRef", OLD."sourceRevision", OLD."sourcePath",
      OLD."relativePath", OLD."sourceFileSha", OLD."sourceBlobSha", OLD."sourceLfsOid",
      OLD."sourceEtag", OLD."sourceUrl", OLD."sourceFingerprint", OLD."currentVersionId",
      OLD."mimeType", OLD."sizeBytes", OLD."width", OLD."height", OLD."durationMs", OLD."textLength"
    ) IS DISTINCT FROM ROW(
      NEW."datasetId", NEW."modality", NEW."sourceMode", NEW."storageProvider",
      NEW."storageBucket", NEW."storageKey", NEW."checksum", NEW."externalRepositoryId",
      NEW."sourceProvider", NEW."sourceRef", NEW."sourceRevision", NEW."sourcePath",
      NEW."relativePath", NEW."sourceFileSha", NEW."sourceBlobSha", NEW."sourceLfsOid",
      NEW."sourceEtag", NEW."sourceUrl", NEW."sourceFingerprint", NEW."currentVersionId",
      NEW."mimeType", NEW."sizeBytes", NEW."width", NEW."height", NEW."durationMs", NEW."textLength"
    );
  END IF;
  IF NOT requires_fence THEN
    -- Parent modality cannot change after resolution. A plain MVCC read retains
    -- the prior equality check without a hot-parent UPDATE lock for metadata-only
    -- writes. Every invariant-relevant transition still takes the fence below.
    SELECT "modality" INTO parent_modality FROM public."Dataset" WHERE id = new_parent;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23503', CONSTRAINT = 'Asset_datasetId_fkey', MESSAGE = 'DATASET_NOT_FOUND';
    END IF;
    IF parent_modality IS NOT NULL AND parent_modality <> NEW."modality" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = 'ASSET_MODALITY_MISMATCH', MESSAGE = 'ASSET_MODALITY_MISMATCH';
    END IF;
  ELSE
    FOR parent_id IN SELECT DISTINCT id FROM unnest(ARRAY[old_parent, new_parent]) AS ids(id)
                     WHERE id IS NOT NULL ORDER BY id LOOP
      UPDATE public."Dataset" SET "modalityContentRevision" = "modalityContentRevision" + 1
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
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER asset_modality_write_guard BEFORE INSERT OR UPDATE OR DELETE ON public."Asset"
FOR EACH ROW EXECUTE FUNCTION public.phase029_guard_asset_write();

COMMIT;
