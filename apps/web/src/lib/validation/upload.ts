import { z } from "zod";

import { datasetIdSchema } from "@/lib/validation/dataset";

export const MAX_DIRECT_UPLOAD_BYTES = 100 * 1024 * 1024;

export const candidateContentTypes = [
  "image/png", "image/jpeg", "image/webp",
  "video/mp4", "video/webm",
  "text/plain", "text/csv", "application/json",
  "audio/wav", "audio/mpeg", "audio/ogg",
] as const;

export const presignedUploadSchema = z.object({
  datasetId: datasetIdSchema,
  filename: z.string().trim().min(1).max(255),
  contentType: z.enum(candidateContentTypes),
  sizeBytes: z.number().int().positive().max(MAX_DIRECT_UPLOAD_BYTES),
});

export const completeUploadSchema = z.object({
  fileId: z.string().trim().min(32).max(8_192),
}).strict();
