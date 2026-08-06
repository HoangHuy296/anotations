import "server-only";

import { createHash } from "node:crypto";

import {
  MEDIA_PROCESSOR_VERSION,
  mediaProcessingJobInputSchema,
  mediaProcessingJobTypeSchema,
  mediaSourceIdentitySchema,
  safeMediaErrorCodeSchema,
  type MediaProcessingJobInput,
  type MediaProcessingJobType,
  type MediaSourceIdentity,
  type SafeMediaErrorCode,
} from "@fieldframe/domain/media-processing";
import { z } from "zod";

export {
  MEDIA_PROCESSOR_VERSION,
  mediaProcessingJobInputSchema,
  mediaProcessingJobTypeSchema,
  mediaSourceIdentitySchema,
  safeMediaErrorCodeSchema,
};
export type { MediaProcessingJobInput, MediaProcessingJobType, MediaSourceIdentity, SafeMediaErrorCode };

export const mediaProcessingRequestSchema = z.object({
  assetId: z.string().min(1).max(128),
  type: mediaProcessingJobTypeSchema,
}).strict();


/**
 * Credential-free deterministic identity for a single Asset's current binary.
 * Neither a storage key nor a source URL may participate in this value.
 */
export function createMediaRequestIdentity(input: {
  assetId: string;
  type: MediaProcessingJobType;
  source: MediaSourceIdentity;
  processorVersion?: string;
}) {
  const parsed = mediaSourceIdentitySchema.parse(input.source);
  const canonical = JSON.stringify({
    assetId: input.assetId,
    type: input.type,
    processorVersion: input.processorVersion ?? MEDIA_PROCESSOR_VERSION,
    sourceFingerprint: parsed.sourceFingerprint,
    checksum: parsed.checksum,
    sizeBytes: parsed.sizeBytes,
    sourceRevision: parsed.sourceRevision,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
