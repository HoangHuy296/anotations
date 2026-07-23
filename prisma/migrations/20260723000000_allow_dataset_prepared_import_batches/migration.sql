-- A Dataset can receive more than one direct browser upload batch.
DROP INDEX "PreparedImport_datasetId_key";

CREATE INDEX "PreparedImport_datasetId_createdAt_idx"
  ON "PreparedImport"("datasetId", "createdAt");
