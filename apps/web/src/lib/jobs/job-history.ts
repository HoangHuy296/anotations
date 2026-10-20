import { JobType } from "@internal/db";

import { db } from "@/lib/db";

/** Job types that bring files into a Dataset: local-folder uploads and repository imports share IMPORT_DATASET. */
export const JOB_HISTORY_TYPES = [JobType.IMPORT_DATASET];
export const JOB_HISTORY_LIMIT = 100;

export type JobHistoryRow = {
  id: string;
  status: string;
  stage: string | null;
  progress: number | null;
  totalItems: number | null;
  processedItems: number | null;
  failedItems: number | null;
  createdAt: Date;
  finishedAt: Date | null;
  dataset: { id: string; name: string };
};

/** Import/upload Jobs of the Datasets the user owns or belongs to, newest first. Metadata only: never input, summary or error internals. */
export async function listImportJobHistory(actorId: string): Promise<JobHistoryRow[]> {
  return db.job.findMany({
    where: { type: { in: JOB_HISTORY_TYPES }, dataset: { deletedAt: null, OR: [{ ownerId: actorId }, { members: { some: { userId: actorId } } }] } },
    orderBy: { createdAt: "desc" },
    take: JOB_HISTORY_LIMIT,
    select: { id: true, status: true, stage: true, progress: true, totalItems: true, processedItems: true, failedItems: true, createdAt: true, finishedAt: true, dataset: { select: { id: true, name: true } } },
  });
}
