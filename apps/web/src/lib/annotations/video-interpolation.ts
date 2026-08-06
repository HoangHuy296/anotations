import type { DerivedVideoInterpolation, VideoBoundingBox } from "@/types/video-annotation";

type Keyframe = { trackId: string; timestampMs: number; geometry: VideoBoundingBox };

export function interpolateBoundingBox(a: VideoBoundingBox, b: VideoBoundingBox, ratio: number): VideoBoundingBox {
  const r = Math.min(1, Math.max(0, ratio));
  return {
    kind: "BOUNDING_BOX",
    x: a.x + r * (b.x - a.x),
    y: a.y + r * (b.y - a.y),
    width: a.width + r * (b.width - a.width),
    height: a.height + r * (b.height - a.height),
  };
}

export function deriveInterpolationAt(keyframes: Keyframe[], timestampMs: number, mode: "LINEAR" | "NONE" = "LINEAR"): DerivedVideoInterpolation | null {
  if (mode === "NONE" || !Number.isFinite(timestampMs)) return null;
  const ordered = [...keyframes].sort((a, b) => a.timestampMs - b.timestampMs);
  const left = ordered.filter((item) => item.timestampMs <= timestampMs).at(-1);
  const right = ordered.find((item) => item.timestampMs >= timestampMs);
  if (!left || !right || left.timestampMs === right.timestampMs || timestampMs <= left.timestampMs || timestampMs >= right.timestampMs) return null;
  return { ...interpolateBoundingBox(left.geometry, right.geometry, (timestampMs - left.timestampMs) / (right.timestampMs - left.timestampMs)), timestampMs, trackId: left.trackId, derived: true };
}
