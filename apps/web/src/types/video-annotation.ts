import type { AnnotationStatus, AnnotationType } from "@internal/db";

/**
 * VIDEO annotation workflow types, mirroring the Prisma shape behind them
 * (`prisma/schema.prisma`: `VideoObjectTrack` + polymorphic `Annotation`
 * rows keyed by `trackId`/`isKeyframe`/`timestampMs`, plus untracked
 * `Annotation` rows typed `EVENT`/`SCENE`/`SHOT_BOUNDARY` for temporal
 * labels). Unlike IMAGE, a VIDEO annotation is never a bare shape: every
 * geometry belongs to a `SafeVideoTrack` (a `VideoObjectTrack` row) and is
 * anchored to a `SafeVideoKeyframe` timestamp (an `Annotation` row with
 * `isKeyframe: true`); gaps between two persisted keyframes on the same
 * track are filled by a `DerivedVideoInterpolation`, computed in
 * `lib/annotations/video-interpolation.ts` and never itself persisted.
 * VIDEO's tool vocabulary (`VideoAnnotationTool`) lives in
 * `types/annotation.ts`, alongside every other engine's tools -- this file
 * keeps only the DTOs/geometry those tools act on.
 */

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type VideoBoundingBox = {
  kind: "BOUNDING_BOX";
  x: number;
  y: number;
  width: number;
  height: number;
};

// ---------------------------------------------------------------------------
// Safe DTOs -- one per Prisma shape the VIDEO engine reads/writes.
// ---------------------------------------------------------------------------

/** Safe projection of a `VideoObjectTrack` row. */
export type SafeVideoTrack = {
  id: string;
  videoAssetId: string;
  labelId: string | null;
  name: string | null;
  label: { id: string; name: string; color: string } | null;
  annotationType: AnnotationType;
  interpolationMode: "LINEAR" | "NONE";
  status: AnnotationStatus;
  revision: number;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/**
 * Safe projection of an `Annotation` row with `trackId` set and
 * `isKeyframe: true`. `properties` is the same free-form `Annotation.properties`
 * JSON column every other Annotation already carries -- this keyframe stores
 * its user-assigned `objectId`/`name` there (see `video-engine.tsx`'s
 * create-annotation dialog), so identifying a drawn box never required a
 * schema change.
 */
export type SafeVideoKeyframe = {
  id: string;
  trackId: string;
  assetId: string;
  labelId: string | null;
  type: "BOUNDING_BOX";
  geometry: VideoBoundingBox;
  properties: Record<string, unknown>;
  timestampMs: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** Safe projection of an untracked `Annotation` row typed `EVENT`/`SCENE`/`SHOT_BOUNDARY` (`startMs`/`endMs`, no `trackId`). */
export type SafeVideoTemporalLabel = {
  id: string;
  assetId: string;
  labelId: string | null;
  type: "EVENT" | "SCENE" | "SHOT_BOUNDARY";
  startMs: number;
  endMs: number;
  revision: number;
  properties: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

/** Computed between two persisted keyframes on the same track; never an `Annotation` row of its own. */
export type DerivedVideoInterpolation = SafeVideoKeyframe["geometry"] & {
  timestampMs: number;
  trackId: string;
  derived: true;
};

/**
 * One page (or, once a client has followed every `nextCursor`, the fully
 * assembled whole) of the read model `VideoEngine` renders, scoped to one
 * requested `[effectiveFromMs, effectiveToMs]` window (see
 * `video-read-service.ts`).
 *
 * `totalTracksInWindow`/`totalKeyframesInWindow` are the *authoritative*
 * counts for the whole `[effectiveFromMs, effectiveToMs]` interval -- a
 * `count()`/`groupBy` against the database, independent of pagination and
 * excluding boundary-context rows/tracks (a track present only because it
 * straddles the window, with no keyframe actually inside it, is not counted
 * here even though it does appear in `tracks`/`keyframes`). They do not
 * shrink or change as more pages arrive; they describe the requested
 * interval itself, not "what this response happened to carry."
 *
 * `keyframes`/`tracks` on any single page are only that page's slice (plus
 * boundary context, present on every page) -- a client must follow
 * `nextCursor` until `hasMore` is false before treating its merged result as
 * a complete window. `truncated` is `hasMore` OR'd with the rare case where
 * a single page's own track set overflows `tracksPerWindowSafetyCap`; unlike
 * `keyframesPerPage`, there is no continuation for that safety cap.
 */
export type SafeVideoAnnotations = {
  assetId: string;
  durationMs: number | null;
  fps: number | null;
  tracks: SafeVideoTrack[];
  keyframes: SafeVideoKeyframe[];
  temporalLabels: SafeVideoTemporalLabel[];
  interpolation: DerivedVideoInterpolation[];
  totalTracksInWindow: number;
  totalKeyframesInWindow: number;
  truncated: boolean;
  effectiveFromMs: number;
  effectiveToMs: number;
  /** Opaque cursor for the next page of in-window keyframes, or `null` when this is the last page. */
  nextCursor: string | null;
  /** `nextCursor !== null` -- kept as its own field so a consumer never has to infer completion from cursor nullability. */
  hasMore: boolean;
};
