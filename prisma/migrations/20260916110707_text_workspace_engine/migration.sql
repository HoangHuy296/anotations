-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CollaborationOutboxEventType" ADD VALUE 'ANNOTATION_CHANGED';
ALTER TYPE "CollaborationOutboxEventType" ADD VALUE 'TEXT_POLICY_CHANGED';

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE 'TEXT_SOURCE_PREPARE';

-- DropForeignKey
ALTER TABLE "Annotation" DROP CONSTRAINT "Annotation_fromAnnotationId_fkey";

-- DropForeignKey
ALTER TABLE "Annotation" DROP CONSTRAINT "Annotation_toAnnotationId_fkey";

-- AlterTable
ALTER TABLE "Dataset" ADD COLUMN     "textMutationRevision" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "textPolicy" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "textPolicyRevision" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "TextAsset" ADD COLUMN     "boundaryArtifactDigest" TEXT,
ADD COLUMN     "boundaryArtifactKey" TEXT,
ADD COLUMN     "boundaryProfile" JSONB,
ADD COLUMN     "offsetUnit" TEXT,
ADD COLUMN     "preparedAt" TIMESTAMP(3),
ADD COLUMN     "preparedSourceFingerprint" TEXT,
ADD COLUMN     "sourceByteLength" INTEGER,
ADD COLUMN     "sourceCodeUnitLength" INTEGER,
ADD COLUMN     "sourceEncoding" TEXT,
ADD COLUMN     "sourceIdentity" TEXT;

-- CreateTable
CREATE TABLE "AnnotationMutationReceipt" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnnotationMutationReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnnotationMutationReceipt_assetId_idx" ON "AnnotationMutationReceipt"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "AnnotationMutationReceipt_assetId_actorId_operationId_key" ON "AnnotationMutationReceipt"("assetId", "actorId", "operationId");

-- CreateIndex
CREATE INDEX "Annotation_fromAnnotationId_idx" ON "Annotation"("fromAnnotationId");

-- CreateIndex
CREATE INDEX "Annotation_toAnnotationId_idx" ON "Annotation"("toAnnotationId");

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_fromAnnotationId_fkey" FOREIGN KEY ("fromAnnotationId") REFERENCES "Annotation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Annotation" ADD CONSTRAINT "Annotation_toAnnotationId_fkey" FOREIGN KEY ("toAnnotationId") REFERENCES "Annotation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnotationMutationReceipt" ADD CONSTRAINT "AnnotationMutationReceipt_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnnotationMutationReceipt" ADD CONSTRAINT "AnnotationMutationReceipt_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
