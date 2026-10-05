import "server-only";
import type { RequestActor } from "@/lib/auth";
import { readVisualizationAccess } from "@/lib/visualization/access";

export class VisualizationReadError extends Error {
  constructor(public status: number, public code: "AUTH_REQUIRED" | "DATASET_NOT_FOUND" | "DATASET_NOT_COMPLETED" | "ASSET_NOT_IN_DATASET" | "ASSET_UNAVAILABLE" | "UNSUPPORTED_MEDIA", message: string) { super(message); }
}
export async function readVisualizationDataset(actor: RequestActor | null, datasetId: string) {
  if (!actor) throw new VisualizationReadError(401, "AUTH_REQUIRED", "Authentication is required.");
  const result = await readVisualizationAccess(actor, datasetId);
  if (result.kind === "not-found") throw new VisualizationReadError(404, "DATASET_NOT_FOUND", "Dataset not found.");
  if (result.kind === "redirect") throw new VisualizationReadError(409, "DATASET_NOT_COMPLETED", "This dataset is no longer completed.");
  return result.dataset;
}
