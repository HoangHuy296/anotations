"use client";

import { pollVerification, type VerificationView } from "@/lib/client/verification-polling";

export type DirectUploadRequest = {
  datasetId: string;
  file: File;
};

type PresignedUploadResponse = {
  uploadUrl: string;
  method: "POST";
  formFields: Record<string, string>;
  fileId: string;
};

async function responseData<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null) as { data?: T; error?: { message?: string } } | null;
  if (!response.ok || !payload?.data) throw new Error(payload?.error?.message ?? "Upload request failed.");
  return payload.data;
}

/** Browser helper keeps signed POST fields transient and sends only an opaque file id to completion. */
export async function directUploadAsset(input: DirectUploadRequest) {
  const presign = await responseData<PresignedUploadResponse>(await fetch("/api/assets/presigned-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ datasetId: input.datasetId, filename: input.file.name, contentType: input.file.type, sizeBytes: input.file.size }),
  }));
  const form = new FormData();
  for (const [name, value] of Object.entries(presign.formFields)) form.append(name, value);
  form.append("file", input.file, input.file.name);
  const transfer = await fetch(presign.uploadUrl, { method: presign.method, body: form });
  if (!transfer.ok) throw new Error("Binary upload failed.");
  const completion = await fetch("/api/assets/complete-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fileId: presign.fileId }),
  });
  // A2: 202 means "accepted for verification, NOT published". Poll the verification; the Asset exists only once it is PUBLISHED.
  if (completion.status === 202) {
    const accepted = await responseData<{ verification: VerificationView }>(completion);
    const final = await pollVerification(accepted.verification.id);
    if (final.status === "PUBLISHED" && final.asset) return { asset: final.asset, replayed: false } as { asset: unknown; replayed: boolean };
    throw new DirectUploadVerificationError(final.status, final.code);
  }
  return responseData(completion);
}

/** A terminal non-published verification outcome (rejected, stale, canceled or expired). */
export class DirectUploadVerificationError extends Error {
  constructor(readonly status: string, readonly code?: string) {
    super(code ? `The upload was not accepted (${code}).` : "The upload was not accepted.");
    this.name = "DirectUploadVerificationError";
  }
}
