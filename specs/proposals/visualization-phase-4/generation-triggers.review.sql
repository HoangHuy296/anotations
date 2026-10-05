-- REVIEW DRAFT ONLY. Not installed or executed.
-- This block is intended for the new additive Prisma migration after its
-- Dataset.visualizationGeneration bigint column and snapshot/artifact tables.
-- Runtime application data access remains Prisma-only.

CREATE FUNCTION visualization_bump_content_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE old_dataset text; new_dataset text; affected_dataset text;
        fields text[]; old_content jsonb; new_content jsonb;
BEGIN
  IF TG_TABLE_NAME = 'Asset' THEN
    fields := ARRAY['id','datasetId','filename','modality','mimeType','width','height','sizeBytes','storageProvider','storageBucket','storageKey','checksum','sourceFingerprint','deletedAt','archivedAt'];
    IF TG_OP = 'UPDATE' AND (OLD."deletedAt" IS NOT NULL OR OLD."archivedAt" IS NOT NULL)
       AND (NEW."deletedAt" IS NOT NULL OR NEW."archivedAt" IS NOT NULL) THEN RETURN NULL; END IF;
  ELSIF TG_TABLE_NAME = 'Annotation' THEN
    fields := ARRAY['id','datasetId','assetId','labelId','type','modality','geometry','revision','status','source'];
  ELSIF TG_TABLE_NAME = 'Label' THEN
    fields := ARRAY['id','datasetId','name','color','modality','scope','description'];
  END IF;
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(key,value) INTO old_content FROM jsonb_each(to_jsonb(OLD)) WHERE key = ANY(fields);
    SELECT jsonb_object_agg(key,value) INTO new_content FROM jsonb_each(to_jsonb(NEW)) WHERE key = ANY(fields);
    IF old_content = new_content THEN RETURN NULL; END IF;
  END IF;
  IF TG_OP <> 'INSERT' THEN old_dataset := OLD."datasetId"; END IF;
  IF TG_OP <> 'DELETE' THEN new_dataset := NEW."datasetId"; END IF;
  -- Stable parent ordering for a move; PG transaction rollback handles any
  -- deadlock with bulk operations and the caller retries the whole transaction.
  FOR affected_dataset IN
    SELECT DISTINCT id FROM unnest(ARRAY[old_dataset, new_dataset]) AS ids(id)
    WHERE id IS NOT NULL ORDER BY id
  LOOP
    UPDATE "Dataset" SET "visualizationGeneration" = "visualizationGeneration" + 1
      WHERE id = affected_dataset;
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE TRIGGER visualization_asset_generation
AFTER INSERT OR UPDATE OR DELETE ON "Asset"
FOR EACH ROW EXECUTE FUNCTION visualization_bump_content_generation();
CREATE TRIGGER visualization_annotation_generation
AFTER INSERT OR UPDATE OR DELETE ON "Annotation"
FOR EACH ROW EXECUTE FUNCTION visualization_bump_content_generation();
CREATE TRIGGER visualization_label_generation
AFTER INSERT OR UPDATE OR DELETE ON "Label"
FOR EACH ROW EXECUTE FUNCTION visualization_bump_content_generation();

CREATE FUNCTION visualization_bump_dataset_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.metadata->'workflowStatus') IS DISTINCT FROM (NEW.metadata->'workflowStatus')
     OR OLD."deletedAt" IS DISTINCT FROM NEW."deletedAt"
     OR OLD."archivedAt" IS DISTINCT FROM NEW."archivedAt"
     OR OLD.name IS DISTINCT FROM NEW.name
     OR OLD.description IS DISTINCT FROM NEW.description THEN
    NEW."visualizationGeneration" := OLD."visualizationGeneration" + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER visualization_dataset_generation
BEFORE UPDATE ON "Dataset"
FOR EACH ROW EXECUTE FUNCTION visualization_bump_dataset_generation();

CREATE FUNCTION visualization_immutable_published_reference() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Published visualization references are immutable';
  END IF;
  IF EXISTS (SELECT 1 FROM "Dataset" WHERE id = OLD."datasetId" AND "deletedAt" IS NULL) THEN
    RAISE EXCEPTION 'Published visualization references are retained with the dataset';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER visualization_snapshot_immutable
BEFORE UPDATE OR DELETE ON "DatasetSnapshot"
FOR EACH ROW EXECUTE FUNCTION visualization_immutable_published_reference();
CREATE TRIGGER visualization_artifact_immutable
BEFORE UPDATE OR DELETE ON "VisualizationArtifact"
FOR EACH ROW EXECUTE FUNCTION visualization_immutable_published_reference();
