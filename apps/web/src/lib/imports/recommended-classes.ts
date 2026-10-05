/**
 * The only boundary between a maintained recommendation source and the
 * creation UI. Phase 029: no maintained product defaults are approved for any
 * modality, so every source is `none`. Never derive suggestions from AI output,
 * previews, filenames or hard-coded lists here. When the product team approves
 * maintained defaults, supply them from this function with a `provenance`
 * naming the approved source; the confirmed-class contract does not change.
 */
export type CreationModality = "IMAGE" | "VIDEO" | "AUDIO" | "TEXT";
export const creationModalities: readonly CreationModality[] = ["IMAGE", "VIDEO", "AUDIO", "TEXT"];

export type RecommendedClassSource =
  | { status: "none" }
  | { status: "maintained"; provenance: string; classes: readonly string[] };

export function maintainedRecommendedClasses(modality: CreationModality | ""): RecommendedClassSource {
  void modality;
  return { status: "none" };
}

export function recommendedClassNames(source: RecommendedClassSource): readonly string[] {
  return source.status === "maintained" ? source.classes : [];
}
