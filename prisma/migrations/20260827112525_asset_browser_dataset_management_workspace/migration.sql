-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobStage" ADD VALUE 'RESOLVING_SELECTION';
ALTER TYPE "JobStage" ADD VALUE 'DELETING_ASSETS';
ALTER TYPE "JobStage" ADD VALUE 'EXPORTING_SELECTED_ASSETS';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "JobType" ADD VALUE 'BULK_DELETE_ASSETS';
ALTER TYPE "JobType" ADD VALUE 'BULK_EXPORT_SELECTED';

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "assignedToId" TEXT;

-- CreateTable
CREATE TABLE "AssetLabel" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "labelId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "AssetLabel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssetLabel_labelId_idx" ON "AssetLabel"("labelId");

-- CreateIndex
CREATE INDEX "AssetLabel_createdById_idx" ON "AssetLabel"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "AssetLabel_assetId_labelId_key" ON "AssetLabel"("assetId", "labelId");

-- CreateIndex
CREATE INDEX "Asset_assignedToId_idx" ON "Asset"("assignedToId");

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLabel" ADD CONSTRAINT "AssetLabel_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLabel" ADD CONSTRAINT "AssetLabel_labelId_fkey" FOREIGN KEY ("labelId") REFERENCES "Label"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetLabel" ADD CONSTRAINT "AssetLabel_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
