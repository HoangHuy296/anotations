export const VIDEO_ANNOTATION_LIMITS = {
  // Windowed-read policy -- the *paging* mechanism for `readVideoAnnotations`.
  // A caller that omits fromMs/toMs gets [0, defaultWindowMs]; any requested
  // window wider than maxWindowMs is rejected rather than silently clamped,
  // so a caller always knows the effective window it actually got.
  defaultWindowMs: 30_000,
  maxWindowMs: 120_000,
  // A read-side companion to the client's own preload margin (see
  // `video-window-ranges.ts`) -- how far outside the requested window a
  // client should still consider "close enough" before firing another
  // fetch. Shared here so client and server reason about the same number.
  clientPreloadMarginMs: 8_000,
  // Client-side window cache safety net (see `video-engine.tsx`'s
  // `evictFarWindows`) -- once the store holds more loaded keyframes than
  // this, the loaded window farthest from the current playhead is evicted
  // and refetched on demand if revisited. Deliberately generous: this is a
  // rare-case guard against unbounded accumulation on a heavily-reused
  // asset, not a routine memory optimization for ordinary browsing.
  clientCacheKeyframeCeiling: 20_000,
  // Per-*page* bound for in-window keyframes -- NOT a ceiling on how much of
  // a window's true data can ever be retrieved. A window with more than this
  // many keyframes is fully reachable via `nextCursor`; this only bounds the
  // size of one HTTP response. See `readVideoAnnotations`'s cursor
  // pagination -- this replaced an earlier flat `take` that silently
  // dropped anything beyond it with no continuation mechanism.
  keyframesPerPage: 2_000,
  // Defensive safety ceilings only -- these guard against one window's own
  // result set still being unreasonable (e.g. hundreds of distinct objects
  // on screen at once, or a pathological number of scene/event labels); they
  // are never the mechanism that decides which rows are relevant to a
  // request. Unlike `keyframesPerPage`, there is deliberately no
  // continuation mechanism for these two -- see the read service's
  // `truncated` semantics for what happens if either is actually exceeded.
  tracksPerWindowSafetyCap: 500,
  temporalLabelsPerWindowSafetyCap: 500,
  maxTracksPerAsset: 1_000,
  maxKeyframesPerTrack: 10_000,
  maxTemporalLabelsPerAsset: 10_000,
  maxPropertiesBytes: 16_384,
  maxPropertyDepth: 5,
} as const;
