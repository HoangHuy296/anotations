-- CreateEnum
CREATE TYPE "MediaVerificationSource" AS ENUM ('DIRECT_UPLOAD', 'LOCAL_FOLDER_ITEM');

-- CreateEnum
CREATE TYPE "MediaVerificationStatus" AS ENUM ('PENDING', 'SEALED', 'VERIFIED', 'PUBLISHED', 'REJECTED', 'STALE', 'CANCELED', 'EXPIRED');

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'VERIFY_UPLOADED_MEDIA';

-- CreateTable
CREATE TABLE "MediaVerification" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "source" "MediaVerificationSource" NOT NULL,
    "preparedImportItemId" TEXT,
    "currentJobId" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "boundDatasetModality" "Modality" NOT NULL,
    "stagedBucket" TEXT NOT NULL,
    "stagedKey" TEXT NOT NULL,
    "stagedEtag" TEXT NOT NULL,
    "stagedSizeBytes" BIGINT NOT NULL,
    "stagedLastModified" TIMESTAMP(3) NOT NULL,
    "stagedVersionId" TEXT,
    "filename" TEXT NOT NULL,
    "relativePathHint" TEXT,
    "declaredContentType" TEXT NOT NULL,
    "declaredSizeBytes" BIGINT NOT NULL,
    "sealedKey" TEXT,
    "sealedEtag" TEXT,
    "sealedSizeBytes" BIGINT,
    "sealedLastModified" TIMESTAMP(3),
    "sealedVersionId" TEXT,
    "contentSha256" TEXT,
    "status" "MediaVerificationStatus" NOT NULL DEFAULT 'PENDING',
    "verifiedModality" "Modality",
    "resultCode" TEXT,
    "resultReason" TEXT,
    "probe" JSONB,
    "policyVersion" TEXT,
    "processorVersion" TEXT,
    "lastFailureCode" TEXT,
    "lastFailureReason" TEXT,
    "lastFailureAt" TIMESTAMP(3),
    "objectsClearedAt" TIMESTAMP(3),
    "assetId" TEXT,
    "verificationDeadlineAt" TIMESTAMP(3) NOT NULL,
    "sealedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaVerification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MediaVerification_sealedKey_key" ON "MediaVerification"("sealedKey");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVerification_assetId_key" ON "MediaVerification"("assetId");

-- CreateIndex
CREATE INDEX "MediaVerification_status_verificationDeadlineAt_idx" ON "MediaVerification"("status", "verificationDeadlineAt");

-- CreateIndex
CREATE INDEX "MediaVerification_requestedById_status_idx" ON "MediaVerification"("requestedById", "status");

-- CreateIndex
CREATE INDEX "MediaVerification_datasetId_status_idx" ON "MediaVerification"("datasetId", "status");

-- CreateIndex
CREATE INDEX "MediaVerification_currentJobId_idx" ON "MediaVerification"("currentJobId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVerification_stagedBucket_stagedKey_generation_key" ON "MediaVerification"("stagedBucket", "stagedKey", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "MediaVerification_preparedImportItemId_generation_key" ON "MediaVerification"("preparedImportItemId", "generation");

-- AddForeignKey
ALTER TABLE "MediaVerification" ADD CONSTRAINT "MediaVerification_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaVerification" ADD CONSTRAINT "MediaVerification_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaVerification" ADD CONSTRAINT "MediaVerification_preparedImportItemId_fkey" FOREIGN KEY ("preparedImportItemId") REFERENCES "PreparedImportItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaVerification" ADD CONSTRAINT "MediaVerification_currentJobId_fkey" FOREIGN KEY ("currentJobId") REFERENCES "Job"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaVerification" ADD CONSTRAINT "MediaVerification_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

