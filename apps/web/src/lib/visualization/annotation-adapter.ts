import { normalizedBoundingBoxSchema } from "@/lib/validation/image-workspace";
import type { ViewerAnnotation, ViewerLabel } from "@/types/visualization";

export function projectAnnotation(row: { id: string; type: string; revision: number; geometry: unknown; label: ViewerLabel | null }, width: number | null, height: number | null): ViewerAnnotation {
  const parsed = normalizedBoundingBoxSchema.safeParse(row.geometry);
  const reason = row.type !== "BOUNDING_BOX" ? "Unsupported annotation geometry"
    : !width || !height || width <= 0 || height <= 0 ? "Original image dimensions unavailable"
    : !parsed.success ? "Invalid or missing normalized geometry" : null;
  return { id: row.id, type: row.type, revision: row.revision, label: row.label,
    geometry: reason === null && parsed.success ? parsed.data : null, overlayUnavailable: reason };
}
