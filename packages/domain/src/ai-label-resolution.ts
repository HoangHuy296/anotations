/**
 * AI class vs Dataset label (one contract for the IMAGE and VIDEO prediction writers and the workspace display).
 *
 * Two distinct concepts:
 *   - `predictedClass`: the class the AI Service returned. It is recorded on every AI annotation and track (`properties.predictedClass`) and is never rewritten.
 *   - a Dataset `Label`: annotation configuration owned by the Dataset. A Label row is NEVER created because a class was predicted.
 *
 * A writer links an AI result to an existing Label only when one matches by the existing canonical key (`Label.normalizedName` = `trim()` +
 * `toLocaleLowerCase("en-US")`, no fuzzy or alias matching) and is compatible (modality null or the Dataset's own, scope OBJECT). Otherwise `labelId` stays
 * null and the original class is what the workspace shows. A same-key Label of another modality or scope is reported as a conflict and is never reused or
 * modified.
 */

export type AiLabelModality = "IMAGE" | "VIDEO";

export const AI_LABEL_KEY_MAX_LENGTH = 256;
export const AI_UNKNOWN_CLASS_KEY = "unknown";

export class AiLabelClassInvalidError extends Error {
  constructor(readonly reason: "BLANK" | "TOO_LONG" | "CONTROL_CHARACTER") {
    super("AI_LABEL_CLASS_INVALID");
    this.name = "AiLabelClassInvalidError";
  }
}

export type AiLabelConflict = { classKey: string; reason: "INCOMPATIBLE_MODALITY" | "INCOMPATIBLE_SCOPE"; existingModality: string | null };

export type AiClassLabelMatch = {
  /** canonical class key -> Label.id for every class that matched a compatible existing Dataset label (never `unknown`, never a conflicting class) */
  labelIds: ReadonlyMap<string, string>;
  conflicts: readonly AiLabelConflict[];
};

type LabelRow = { id: string; normalizedName: string; modality: string | null; scope: string };

/** The structural subset of a Prisma client/transaction the matcher needs: reads only. */
export interface AiLabelReader {
  label: {
    findMany(args: { where: { datasetId: string; normalizedName: { in: string[] } }; select: { id: true; normalizedName: true; modality: true; scope: true } }): Promise<LabelRow[]>;
  };
}

/** `null` means the explicit "no class" value (`unknown`); every malformed value throws. */
export function canonicalAiLabelKey(raw: string): { key: string; display: string } | null {
  const display = raw.trim();
  if (!display) throw new AiLabelClassInvalidError("BLANK");
  if (display.length > AI_LABEL_KEY_MAX_LENGTH) throw new AiLabelClassInvalidError("TOO_LONG");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(display)) throw new AiLabelClassInvalidError("CONTROL_CHARACTER");
  const key = display.toLocaleLowerCase("en-US");
  return key === AI_UNKNOWN_CLASS_KEY ? null : { key, display };
}

/** Never throws: a usable class for display, or null (blank, malformed, over-long or `unknown`). */
export function usableAiClass(raw: unknown): { key: string; display: string } | null {
  if (typeof raw !== "string") return null;
  try { return canonicalAiLabelKey(raw); } catch { return null; }
}

/** Can an existing Dataset label carry an AI class of this modality? */
export function isAiLabelCompatible(label: { modality: string | null; scope: string }, modality: AiLabelModality): boolean {
  return (label.modality === null || label.modality === modality) && label.scope === "OBJECT";
}

/** Read-only: which of the result's classes map to an existing compatible Dataset label. One malformed class rejects the whole result before any write. */
export async function matchAiClassLabels(reader: AiLabelReader, datasetId: string, modality: AiLabelModality, rawClasses: Iterable<string>): Promise<AiClassLabelMatch> {
  const keys = new Set<string>();
  for (const raw of rawClasses) { const canonical = canonicalAiLabelKey(raw); if (canonical) keys.add(canonical.key); }
  const labelIds = new Map<string, string>();
  const conflicts: AiLabelConflict[] = [];
  if (keys.size === 0) return { labelIds, conflicts };
  const rows = await reader.label.findMany({ where: { datasetId, normalizedName: { in: [...keys] } }, select: { id: true, normalizedName: true, modality: true, scope: true } });
  for (const row of rows) {
    if (isAiLabelCompatible(row, modality)) labelIds.set(row.normalizedName, row.id);
    else conflicts.push({ classKey: row.normalizedName, reason: row.scope !== "OBJECT" && (row.modality === null || row.modality === modality) ? "INCOMPATIBLE_SCOPE" : "INCOMPATIBLE_MODALITY", existingModality: row.modality });
  }
  return { labelIds, conflicts };
}
