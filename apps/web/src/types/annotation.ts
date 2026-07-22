export type BoundingBoxCoordinates = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WorkspaceLabel = {
  id: string;
  name: string;
  color: string;
  hotkey: string | null;
};

export type DraftAnnotation = {
  id: string;
  assetId: string;
  version: number;
  labelId: string | null;
  coordinates: BoundingBoxCoordinates;
};

export type AnnotationTool = "select" | "box" | "pan";
