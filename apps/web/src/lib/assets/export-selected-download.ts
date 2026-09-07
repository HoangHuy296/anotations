import "server-only";

import { JobStatus, JobType } from "@internal/db";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";
import { db } from "@/lib/db";
import { browserReachableMinioUrl, getDirectUploadProviders } from "@/lib/providers";
import type { SafeExportDownload } from "@/lib/exports/types";

const EXPORT_SELECTED_DOWNLOAD_TTL_SECONDS = 5 * 60;

type ExportSelectedJobAuthorization =
  | { ok: true; job: { id: string; datasetId: string; status: string } }
  | { ok: false; status: 403 | 404 };

/**
 * The `BULK_EXPORT_SELECTED` counterpart to `readAuthorizedExportJob`/
 * `createAuthorizedExportDownload` (022 User Story 4) -- deliberately a
 * separate, parallel function rather than widening the existing Dataset
 * Export authorization/download path to accept a second `JobType` (FR-027:
 * Export Selected must never change Dataset Export's existing behavior or
 * contract).
 */
export async function readAuthorizedExportSelectedJob(actor: RequestActor, jobId: string): Promise<ExportSelectedJobAuthorization> {
  const job = await db.job.findFirst({ where: { id: jobId, type: JobType.BULK_EXPORT_SELECTED }, select: { id: true, datasetId: true, status: true } });
  if (!job) return { ok: false, status: 404 };
  const access = await requireDatasetPermission(actor, job.datasetId, "job.createExport");
  if (!access) return { ok: false, status: 404 };
  if (access.forbidden) return { ok: false, status: 403 };
  return { ok: true, job };
}

export type ExportSelectedDownloadResult = { ok: false; status: 403 | 404 | 409 } | { ok: true; value: SafeExportDownload | null };

export async function createAuthorizedExportSelectedDownload(actor: RequestActor, jobId: string): Promise<ExportSelectedDownloadResult> {
  const authorized = await readAuthorizedExportSelectedJob(actor, jobId);
  if (!authorized.ok) return authorized;
  const job = await db.job.findUnique({ where: { id: authorized.job.id }, select: { status: true, resultStorageKey: true, resultFilename: true } });
  if (!job) return { ok: false, status: 404 };
  if (job.status !== JobStatus.COMPLETED) return { ok: true, value: null };
  if (!job.resultStorageKey) return { ok: false, status: 409 };
  try {
    const { config, minio, publicMinio } = getDirectUploadProviders();
    await minio.statObject(config.MINIO_BUCKET, job.resultStorageKey);
    const signed = await publicMinio.presignedGetObject(config.MINIO_BUCKET, job.resultStorageKey, EXPORT_SELECTED_DOWNLOAD_TTL_SECONDS);
    return {
      ok: true,
      value: {
        url: browserReachableMinioUrl(signed, config.MINIO_PUBLIC_ENDPOINT),
        expiresAt: new Date(Date.now() + EXPORT_SELECTED_DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
        filename: job.resultFilename ?? "selected-assets-export.json",
      },
    };
  } catch {
    return { ok: false, status: 409 };
  }
}
