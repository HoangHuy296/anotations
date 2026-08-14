-- Scope: 020-ai-integration only. Deliberately does NOT touch TextDocument
-- (a separate, unrelated TextDocument -> TextAsset rename is owned by
-- another in-flight change and is out of scope here).

-- CreateTable
CREATE TABLE "AiModel" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "modality" "Modality",
    "taskType" "AiTaskType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiModel_key_key" ON "AiModel"("key");

-- CreateIndex
CREATE INDEX "AiModel_provider_idx" ON "AiModel"("provider");

-- CreateIndex
CREATE INDEX "AiModel_taskType_idx" ON "AiModel"("taskType");

-- CreateIndex
CREATE INDEX "AiModel_isActive_idx" ON "AiModel"("isActive");

-- DropForeignKey (AiTask.assetId / AiTask.jobId are being reshaped below)
ALTER TABLE "AiTask" DROP CONSTRAINT "AiTask_assetId_fkey";
ALTER TABLE "AiTask" DROP CONSTRAINT "AiTask_jobId_fkey";

-- DropIndex
DROP INDEX "AiTask_assetId_idx";
DROP INDEX "AiTask_jobId_idx";
DROP INDEX "AiTask_provider_idx";
DROP INDEX "AiTask_type_idx";

-- AlterTable AiTask: drop the direct Asset relation and the old free-text
-- provider column (provider is now resolved via AiTask.modelId ->
-- AiModel.provider); rename modelName/modelVersion to their *Snapshot
-- counterparts; add modelId/modelKeySnapshot/pollAttempts/nextPollAt;
-- jobId becomes required + unique (1:1 Job <-> AiTask).
-- Table is empty in every environment this migration has been checked
-- against, so tightening nullability here is safe.
ALTER TABLE "AiTask"
    DROP COLUMN "assetId",
    DROP COLUMN "provider",
    ADD COLUMN "modelId" TEXT NOT NULL,
    ADD COLUMN "modelKeySnapshot" TEXT NOT NULL,
    ADD COLUMN "pollAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "nextPollAt" TIMESTAMP(3),
    ALTER COLUMN "jobId" SET NOT NULL;

ALTER TABLE "AiTask" RENAME COLUMN "modelName" TO "modelNameSnapshot";
ALTER TABLE "AiTask" RENAME COLUMN "modelVersion" TO "modelVersionSnapshot";
ALTER TABLE "AiTask" ALTER COLUMN "modelNameSnapshot" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "AiTask_jobId_key" ON "AiTask"("jobId");

-- CreateIndex
CREATE INDEX "AiTask_modelId_idx" ON "AiTask"("modelId");

-- CreateIndex
CREATE INDEX "AiTask_nextPollAt_idx" ON "AiTask"("nextPollAt");

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTask" ADD CONSTRAINT "AiTask_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "AiModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
