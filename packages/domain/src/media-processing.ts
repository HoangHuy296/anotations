import { z } from "zod";

/**
 * Versioned identity for a media processor result. This belongs in the shared
 * domain package so the web scheduler and private worker cannot silently use
 * different idempotency identities for the same Asset revision.
 */
export const MEDIA_PROCESSOR_VERSION = "fieldframe.media.v1" as const;

export const mediaProcessingJobTypeSchema = z.enum([
  "EXTRACT_VIDEO_METADATA",
  "GENERATE_AUDIO_WAVEFORM",
]);
export type MediaProcessingJobType = z.infer<typeof mediaProcessingJobTypeSchema>;

export const mediaSourceIdentitySchema = z.object({
  sourceFingerprint: z.string().min(1).max(512),
  checksum: z.string().min(1).max(512).nullable(),
  // Job.input is JSON. Keep the PostgreSQL BigInt as a canonical DB type and
  // persist its safe decimal representation only in the Job identity.
  sizeBytes: z.string().regex(/^\d+$/).max(32).nullable(),
  sourceRevision: z.string().min(1).max(512).nullable(),
}).strict();
export type MediaSourceIdentity = z.infer<typeof mediaSourceIdentitySchema>;

/** The exact safe Job.input contract for one-Asset media processing. */
export const mediaProcessingJobInputSchema = z.object({
  assetId: z.string().min(1).max(128),
  processorVersion: z.string().min(1).max(128),
  source: mediaSourceIdentitySchema,
}).strict();
export type MediaProcessingJobInput = z.infer<typeof mediaProcessingJobInputSchema>;

export const safeMediaErrorCodeSchema = z.enum([
  "MEDIA_ASSET_INELIGIBLE",
  "MEDIA_SOURCE_STALE",
  "MEDIA_SOURCE_MISSING",
  "MEDIA_POLICY_REJECTED",
  "MEDIA_PROBE_FAILED",
  "MEDIA_WAVEFORM_FAILED",
  "MEDIA_PROCESSING_CANCELED",
]);
export type SafeMediaErrorCode = z.infer<typeof safeMediaErrorCodeSchema>;
