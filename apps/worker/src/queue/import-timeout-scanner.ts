import { logJobEvent } from "@fieldframe/domain";

import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

/** PostgreSQL-backed, repeat-safe expiry scan. No Redis state participates. */
export async function failExpiredPreparedImports(db: PrismaClient, now = new Date()) {
  const candidates = await db.preparedImport.findMany({
    where: { status: "PREPARING", deadlineAt: { lt: now }, job: { status: { in: ["RUNNING", "RETRYING"] } } },
    select: { id: true, jobId: true, createdAt: true },
    take: 100,
  });
  let failed = 0;
  for (const candidate of candidates) {
    const transitioned = await db.$transaction(async (tx) => {
      const job = await tx.job.updateMany({
        where: { id: candidate.jobId, status: { in: ["RUNNING", "RETRYING"] }, preparedImport: { status: "PREPARING", deadlineAt: { lt: now } } },
        data: { status: "FAILED", stage: "FINISHED", errorCode: "IMPORT_COMMIT_TIMEOUT", error: "The import was not committed before its deadline.", finishedAt: now, summary: { outcome: "failed", message: "Import timed out before completion." } },
      });
      if (!job.count) return false;
      await tx.preparedImport.update({ where: { id: candidate.id }, data: { status: "EXPIRED" } });
      await tx.jobEvent.create({ data: { jobId: candidate.jobId, stage: "FINISHED", level: "ERROR", message: "JOB_FAILED", data: { reason: "IMPORT_COMMIT_TIMEOUT" } } });
      return true;
    });
    if (transitioned) {
      failed += 1;
      // 021-production-hardening-garbage-collection (FR-013/FR-046): record
      // how long the import waited (from when it was prepared) before being
      // timed out — never Job.input/state, just identifiers and duration.
      logJobEvent("JOB_FAILED", { jobId: candidate.jobId, reason: "IMPORT_COMMIT_TIMEOUT", durationMs: now.getTime() - candidate.createdAt.getTime() }, "error");
    }
  }
  return failed;
}
