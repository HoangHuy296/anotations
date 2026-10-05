import "server-only";
import { db } from "@/lib/db";

export async function readVisualizationActivity(datasetId: string, page: number, pageSize: number) {
  const [jobs, total] = await Promise.all([
    db.job.findMany({ where: { datasetId }, select: { id: true, type: true, status: true, createdAt: true, finishedAt: true }, orderBy: [{ createdAt: "desc" }, { id: "asc" }], skip: (page - 1) * pageSize, take: pageSize }),
    db.job.count({ where: { datasetId } }),
  ]);
  return { items: jobs.map(job => ({ ...job, createdAt: job.createdAt.toISOString(), finishedAt: job.finishedAt?.toISOString() ?? null })), total, page, pageSize };
}
