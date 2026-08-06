import type { AnnotationStatus, AnnotationType } from "@internal/db";

export type VideoBoundingBox = {
  kind: "BOUNDING_BOX";
  x: number;
  y: number;
  width: number;
  height: number;
};

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

export type SafeVideoKeyframe = {
  id: string;
  trackId: string;
  assetId: string;
  labelId: string | null;
  type: "BOUNDING_BOX";
  geometry: VideoBoundingBox;
  timestampMs: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

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

export type DerivedVideoInterpolation = SafeVideoKeyframe["geometry"] & {
  timestampMs: number;
  trackId: string;
  derived: true;
};

export type SafeVideoAnnotations = {
  assetId: string;
  durationMs: number | null;
  fps: number | null;
  tracks: SafeVideoTrack[];
  keyframes: SafeVideoKeyframe[];
  temporalLabels: SafeVideoTemporalLabel[];
  interpolation: DerivedVideoInterpolation[];
};
