import { z } from "zod";
import type { AiProviderPrediction } from "@annotationplatform/domain/ai-provider";
import { AiozResultError, type AiozImageAssociation } from "./aioz-annotation-services-normalization.js";

const int = z.number().int().nonnegative().max(2_147_483_647);
const box = z.object({ kind: z.literal("BOUNDING_BOX"), x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine((b) => b.x + b.width <= 1 && b.y + b.height <= 1);
export const normalizedVideoPredictionSchema = z.object({
  assetId: z.string().min(1), labelKey: z.string().min(1).max(256), confidence: z.number().min(0).max(1), boundingBoxes: box,
  video: z.object({ trackId: int, frameIndex: int, timestampMs: int, classId: int, fps: z.number().positive().max(1000), totalFrames: int.positive() }),
});
const observation = z.object({
  track_id: int, class_id: int, class_name: z.string().trim().min(1).max(256), score: z.number().min(0).max(1),
  bbox_xyxy: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]),
});
const outputSchema = z.array(z.object({
  video_path: z.string().url(), status: z.literal("success"), error_message: z.null(),
  width: int.positive(), height: int.positive(), fps: z.number().positive().max(1000), total_frames: int.positive(),
  frames: z.array(z.object({ frame_id: int, tracks: z.array(observation) })), class_names: z.array(z.string()),
}));

/** Preserve observed frames only. Never infer labels from class_names or fill detection gaps. */
export function normalizeAiozVideoOutput(raw: unknown, videos: readonly AiozImageAssociation[]): AiProviderPrediction[] {
  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) throw new AiozResultError("AIOZ_INVALID_OUTPUT");
  const byUrl = new Map(videos.map((v) => [v.imageUrl, v.assetId]));
  if (!videos.length || byUrl.size !== videos.length || new Set(videos.map((v) => v.assetId)).size !== videos.length || parsed.data.length !== videos.length) throw new AiozResultError("AIOZ_ASSET_ASSOCIATION_INVALID");
  const seenVideos = new Set<string>();
  const predictions: AiProviderPrediction[] = [];
  for (const video of parsed.data) {
    const assetId = byUrl.get(video.video_path);
    if (!assetId || seenVideos.has(assetId)) throw new AiozResultError("AIOZ_ASSET_ASSOCIATION_INVALID");
    seenVideos.add(assetId);
    // This endpoint supplies every frame, including empty frames. A missing
    // frame is a truncated result, not evidence that no object was detected.
    if (video.frames.length !== video.total_frames) throw new AiozResultError("AIOZ_INVALID_OUTPUT");
    const seenFrames = new Set<number>();
    const classes = new Map<number, number>();
    for (const frame of [...video.frames].sort((a, b) => a.frame_id - b.frame_id)) {
      if (frame.frame_id >= video.total_frames || seenFrames.has(frame.frame_id)) throw new AiozResultError("AIOZ_INVALID_OUTPUT");
      seenFrames.add(frame.frame_id);
      const seenTracks = new Set<number>();
      for (const item of frame.tracks) {
        if (seenTracks.has(item.track_id) || (classes.has(item.track_id) && classes.get(item.track_id) !== item.class_id)) throw new AiozResultError("AIOZ_INVALID_OUTPUT");
        seenTracks.add(item.track_id);
        classes.set(item.track_id, item.class_id);
        const [xmin, ymin, xmax, ymax] = item.bbox_xyxy;
        if (xmin < 0 || ymin < 0 || xmax > video.width || ymax > video.height || xmin >= xmax || ymin >= ymax) throw new AiozResultError("AIOZ_INVALID_BOUNDING_BOX");
        // Pixel bounds were validated above; cap only floating-point roundoff
        // at the normalized edge (e.g. frame 330 in the supplied output).
        const prediction = normalizedVideoPredictionSchema.safeParse({
          assetId, labelKey: item.class_name, confidence: item.score,
          boundingBoxes: { kind: "BOUNDING_BOX", x: xmin / video.width, y: ymin / video.height, width: Math.min((xmax - xmin) / video.width, 1 - xmin / video.width), height: Math.min((ymax - ymin) / video.height, 1 - ymin / video.height) },
          video: { trackId: item.track_id, frameIndex: frame.frame_id, timestampMs: Math.round(frame.frame_id * 1000 / video.fps), classId: item.class_id, fps: video.fps, totalFrames: video.total_frames },
        });
        if (!prediction.success) throw new AiozResultError("AIOZ_INVALID_OUTPUT");
        predictions.push(prediction.data);
      }
    }
  }
  return predictions;
}
