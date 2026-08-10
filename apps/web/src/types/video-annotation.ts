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

/** Full read model `VideoEngine` renders: persisted tracks/keyframes/labels plus their derived-only interpolation frames. */
export type SafeVideoAnnotations = {
  assetId: string;
  durationMs: number | null;
  fps: number | null;
  tracks: SafeVideoTrack[];
  keyframes: SafeVideoKeyframe[];
  temporalLabels: SafeVideoTemporalLabel[];
  interpolation: DerivedVideoInterpolation[];
};
