import "server-only";

import { createHash } from "node:crypto";

import { LabelScope, type Modality } from "@internal/db";

import { analyzeConfirmedClasses, buildConfirmedLabelRows, folderTaxonomyCanonical } from "@annotationplatform/domain/confirmed-classes";
import { LABEL_COLOR_PRESETS } from "@/lib/labels/label-color-presets";
import { normalizeLabelName } from "@/lib/validation/label-name";

export type PreparedConfirmedClasses = {
  /** Sorted normalized names: the only taxonomy input to any creation identity. */
  sortedNormalized: readonly string[];
  /** Label data (without datasetId) in entry order: Dataset modality, OBJECT scope, derived colors. */
  labels: ReadonlyArray<{ name: string; normalizedName: string; color: string; modality: Modality; scope: LabelScope }>;
};

/** Re-validates defensively (the request schema already did) and derives everything creation needs. Throws before any side effect. */
export function prepareConfirmedClasses(names: readonly string[] | undefined, modality: Modality): PreparedConfirmedClasses {
  const analysis = analyzeConfirmedClasses(names, normalizeLabelName);
  if (!analysis.ok) throw new Error("CONFIRMED_CLASSES_INVALID");
  const rows = buildConfirmedLabelRows(analysis.classes, analysis.sortedNormalized, modality, LABEL_COLOR_PRESETS);
  return { sortedNormalized: analysis.sortedNormalized, labels: rows.map((row) => ({ ...row, scope: LabelScope.OBJECT })) };
}

/** PreparedImport.creationRequestHash: NULL when there are no confirmed classes (so no-class identity is unchanged). */
export function folderCreationRequestHash(modality: Modality, sortedNormalized: readonly string[]): string | null {
  const canonical = folderTaxonomyCanonical(modality, sortedNormalized);
  return canonical === null ? null : createHash("sha256").update(canonical).digest("hex");
}
