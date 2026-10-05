/**
 * specs/028-multi-format-export §5 -- the ONE shared, data-driven contract
 * for export format compatibility. API validation, worker dispatch, and the
 * `/exports`/Export-Selected UI all derive their behavior from this module.
 * The explicit goal (stated by the user before implementation began): no
 * `if (format === "yolo")` / `if (format === "mot")` branches scattered
 * across API/UI/worker code to decide compatibility -- every such decision
 * reads this table instead.
 *
 * A format's PREREQUISITES (e.g. MOT needing a canonical per-video FPS) are
 * represented as DATA here too (`prerequisites`), not as a hard-coded
 * special case anywhere else. A serializer consults its own format's
 * `prerequisites` entries to decide its skip-reason accounting; nothing
 * outside this file needs to know what a prerequisite means to route
 * around it.
 */

export type ExportModality = "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";

export type ExportFormat = "JSON" | "COCO" | "YOLO" | "VOC" | "LABELME" | "CVAT" | "OPENIMAGES" | "MOT";

/**
 * How much of the canonical geometry model a format's wire shape can
 * represent. Phase 028's new interoperable formats are all "BOUNDING_BOX"
 * -- an eligible-otherwise annotation with any other geometry type is
 * skipped and counted (spec 027 §2's `unsupported_geometry_type`), never
 * silently dropped. "ALL" (JSON only) means the lossless native manifest,
 * which is not geometry-scoped at all.
 */
export type GeometryScope = "BOUNDING_BOX" | "ALL";

/**
 * A named, data-described requirement a format has beyond plain modality
 * compatibility. Serializers read their own format's entries to decide
 * per-row eligibility/skip-accounting; this is how MOT's FPS requirement
 * is represented architecturally without hard-coding "if format is MOT,
 * check fps" anywhere outside the serializer itself.
 */
export type FormatPrerequisite = {
  /** Stable, serializer-readable identifier for this requirement. */
  kind: "CANONICAL_VIDEO_FPS";
  /** The exact persisted field this prerequisite depends on. */
  field: "VideoAsset.fps";
  /** The named skip reason a row failing this prerequisite is counted
   *  under -- never silently dropped, never a fabricated default. */
  skipReasonWhenMissing: "missing_fps";
};

export type FormatCapability = {
  format: ExportFormat;
  /** Modalities this format can ever represent. */
  modalities: ExportModality[];
  geometryScope: GeometryScope;
  /** Whether a real serializer exists yet. Flips to true as each format
   *  ships; nothing else needs to change for it to become selectable. */
  implemented: boolean;
  /** Whether a captured real AIOZ `/format` sample was used to cross-check
   *  this serializer's output (027 §0/§11c). False by default for every
   *  format except COCO until a real sample is checked -- never assumed
   *  true from the format name alone. */
  aiozVerified: boolean;
  /** Format-specific requirements beyond modality/geometry, as data. */
  prerequisites: FormatPrerequisite[];
  /** Set only for a format that is compatibility-defined but not yet
   *  buildable, with the exact, auditable reason (spec 028 §3). */
  deferralReason?: string;
};

export const EXPORT_FORMAT_CAPABILITY: Record<ExportFormat, FormatCapability> = {
  JSON: {
    format: "JSON", modalities: ["IMAGE", "VIDEO", "AUDIO", "TEXT"], geometryScope: "ALL",
    implemented: true, aiozVerified: false, prerequisites: [],
  },
  COCO: {
    format: "COCO", modalities: ["IMAGE"], geometryScope: "BOUNDING_BOX",
    implemented: true, aiozVerified: true, prerequisites: [],
  },
  YOLO: {
    format: "YOLO", modalities: ["IMAGE"], geometryScope: "BOUNDING_BOX",
    implemented: true, aiozVerified: false, prerequisites: [],
  },
  VOC: {
    format: "VOC", modalities: ["IMAGE"], geometryScope: "BOUNDING_BOX",
    implemented: false, aiozVerified: false, prerequisites: [],
  },
  LABELME: {
    format: "LABELME", modalities: ["IMAGE"], geometryScope: "BOUNDING_BOX",
    implemented: false, aiozVerified: false, prerequisites: [],
  },
  CVAT: {
    format: "CVAT", modalities: ["IMAGE"], geometryScope: "BOUNDING_BOX",
    implemented: false, aiozVerified: false, prerequisites: [],
  },
  OPENIMAGES: {
    format: "OPENIMAGES", modalities: ["IMAGE"], geometryScope: "BOUNDING_BOX",
    implemented: false, aiozVerified: false, prerequisites: [],
  },
  MOT: {
    format: "MOT", modalities: ["VIDEO"], geometryScope: "BOUNDING_BOX",
    implemented: false, aiozVerified: false,
    prerequisites: [{ kind: "CANONICAL_VIDEO_FPS", field: "VideoAsset.fps", skipReasonWhenMissing: "missing_fps" }],
    deferralReason: "canonical VideoAsset.fps exists (populated by the real metadata-extraction pipeline) but is only present for a minority of videos today -- not implemented until its per-video eligibility/skip-accounting design is reviewed on its own (spec 028 §3).",
  },
};

/** Every consumer (API validation, worker dispatch, UI) calls this instead
 *  of writing its own per-format compatibility logic. */
export function isFormatSelectable(format: ExportFormat): boolean {
  const capability = EXPORT_FORMAT_CAPABILITY[format];
  return capability.implemented && !capability.deferralReason;
}

export type ModalityCompatibilityResult =
  | { ok: true }
  | { ok: false; reason: "NOT_IMPLEMENTED" | "UNSUPPORTED_MODALITY"; unsupportedModality?: ExportModality };

/**
 * The single authoritative compatibility check. A mixed-modality target
 * (a Dataset or an Export-Selected set spanning more than one modality)
 * with a format that doesn't cover every modality actually present is
 * rejected outright -- never a partial export that silently excludes some
 * assets (spec 028 §5).
 */
export function checkFormatCompatibility(format: ExportFormat, presentModalities: readonly ExportModality[]): ModalityCompatibilityResult {
  if (!isFormatSelectable(format)) return { ok: false, reason: "NOT_IMPLEMENTED" };
  const capability = EXPORT_FORMAT_CAPABILITY[format];
  const unsupported = presentModalities.find((modality) => !capability.modalities.includes(modality));
  if (unsupported) return { ok: false, reason: "UNSUPPORTED_MODALITY", unsupportedModality: unsupported };
  return { ok: true };
}

/** For UI consumption: every currently-selectable format, grouped by the
 *  modality it applies to -- the UI never hard-codes its own format list. */
export function selectableFormatsByModality(): Record<ExportModality, ExportFormat[]> {
  const result: Record<ExportModality, ExportFormat[]> = { IMAGE: [], VIDEO: [], AUDIO: [], TEXT: [] };
  for (const capability of Object.values(EXPORT_FORMAT_CAPABILITY)) {
    if (!isFormatSelectable(capability.format)) continue;
    for (const modality of capability.modalities) result[modality].push(capability.format);
  }
  return result;
}
