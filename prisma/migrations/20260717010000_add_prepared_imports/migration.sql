-- Durable local-folder import preparation metadata. Binary data remains in MinIO.
CREATE TYPE "PreparedImportStatus" AS ENUM ('PREPARING', 'COMMITTED', 'EXPIRED');

CREATE TABLE "PreparedImport" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" "PreparedImportStatus" NOT NULL DEFAULT 'PREPARING',
    "expectedItemCount" INTEGER NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "committedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PreparedImport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PreparedImportItem" (
    "id" TEXT NOT NULL,
    "preparedImportId" TEXT NOT NULL,
    "logicalPath" TEXT NOT NULL,
    "normalizedPath" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "modality" "Modality" NOT NULL,
    "position" INTEGER NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "assetId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PreparedImportItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PreparedImport_datasetId_key" ON "PreparedImport"("datasetId");
CREATE UNIQUE INDEX "PreparedImport_jobId_key" ON "PreparedImport"("jobId");
CREATE UNIQUE INDEX "PreparedImport_createdById_idempotencyKey_key" ON "PreparedImport"("createdById", "idempotencyKey");
CREATE INDEX "PreparedImport_status_deadlineAt_idx" ON "PreparedImport"("status", "deadlineAt");
CREATE INDEX "PreparedImport_createdById_createdAt_idx" ON "PreparedImport"("createdById", "createdAt");

CREATE UNIQUE INDEX "PreparedImportItem_storageKey_key" ON "PreparedImportItem"("storageKey");
CREATE UNIQUE INDEX "PreparedImportItem_assetId_key" ON "PreparedImportItem"("assetId");
CREATE UNIQUE INDEX "PreparedImportItem_preparedImportId_normalizedPath_key" ON "PreparedImportItem"("preparedImportId", "normalizedPath");
CREATE UNIQUE INDEX "PreparedImportItem_preparedImportId_position_key" ON "PreparedImportItem"("preparedImportId", "position");
CREATE INDEX "PreparedImportItem_preparedImportId_completedAt_idx" ON "PreparedImportItem"("preparedImportId", "completedAt");
CREATE INDEX "PreparedImportItem_assetId_idx" ON "PreparedImportItem"("assetId");

ALTER TABLE "PreparedImport" ADD CONSTRAINT "PreparedImport_datasetId_fkey"
  FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreparedImport" ADD CONSTRAINT "PreparedImport_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreparedImport" ADD CONSTRAINT "PreparedImport_createdById_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PreparedImportItem" ADD CONSTRAINT "PreparedImportItem_preparedImportId_fkey"
  FOREIGN KEY ("preparedImportId") REFERENCES "PreparedImport"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PreparedImportItem" ADD CONSTRAINT "PreparedImportItem_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
