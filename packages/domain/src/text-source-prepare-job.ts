import { z } from "zod";

/**
 * The exact safe Job.input contract for TEXT_SOURCE_PREPARE (data-model.md
 * "Source document"). Shared by the web scheduler (creates the Job) and the
 * private worker (reads it) so neither side can silently diverge on the
 * staleness-recheck identity. Never full text or credentials.
 */
export const TEXT_SOURCE_PREPARE_PROCESSOR_VERSION = "annotationplatform.text-source-prepare.v1" as const;

export const textSourcePrepareModeSchema = z.enum(["OBJECT_SOURCE"]);
export type TextSourcePrepareMode = z.infer<typeof textSourcePrepareModeSchema>;

/** Snapshot of the Asset's storage identity at enqueue time; rechecked at commit. */
export const textSourcePrepareExpectedSourceSchema = z.object({
  storageBucket: z.string().min(1).max(255),
  storageKey: z.string().min(1).max(1024),
  checksum: z.string().min(1).max(512).nullable(),
  sizeBytes: z.string().regex(/^\d+$/).max(32).nullable(),
}).strict();
export type TextSourcePrepareExpectedSource = z.infer<typeof textSourcePrepareExpectedSourceSchema>;

export const textSourcePrepareJobInputSchema = z.object({
  actorId: z.string().min(1).max(128),
  datasetId: z.string().min(1).max(128),
  assetId: z.string().min(1).max(128),
  mode: textSourcePrepareModeSchema,
  expectedSource: textSourcePrepareExpectedSourceSchema,
}).strict();
export type TextSourcePrepareJobInput = z.infer<typeof textSourcePrepareJobInputSchema>;

export const safeTextSourcePrepareErrorCodeSchema = z.enum([
  "TEXT_SOURCE_MISSING",
  "TEXT_SOURCE_STALE",
  "TEXT_SOURCE_OVERSIZED_BYTES",
  "TEXT_SOURCE_OVERSIZED_CODE_UNITS",
  "TEXT_SOURCE_INVALID_ENCODING",
]);
export type SafeTextSourcePrepareErrorCode = z.infer<typeof safeTextSourcePrepareErrorCodeSchema>;
