import { z } from "zod";

import type { AiProviderPrediction } from "@annotationplatform/domain/ai-provider";

/** Safe diagnostic only: never includes provider responses, image URLs, or credentials. */
export class AiozResultError extends Error {
  constructor(readonly code: "AIOZ_INVALID_OUTPUT" | "AIOZ_ASSET_ASSOCIATION_INVALID" | "AIOZ_INVALID_BOUNDING_BOX") {
    super(code);
    this.name = "AiozResultError";
  }
}

const prediction = z.object({
  box: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
  score: z.number().finite().min(0).max(1),
  class_id: z.number().int().nonnegative(),
  class_name: z.string().trim().min(1),
});

const outputs = z.array(z.object({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  outputs: z.array(prediction),
  image_path: z.string().url(),
  class_names: z.array(z.string()),
}));

/**
 * Worker-local input association. URLs are transient capabilities, never part
 * of normalized output, Job payloads, or public diagnostics. The caller must
 * reconstruct these associations from the exact submitted files across polls.
 */
export type AiozImageAssociation = { assetId: string; imageUrl: string };

/**
 * Normalizes the confirmed data.output array. image_path is an exact echo of
 * its submitted URL; output ordering has no meaning. Reject the entire result
 * before persistence if any image/box is invalid or any expected image is absent.
 */
export function normalizeAiozOutput(raw: unknown, images: readonly AiozImageAssociation[]): AiProviderPrediction[] {
  const parsed = outputs.safeParse(raw);
  if (!parsed.success) throw new AiozResultError("AIOZ_INVALID_OUTPUT");

  const byUrl = new Map<string, string>();
  const assetIds = new Set<string>();
  for (const image of images) {
    if (!image.assetId || byUrl.has(image.imageUrl) || assetIds.has(image.assetId)) {
      throw new AiozResultError("AIOZ_ASSET_ASSOCIATION_INVALID");
    }
    byUrl.set(image.imageUrl, image.assetId);
    assetIds.add(image.assetId);
  }
  if (!images.length || parsed.data.length !== images.length) throw new AiozResultError("AIOZ_ASSET_ASSOCIATION_INVALID");

  const seen = new Set<string>();
  return parsed.data.flatMap((image) => {
    const assetId = byUrl.get(image.image_path);
    if (!assetId || seen.has(image.image_path)) throw new AiozResultError("AIOZ_ASSET_ASSOCIATION_INVALID");
    seen.add(image.image_path);
    return image.outputs.map((item): AiProviderPrediction => {
      const [xmin, ymin, xmax, ymax] = item.box;
      // Zero-area boxes are invalid in the existing Annotation geometry schema.
      // Coordinates refer to original image pixels; never clamp or use centres.
      if (xmin < 0 || ymin < 0 || xmax > image.width || ymax > image.height || xmin >= xmax || ymin >= ymax) {
        throw new AiozResultError("AIOZ_INVALID_BOUNDING_BOX");
      }
      const geometry = {
        x: xmin / image.width,
        y: ymin / image.height,
        width: (xmax - xmin) / image.width,
        height: (ymax - ymin) / image.height,
      };
      if (!Object.values(geometry).every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0 || geometry.x + geometry.width > 1 || geometry.y + geometry.height > 1) {
        throw new AiozResultError("AIOZ_INVALID_BOUNDING_BOX");
      }
      // Annotation.type carries BOUNDING_BOX; the strict geometry schema has no kind field.
      return { assetId, labelKey: item.class_name, confidence: item.score, boundingBoxes: geometry };
    });
  });
}
