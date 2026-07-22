import type { NormalizedBoundingBox } from "@/types/image-workspace";

const MIN_EXTENT = 0.0001;

export function clamp(value: number, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

/** Convert displayed image pixels to the only durable geometry representation. */
export function normalizeBoundingBox(
  box: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number,
): NormalizedBoundingBox | null {
  if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) return null;
  const x = clamp(box.x / imageWidth);
  const y = clamp(box.y / imageHeight);
  const width = clamp(box.width / imageWidth, 0, 1 - x);
  const height = clamp(box.height / imageHeight, 0, 1 - y);
  if (width < MIN_EXTENT || height < MIN_EXTENT) return null;
  return { x, y, width, height };
}

export function denormalizeBoundingBox(
  box: NormalizedBoundingBox,
  imageWidth: number,
  imageHeight: number,
) {
  return { x: box.x * imageWidth, y: box.y * imageHeight, width: box.width * imageWidth, height: box.height * imageHeight };
}

export type ViewportTransform = { x: number; y: number; scale: number };

/** Viewport state is display-only; these helpers never mutate canonical geometry. */
export function viewportPointToImage(
  point: { x: number; y: number },
  viewport: ViewportTransform,
) {
  if (!Number.isFinite(viewport.scale) || viewport.scale <= 0) return null;
  return { x: (point.x - viewport.x) / viewport.scale, y: (point.y - viewport.y) / viewport.scale };
}

export function imagePointToViewport(
  point: { x: number; y: number },
  viewport: ViewportTransform,
) {
  return { x: point.x * viewport.scale + viewport.x, y: point.y * viewport.scale + viewport.y };
}
