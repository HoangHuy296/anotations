import { processAiPoll } from "../jobs/ai-poll.processor.js";
import type { PrismaClient } from "../../../../lib/generated/prisma/client.js";

const DEFAULT_BATCH_LIMIT = 50;

/**
 * PostgreSQL-backed, repeat-safe due-work scan (mirrors
 * import-timeout-scanner.ts#failExpiredPreparedImports). Finds AiTask rows
 * whose scheduled next poll has elapsed and drives one poll step for each.
 * No Redis/BullMQ participates — this is why AI polling never depends on a
 * repeated queue delivery (see research.md #1).
 */
export async function pollDueAiTasks(db: PrismaClient, workerId: string, now = new Date(), limit = DEFAULT_BATCH_LIMIT): Promise<number> {
  const due = await db.aiTask.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] }, nextPollAt: { lte: now } },
    select: { jobId: true },
    take: Math.min(Math.max(limit, 1), DEFAULT_BATCH_LIMIT),
  });
  for (const task of due) {
    await processAiPoll(db, task.jobId, workerId).catch(() => undefined);
  }
  return due.length;
}
