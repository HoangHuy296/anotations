import { z } from "zod";

import { candidateContentTypes, MAX_DIRECT_UPLOAD_BYTES } from "@/lib/validation/upload";

const relativePath = z.string().trim().min(1).max(1_024)
  .refine((value) => !value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value) && !value.split(/[\\/]/).includes(".."), "A relative logical path is required.");

export const localFolderManifestItemSchema = z.object({
  logicalPath: relativePath,
  contentType: z.enum(candidateContentTypes),
  sizeBytes: z.number().int().min(1).max(MAX_DIRECT_UPLOAD_BYTES),
  fingerprint: z.string().trim().regex(/^[a-f0-9]{64}$/i, "Expected a SHA-256 fingerprint."),
}).strict();

const manifestRefinement = (value: { items: Array<{ logicalPath: string }> }, context: z.RefinementCtx) => {
  const seen = new Set<string>();
  for (const [index, item] of value.items.entries()) {
    const normalized = item.logicalPath.normalize("NFKC").replace(/\\/g, "/").toLowerCase();
    if (seen.has(normalized)) context.addIssue({ code: "custom", path: ["items", index, "logicalPath"], message: "Logical paths must be unique." });
    seen.add(normalized);
  }
};

const localFolderImportManifestSchema = z.object({
  idempotencyKey: z.string().trim().min(16).max(160),
  items: z.array(localFolderManifestItemSchema).min(1).max(1_000),
}).strict();

export const startLocalFolderImportSchema = localFolderImportManifestSchema.extend({
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(2_000).optional(),
}).superRefine(manifestRefinement);

/** A workspace append uses the Dataset selected by the route, never browser input. */
export const appendLocalFolderImportSchema = localFolderImportManifestSchema.superRefine(manifestRefinement);

export const uploadCapabilitiesSchema = z.object({
  itemIds: z.array(z.string().min(1)).min(1).max(100),
}).strict();

export const completeLocalFolderItemSchema = z.object({
  fileId: z.string().trim().min(32).max(8_192),
}).strict();
