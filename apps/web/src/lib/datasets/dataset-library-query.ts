import { z } from "zod";

import { datasetIdSchema, datasetWorkflowStatuses } from "@/lib/validation/dataset";
import type { DatasetLibraryQuery } from "@/types/dataset-library";

export const datasetLibraryQuerySchema = z.object({
  status: z.enum(["ALL", ...datasetWorkflowStatuses]).catch("ALL"),
  method: z.enum(["ALL", "UPLOAD", "IMPORT"]).catch("ALL"),
  after: datasetIdSchema.optional().catch(undefined),
  before: datasetIdSchema.optional().catch(undefined),
});

export const datasetStatusLabels = {
  IN_PROGRESS: "In progress",
  COMPLETED: "Completed",
  REVIEWED: "Reviewed",
} as const;

export function readDatasetWorkflowStatus(metadata: unknown): keyof typeof datasetStatusLabels {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).workflowStatus;
    if (value === "COMPLETED" || value === "REVIEWED") return value;
  }
  return "IN_PROGRESS";
}

export function datasetLibraryHref(
  query: DatasetLibraryQuery,
  page: Pick<DatasetLibraryQuery, "after" | "before"> = {},
) {
  const params = new URLSearchParams();
  if (query.status !== "ALL") params.set("status", query.status);
  if (query.method !== "ALL") params.set("method", query.method);
  if (page.before) params.set("before", page.before);
  else if (page.after) params.set("after", page.after);
  return `/datasets${params.size ? `?${params}` : ""}`;
}
