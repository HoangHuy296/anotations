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
