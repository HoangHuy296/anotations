
-- CreateTable
CREATE TABLE "DatasetShareLink" (
    "id" TEXT NOT NULL,
    "datasetId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "role" "DatasetMemberRole" NOT NULL DEFAULT 'LABELER',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DatasetShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DatasetShareLink_tokenHash_key" ON "DatasetShareLink"("tokenHash");

-- CreateIndex
CREATE INDEX "DatasetShareLink_datasetId_revokedAt_expiresAt_idx" ON "DatasetShareLink"("datasetId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "DatasetShareLink_createdById_idx" ON "DatasetShareLink"("createdById");

-- AddForeignKey
ALTER TABLE "DatasetShareLink" ADD CONSTRAINT "DatasetShareLink_datasetId_fkey" FOREIGN KEY ("datasetId") REFERENCES "Dataset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DatasetShareLink" ADD CONSTRAINT "DatasetShareLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

