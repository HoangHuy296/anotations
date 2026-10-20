import type { ImageAnnotationGeometry, NormalizedPoint } from "@/types/image-workspace";

function isNormalizedPoint([x, y]: NormalizedPoint) {
  return x >= 0 && x <= 1 && y >= 0 && y <= 1;
}

function hasDistinctPoints(points: readonly NormalizedPoint[]) {
  return new Set(points.map(([x, y]) => `${x}:${y}`)).size === points.length;
}

export function translateImageGeometry(geometry: ImageAnnotationGeometry, dx: number, dy: number): ImageAnnotationGeometry | null {
  if ("points" in geometry) {
    const points = geometry.points.map(([x, y]) => [x + dx, y + dy] as NormalizedPoint);
    return points.every(isNormalizedPoint) ? { points } : null;
  }
  if ("cx" in geometry) {
    const cx = geometry.cx + dx;
    const cy = geometry.cy + dy;
    return cx - geometry.r >= 0 && cx + geometry.r <= 1 && cy - geometry.r >= 0 && cy + geometry.r <= 1 ? { ...geometry, cx, cy } : null;
  }
  if ("px" in geometry) {
    const px = geometry.px + dx;
    const py = geometry.py + dy;
    return isNormalizedPoint([px, py]) ? { px, py } : null;
  }
  return null;
}

export function replacePathVertex(geometry: { points: NormalizedPoint[] }, index: number, point: NormalizedPoint) {
  if (!Number.isInteger(index) || index < 0 || index >= geometry.points.length || !isNormalizedPoint(point)) return null;
  const points = geometry.points.map((current, currentIndex) => currentIndex === index ? point : current);
  return hasDistinctPoints(points) ? { points } : null;
}

export function resizeNormalizedCircle(geometry: { cx: number; cy: number; r: number }, edge: NormalizedPoint) {
  const r = Math.hypot(edge[0] - geometry.cx, edge[1] - geometry.cy);
  if (!Number.isFinite(r) || r <= 0 || geometry.cx - r < 0 || geometry.cx + r > 1 || geometry.cy - r < 0 || geometry.cy + r > 1) return null;
  return { ...geometry, r };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Moves a circle to a new normalized center, clamped so the whole circle stays inside the image (a drag past the edge stops at the edge). */
export function moveNormalizedCircle(geometry: { cx: number; cy: number; r: number }, cx: number, cy: number) {
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || geometry.r * 2 > 1) return null;
  return { ...geometry, cx: clamp(cx, geometry.r, 1 - geometry.r), cy: clamp(cy, geometry.r, 1 - geometry.r) };
}

/** Moves a point to a new normalized position, clamped to the image. */
export function moveNormalizedPoint(px: number, py: number) {
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  return { px: clamp(px, 0, 1), py: clamp(py, 0, 1) };
}

/** Shrinks a circle drawn past an image edge so it fits, instead of dropping it. Returns null for a zero-size circle. */
export function fitNormalizedCircle(cx: number, cy: number, r: number) {
  if (![cx, cy, r].every(Number.isFinite) || cx < 0 || cx > 1 || cy < 0 || cy > 1) return null;
  const fitted = Math.min(r, cx, 1 - cx, cy, 1 - cy);
  return fitted > 0 ? { cx, cy, r: fitted } : null;
}
