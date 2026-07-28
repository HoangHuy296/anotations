-- Adds the durable, owner-scoped idempotency boundary for repository Dataset
-- creation. Existing Dataset rows retain NULL values and remain unaffected.
ALTER TABLE "Dataset"
  ADD COLUMN "creationIdempotencyKey" TEXT,
  ADD COLUMN "creationRequestHash" TEXT;

CREATE UNIQUE INDEX "Dataset_ownerId_creationIdempotencyKey_key"
  ON "Dataset"("ownerId", "creationIdempotencyKey");
