import "server-only";

import { JobStatus } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { db } from "@/lib/db";
import { browserReachableMinioUrl, getDirectUploadProviders } from "@/lib/providers";
import { readAuthorizedExportJob } from "@/lib/exports/authorization";
import type { SafeExportDownload } from "@/lib/exports/types";

const EXPORT_DOWNLOAD_TTL_SECONDS = 5 * 60;

export type ExportDownloadResult =
  | { ok: false; status: 403 | 404 | 409 }
  | { ok: true; value: SafeExportDownload | null };

/** Issues the architecture-approved short-lived download capability only after Dataset authorization. */
export async function createAuthorizedExportDownload(actor: RequestActor, jobId: string): Promise<ExportDownloadResult> {
  const authorized = await readAuthorizedExportJob(actor, jobId);
  if (!authorized.ok) return authorized;
  const job = await db.job.findUnique({
    where: { id: authorized.job.id },
    select: { status: true, resultStorageKey: true, resultFilename: true },
  });
  if (!job) return { ok: false, status: 404 };
  if (job.status !== JobStatus.COMPLETED) return { ok: true, value: null };
  if (!job.resultStorageKey) return { ok: false, status: 409 };

  try {
    const { config, minio, publicMinio } = getDirectUploadProviders();
    await minio.statObject(config.MINIO_BUCKET, job.resultStorageKey);
    const signed = await publicMinio.presignedGetObject(config.MINIO_BUCKET, job.resultStorageKey, EXPORT_DOWNLOAD_TTL_SECONDS);
    return {
      ok: true,
      value: {
        url: browserReachableMinioUrl(signed, config.MINIO_PUBLIC_ENDPOINT),
        expiresAt: new Date(Date.now() + EXPORT_DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
        filename: job.resultFilename ?? "dataset-export.json",
      },
    };
  } catch {
    return { ok: false, status: 409 };
  }
}
