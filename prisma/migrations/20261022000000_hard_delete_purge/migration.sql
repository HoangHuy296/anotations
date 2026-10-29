-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'PURGE_DATASET';
ALTER TYPE "JobType" ADD VALUE 'PURGE_ASSETS';

-- CreateTable
CREATE TABLE "PurgeAudit" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "assetCount" INTEGER NOT NULL DEFAULT 0,
    "objectCount" INTEGER NOT NULL DEFAULT 0,
    "objectsDeleted" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PurgeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurgeAudit_datasetId_idx" ON "PurgeAudit"("datasetId");

-- CreateIndex
CREATE INDEX "PurgeAudit_actorId_startedAt_idx" ON "PurgeAudit"("actorId", "startedAt");
