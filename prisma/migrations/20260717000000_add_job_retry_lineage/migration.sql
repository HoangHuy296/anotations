-- Add a single direct retry-successor relationship without changing existing Job lifecycle data.
ALTER TABLE "Job" ADD COLUMN "retryOfJobId" TEXT;

CREATE UNIQUE INDEX "Job_retryOfJobId_key" ON "Job"("retryOfJobId");

ALTER TABLE "Job"
  ADD CONSTRAINT "Job_retryOfJobId_fkey"
  FOREIGN KEY ("retryOfJobId") REFERENCES "Job"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;
