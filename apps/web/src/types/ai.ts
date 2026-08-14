import type { Modality } from "@internal/db";

/**
 * Browser-facing DTO shapes. These mirror the wire contract documented in
 * `specs/020-ai-integration/contracts/ai-api.md` byte-for-byte (dates as
 * ISO strings, `modality: null` meaning "supports more than one modality")
 * -- they are deliberately not imported from the server-side
 * `ai-model-service.ts`/`ai-task-read-service.ts` (both `import
 * "server-only"` and are unreachable from client bundles); this file is the
 * one place a client component agrees on those shapes, same role
 * `lib/annotations/safe-annotation.ts`'s `SafeAnnotation` plays for
 * annotations.
 */

export type AiModelDto = {
  id: string;
  key: string;
  displayName: string;
  modality: Modality | null;
  taskType: string;
};

/** `AiTaskStatus` (`prisma/schema.prisma`), as it crosses the wire. */
export type AiTaskStatusValue = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED";

export type AiTaskStatusDto = {
  taskId: string;
  jobId: string;
  datasetId: string;
  status: AiTaskStatusValue;
  type: string;
  modality: Modality | null;
  modelNameSnapshot: string;
  modelVersionSnapshot: string | null;
  pollAttempts: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  errorCode: string | null;
};
