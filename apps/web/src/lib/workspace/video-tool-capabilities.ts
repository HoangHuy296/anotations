import type { VideoAnnotationTool } from "@/types/annotation";

/**
 * The VIDEO persistence contract (`videoTrackCreateSchema.annotationType`, `SafeVideoKeyframe.type`) accepts BOUNDING_BOX only. A drawing tool for any other shape
 * would look usable but could never persist, so it is gated with an accurate reason until a later phase widens that contract. This is a gate by the
 * current contract, not a statement that these shapes are unavailable by design.
 */
export const VIDEO_PERSISTED_SHAPE_TOOLS = ["box"] as const satisfies readonly VideoAnnotationTool[];
export const VIDEO_GATED_SHAPE_TOOLS = ["polygon", "circle", "point", "polyline"] as const satisfies readonly VideoAnnotationTool[];
export const VIDEO_SHAPE_GATE_REASON = "Not available yet: the VIDEO annotation contract currently persists bounding boxes only.";

export function videoShapeToolGate(tool: VideoAnnotationTool): { disabled: boolean; reason: string | undefined } {
  const gated = (VIDEO_GATED_SHAPE_TOOLS as readonly VideoAnnotationTool[]).includes(tool);
  return { disabled: gated, reason: gated ? VIDEO_SHAPE_GATE_REASON : undefined };
}
