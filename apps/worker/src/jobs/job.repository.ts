import { randomUUID } from "node:crypto";

import type { Job, PrismaClient } from "../../../../lib/generated/prisma/client.js";

/**
 * Private worker-only ownership result. The lock token is never added to a
 * BullMQ payload, JobEvent, public response, or browser-visible state.
 */
export interface ClaimedJob {
  job: Job;
  lockToken: string;
}

/**
 * The approved raw-SQL exception for Phase 008. This is deliberately one
 * parameterized PostgreSQL UPDATE ... RETURNING statement: no pre-read is
 * allowed because the database must decide eligibility and preserve timestamps
 * atomically with the lock acquisition.
 */
export async function claimJob(db: PrismaClient, jobId: string, workerId: string): Promise<ClaimedJob | null> {
  const lockToken = randomUUID();
  const rows = await db.$queryRaw<Job[]>`
    UPDATE "Job"
    SET
      "status" = 'RUNNING',
      "lockedBy" = ${workerId},
      "lockToken" = ${lockToken},
      "lockedAt" = NOW(),
      "lockedUntil" = NOW() + INTERVAL '5 minutes',
      "heartbeatAt" = NOW(),
      "startedAt" = COALESCE("startedAt", NOW()),
      "dequeuedAt" = COALESCE("dequeuedAt", NOW()),
      "updatedAt" = NOW()
    WHERE "id" = ${jobId}
      AND "status" IN ('QUEUED', 'RETRYING')
      AND ("lockedUntil" IS NULL OR "lockedUntil" < NOW())
    RETURNING *
  `;
  const job = rows[0];
  return job ? { job, lockToken } : null;
}
