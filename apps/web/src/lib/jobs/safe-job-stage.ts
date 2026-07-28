import "server-only";

import type { JobStage } from "@internal/db";

/** Stable browser vocabulary; internal worker implementation stages stay private. */
export const safeJobStages = ["WAITING", "VALIDATING_INPUT", "SCANNING", "FILTERING", "UPLOADING_OBJECTS", "WRITING_ASSETS", "FINALIZING", "FINISHED"] as const;
export type SafeJobStage = (typeof safeJobStages)[number];

export function toSafeJobStage(stage: JobStage | null): SafeJobStage | null {
  if (!stage) return null;
  if (stage === "WAITING") return "WAITING";
  if (stage === "VALIDATING_INPUT") return "VALIDATING_INPUT";
  if (["SCANNING_FILES", "PARSING_IMPORT_FILE", "VALIDATING_IMPORT_ROWS"].includes(stage)) return "SCANNING";
  if (["FILTERING_FILES", "MAPPING_LABELS"].includes(stage)) return "FILTERING";
  if (stage === "UPLOADING_OBJECTS") return "UPLOADING_OBJECTS";
  if (["WRITING_ASSETS", "WRITING_ANNOTATIONS", "WRITING_METADATA"].includes(stage)) return "WRITING_ASSETS";
  if (stage === "FINISHED") return "FINISHED";
  return "FINALIZING";
}
