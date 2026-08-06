import { MEDIA_PROCESSOR_VERSION } from "@fieldframe/domain/media-processing";
import { z } from "zod";

export { MEDIA_PROCESSOR_VERSION } from "@fieldframe/domain/media-processing";

export const mediaProcessingPolicySchema = z.object({
  maxSourceBytes: z.bigint().positive(),
  maxDurationMs: z.number().int().positive(),
  maxProcessOutputBytes: z.number().int().positive(),
  maxTemporaryBytes: z.bigint().positive(),
  maxWaveformPeaks: z.number().int().positive(),
  maxProcessMs: z.number().int().positive(),
}).strict();

export type MediaProcessingPolicy = z.infer<typeof mediaProcessingPolicySchema>;

/** Conservative finite defaults; deployment configuration can only lower them. */
export const defaultMediaProcessingPolicy: MediaProcessingPolicy = {
  maxSourceBytes: BigInt(2) * BigInt(1024) * BigInt(1024) * BigInt(1024),
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxProcessOutputBytes: 64 * 1024,
  maxTemporaryBytes: BigInt(3) * BigInt(1024) * BigInt(1024) * BigInt(1024),
  maxWaveformPeaks: 2_000_000,
  maxProcessMs: 10 * 60 * 1000,
};

export function assertMediaSourceWithinPolicy(input: {
  sizeBytes: bigint | null;
  durationMs?: number | null;
}, policy: MediaProcessingPolicy = defaultMediaProcessingPolicy) {
  if (input.sizeBytes === null || input.sizeBytes > policy.maxSourceBytes) {
    return { ok: false as const, code: "MEDIA_POLICY_REJECTED" as const };
  }
  if (input.durationMs !== null && input.durationMs !== undefined && input.durationMs > policy.maxDurationMs) {
    return { ok: false as const, code: "MEDIA_POLICY_REJECTED" as const };
  }
  return { ok: true as const };
}
