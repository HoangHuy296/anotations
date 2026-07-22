import "server-only";

import { JobType } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";

type ExportJobAuthorization =
  | { ok: true; job: { id: string; datasetId: string; status: string } }
  | { ok: false; status: 403 | 404 };

/** Resolve an export Job only through its Dataset authorization boundary. */
export async function readAuthorizedExportJob(
  actor: RequestActor,
  jobId: string,
  permission: "dataset.read" | "job.createExport" | "job.cancel" = "dataset.read",
): Promise<ExportJobAuthorization> {
  const job = await db.job.findFirst({
    where: { id: jobId, type: JobType.EXPORT_DATASET },
    select: { id: true, datasetId: true, status: true },
  });
  if (!job) return { ok: false, status: 404 };
  const access = await requireDatasetPermission(actor, job.datasetId, permission);
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  return { ok: true, job };
}
