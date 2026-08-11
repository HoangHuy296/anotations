export function isReliableVideoFps(fps: number | null | undefined) {
  return fps !== null && fps !== undefined && Number.isFinite(fps) && fps > 0;
}

export function deriveFrameIndex(timestampMs: number, fps: number | null | undefined) {
  if (!Number.isFinite(timestampMs) || timestampMs < 0 || !isReliableVideoFps(fps)) return null;
  return Math.max(0, Math.round((timestampMs / 1000) * (fps as number)));
}

export function validateVideoTimestamp(timestampMs: number, durationMs: number | null | undefined) {
  if (!Number.isInteger(timestampMs) || timestampMs < 0) return false;
  return durationMs === null || durationMs === undefined || timestampMs <= durationMs;
}

/**
 * The Video Asset's own frame count is the authoritative source for how far
 * the timeline/scrub bar should extend -- `fps` converts it into the
 * time-domain duration that code already works in. `Asset.durationMs` is
 * read only as a last resort, when `totalFrames`/`fps` aren't both
 * available, and only if it's a genuine positive number: a naive truthy
 * check on `durationMs` would treat a value of `0` (e.g. a partial/failed
 * probe) the same as "unknown" and leave the timeline stuck at its start.
 */
export function resolveVideoTimelineDurationMs(video: { totalFrames?: number | null; fps?: number | null; durationMs?: number | null } | null | undefined): number | null {
  if (video?.totalFrames && video.totalFrames > 0 && isReliableVideoFps(video.fps)) {
    return (video.totalFrames / (video.fps as number)) * 1000;
  }
  return video?.durationMs && video.durationMs > 0 ? video.durationMs : null;
}
