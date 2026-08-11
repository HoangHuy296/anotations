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

// ---------------------------------------------------------------------------
// Tool vocabulary -- what each `*-toolbox.tsx` can select and what each
// engine interprets that selection to mean. Consolidated here, one block per
// `WorkspaceEngineRegistryEntry` (`workspace-engine-registry.tsx`), so a new
// or renamed tool touches exactly this file. Each engine's *processing and
// implementation* types -- safe DTOs, geometry, read models mirroring their
// Prisma tables -- stay out of this file, in that engine's own workspace
// module (`types/image-workspace.ts`, `types/video-annotation.ts`,
// `types/audio-annotation.ts`, `types/text-annotation.ts`); only the tool
// names live centrally, because they're the one vocabulary every toolbox and
// the registry itself need to agree on across engines.
// ---------------------------------------------------------------------------

/** IMAGE tool set, read/written through `useAnnotationStore` and rendered by `image-toolbox.tsx`. */
export type ImageAnnotationTool = "select" | "box" | "pan" | "polygon" | "circle" | "point" | "polyline" | "mask" | "aidetect";

/**
 * VIDEO tool set, read/written through `useVideoAnnotationStore` and
 * rendered by `video-toolbox.tsx`. "select" edits an existing keyframe on
 * the current track (drag to move or resize). "box" draws a brand-new
 * `BOUNDING_BOX` keyframe directly on the frame at the current playhead.
 * "pan" reserves frame panning for a future zoomable frame surface. "track"
 * shortcuts to the create-track action already surfaced by `VideoToolbar`
 * (an `OBJECT_TRACK`-shaped `VideoObjectTrack` row).
 *
 * `AnnotationType` (`prisma/schema.prisma`) already reserves
 * `ROTATED_BOUNDING_BOX`, `POLYGON`, `CIRCLE`, `POINT`, `POLYLINE`, and
 * `SEGMENTATION_MASK` for VIDEO keyframes, so those tools stay declared here
 * for toolbox parity with IMAGE, but `SafeVideoKeyframe.type`
 * (`types/video-annotation.ts`) narrows to `"BOUNDING_BOX"` only -- per the
 * canvas rules in AGENTS.md, do not wire drawing behavior for the other
 * shapes until a later phase widens that union.
 */
export type VideoAnnotationTool = "select" | "box" | "pan" | "track" | "polygon" | "circle" | "point" | "polyline" | "mask"| "aidetect";

/**
 * AUDIO tool set, rendered by `audio-toolbox.tsx`. `AudioEngine`
 * (`types/audio-annotation.ts`) is a read-only Phase 018 surface (AGENTS.md
 * phase discipline: audio editing is a future phase), so nothing consumes
 * these yet beyond the toolbox highlighting the active button.
 */
export type AudioAnnotationTool = "select" | "pan" | "timesegmentaudio" | "timestampaudio" | "speakerlabel"| "aidetect";

/**
 * TEXT tool set, rendered by `text-toolbox.tsx`. `TextEngine`
 * (`types/text-annotation.ts`) is a read-only Phase 018 surface (AGENTS.md
 * phase discipline: text editing is a future phase), so nothing consumes
 * these yet beyond the toolbox highlighting the active button.
 */
export type TextAnnotationTool = "select" | "box" | "pan" | "highlightspan" | "relationtext" | "notetext" | "classificationtext";

/**
 * Union of every engine's tool set. `WorkspaceEngineRegistryEntry` keys each
 * `Toolbox`/`Component` pair by `Modality`, so this stays the one place that
 * changes when a whole new engine joins `workspaceEngineRegistry`.
 */
export type AnnotationTool = ImageAnnotationTool | VideoAnnotationTool | AudioAnnotationTool | TextAnnotationTool;
