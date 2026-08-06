/**
 * Classifies what the video workspace should visually present for a given
 * timestamp/track selection: an exact persisted keyframe, a purely derived
 * (never durable -- see video-read-service.ts) interpolation preview, an
 * unsaved local edit, a just-completed save, or a preserved conflict draft.
 *
 * Precedence matters and is deliberately total, not first-match-wins by
 * accident:
 * - "conflict" always wins: the store entered VIDEO_TRACK_REVISION_CONFLICT
 *   and is holding a local draft the user must explicitly resolve, regardless
 *   of what the last-known persisted or derived value was.
 * - "draft" wins over "persisted"/"derived": an in-flight local edit that
 *   has not yet round-tripped through autosave must never be silently
 *   overwritten by a stale read.
 * - "saved" only applies once a save has completed and no further local edit
 *   is pending.
 * - "persisted" and "derived" are mutually exclusive by construction (the
 *   read service never returns both for the same exact timestamp), so
 *   whichever is present is reported.
 */
export type VideoKeyframeDisplayState = "persisted" | "derived" | "draft" | "saved" | "conflict" | "none";

export function resolveVideoKeyframeDisplayState(input: {
  hasPersistedKeyframe: boolean;
  hasDerivedInterpolation: boolean;
  hasUnsavedDraft: boolean;
  mutationState: "idle" | "saving" | "saved" | "conflict" | "error";
}): VideoKeyframeDisplayState {
  if (input.mutationState === "conflict") return "conflict";
  if (input.hasUnsavedDraft) return "draft";
  if (input.mutationState === "saved") return "saved";
  if (input.hasPersistedKeyframe) return "persisted";
  if (input.hasDerivedInterpolation) return "derived";
  return "none";
}
