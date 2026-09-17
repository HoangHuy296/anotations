"use client";

import type { SafeExportJobWithDataset } from "@/lib/exports/types";

type ApiEnvelope<T> = { data?: T; error?: { message?: string } };

export async function fetchExportHistory(input: { cursor?: string; limit: number }): Promise<{ items: SafeExportJobWithDataset[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: String(input.limit) });
  if (input.cursor) params.set("cursor", input.cursor);
  const response = await fetch(`/api/export?${params.toString()}`, { credentials: "same-origin", cache: "no-store" });
  const body = await response.json() as ApiEnvelope<{ items: SafeExportJobWithDataset[]; nextCursor: string | null }>;
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Your export history could not be loaded.");
  return body.data;
}

/** Resolved on demand, never precomputed for a whole list -- the presigned
 * download capability is short-lived and object-scoped. */
export async function fetchExportDownload(jobId: string): Promise<{ url: string; filename: string; expiresAt: string } | null> {
  const response = await fetch(`/api/export/${encodeURIComponent(jobId)}`, { credentials: "same-origin", cache: "no-store" });
  const body = await response.json() as ApiEnvelope<{ download: { url: string; filename: string; expiresAt: string } | null }>;
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "This export's download link is unavailable.");
  return body.data.download;
}
