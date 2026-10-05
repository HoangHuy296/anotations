import type { NormalizedBox } from "@/types/visualization";

/** Render coordinates only; persisted geometry remains normalized 0..1. */
export function boxPixels(box: NormalizedBox, originalWidth: number, originalHeight: number): NormalizedBox {
  return { x: box.x * originalWidth, y: box.y * originalHeight, width: box.width * originalWidth, height: box.height * originalHeight };
}
