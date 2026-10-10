import { isAiLabelCompatible, usableAiClass } from "@annotationplatform/domain/ai-label-resolution";

/**
 * Effective label shown for an AI track/keyframe in the VIDEO workspace. Pure and read-only: it never creates, repairs or writes a Dataset Label.
 *
 * Priority (deterministic, no fuzzy matching):
 *   1. a label the track explicitly carries (`labelId` -> `track.label`): a user's choice, or a link the writer made to an existing label;
 *   2. an existing compatible Dataset label whose canonical name equals the AI class (so a label defined later applies to older AI results);
 *   3. the original AI class (`properties.predictedClass`), exactly as the AI Service returned it;
 *   4. `unlabeled`, only when none of the above exists.
 * A same-name label of another modality or scope is never used for (2); the AI class is still shown (3).
 */
export type DisplayLabelSource = "ASSIGNED" | "DATASET_LABEL" | "AI_CLASS" | "NONE";
export type DisplayLabel = { text: string; color: string | null; source: DisplayLabelSource; predictedClass: string | null };
type KnownLabel = { name: string; color: string; modality: string | null; scope?: string };
type Props = Record<string, unknown> | null | undefined;

const PALETTE = ["#38bdf8", "#f97316", "#22c55e", "#e11d48", "#a855f7", "#eab308", "#14b8a6", "#ec4899"] as const;
export const UNLABELED_TEXT = "unlabeled";

/** Stable colour per class key so one class keeps one colour on boxes and in the track list. */
export function aiClassColor(classKey: string): string {
  let hash = 0;
  for (const char of classKey) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}

/** The recorded AI class: track properties first, then the keyframe's own (older rows carry it on the annotation only). */
export function recordedAiClass(...sources: Props[]): { key: string; display: string } | null {
  for (const source of sources) {
    const usable = usableAiClass(source?.predictedClass);
    if (usable) return usable;
  }
  return null;
}

export function resolveDisplayLabel(input: {
  assigned: { name: string; color: string } | null;
  trackProperties?: Props;
  keyframeProperties?: Props;
  datasetLabels?: ReadonlyArray<KnownLabel>;
  modality?: "VIDEO" | "IMAGE";
}): DisplayLabel {
  const ai = recordedAiClass(input.trackProperties, input.keyframeProperties);
  if (input.assigned) return { text: input.assigned.name, color: input.assigned.color, source: "ASSIGNED", predictedClass: ai?.display ?? null };
  if (ai) {
    const modality = input.modality ?? "VIDEO";
    const match = input.datasetLabels?.find((label) => label.name.trim().toLocaleLowerCase("en-US") === ai.key && isAiLabelCompatible({ modality: label.modality, scope: label.scope ?? "OBJECT" }, modality));
    if (match) return { text: match.name, color: match.color, source: "DATASET_LABEL", predictedClass: ai.display };
    return { text: ai.display, color: aiClassColor(ai.key), source: "AI_CLASS", predictedClass: ai.display };
  }
  return { text: UNLABELED_TEXT, color: null, source: "NONE", predictedClass: null };
}

/** The only text drawn above a bounding box: the effective label or class, never a track id, an "AI track" prefix, a badge or a confidence value. */
export function boxLabelText(display: DisplayLabel): string {
  return display.text;
}
