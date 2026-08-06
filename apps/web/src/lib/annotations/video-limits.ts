export const VIDEO_ANNOTATION_LIMITS = {
  tracksPerRead: 100,
  keyframesPerTrackRead: 500,
  temporalLabelsPerRead: 500,
  maxTracksPerAsset: 1_000,
  maxKeyframesPerTrack: 10_000,
  maxTemporalLabelsPerAsset: 10_000,
  maxPropertiesBytes: 16_384,
  maxPropertyDepth: 5,
} as const;
