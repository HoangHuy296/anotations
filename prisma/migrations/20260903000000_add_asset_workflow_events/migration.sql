-- Asset.status remains the source of truth for workflow state. These rows are
-- append-only audit events and never duplicate that state.
CREATE TYPE "AssetWorkflowAction" AS ENUM (
  'START',
  'SUBMIT',
  'OPEN_REVIEW',
  'APPROVE',
  'REJECT',
  'START_REWORK',
  'RESUBMIT'
);

CREATE TABLE "AssetWorkflowEvent" (
  "id" TEXT NOT NULL,
  "assetId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" "AssetWorkflowAction" NOT NULL,
  "fromStatus" "AssetStatus",
  "toStatus" "AssetStatus",
  "assetRevision" INTEGER NOT NULL,
  "feedback" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AssetWorkflowEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AssetWorkflowEvent_assetId_createdAt_idx" ON "AssetWorkflowEvent"("assetId", "createdAt");
CREATE INDEX "AssetWorkflowEvent_actorId_createdAt_idx" ON "AssetWorkflowEvent"("actorId", "createdAt");

ALTER TABLE "AssetWorkflowEvent"
  ADD CONSTRAINT "AssetWorkflowEvent_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AssetWorkflowEvent"
  ADD CONSTRAINT "AssetWorkflowEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
