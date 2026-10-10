/**
 * AI class -> Dataset label resolution (one contract for the IMAGE and VIDEO prediction writers and the reconcile operation).
 *
 * Identity is the existing `Label.normalizedName`, unique per Dataset across modalities. Normalization is exactly the documented, deterministic
 * `trim()` + `toLocaleLowerCase("en-US")` that `normalizeLabelName` already applies everywhere; there is no fuzzy or alias matching, so two
 * distinct classes can never be merged.
 *
 * Rules, per distinct class:
 *   1. canonicalize; blank, over-long or control-character classes are rejected (`AiLabelClassInvalidError`), the literal class `unknown` stays unlabeled;
 *   2. an existing Dataset label whose modality is null or the Dataset's own modality, and whose scope is OBJECT, is reused as is (name, colour, settings untouched);
 *   3. an existing label of any other modality/scope under the same key is a CONFLICT: it is never reused and never modified, the class is reported and
 *      its annotations stay unlabeled (the unique key forbids a second label, and an IMAGE-only label must not become a VIDEO label because the key matches);
 *   4. otherwise a Dataset-scoped label is created with the Dataset's modality and a deterministic colour. Creation is `createMany(skipDuplicates)`
 *      (INSERT .. ON CONFLICT DO NOTHING), so concurrent tasks and retries cannot create a duplicate nor abort the surrounding transaction.
 * Global/default label templates are never read or written here.
 */

export type AiLabelModality = "IMAGE" | "VIDEO";

export const AI_LABEL_KEY_MAX_LENGTH = 256;
export const AI_UNKNOWN_CLASS_KEY = "unknown";

const LABEL_PALETTE = ["#38bdf8", "#f97316", "#22c55e", "#e11d48", "#a855f7", "#eab308", "#14b8a6", "#ec4899"] as const;

export class AiLabelClassInvalidError extends Error {
  constructor(readonly reason: "BLANK" | "TOO_LONG" | "CONTROL_CHARACTER") {
    super("AI_LABEL_CLASS_INVALID");
    this.name = "AiLabelClassInvalidError";
  }
}

export type AiLabelConflict = { classKey: string; reason: "INCOMPATIBLE_MODALITY" | "INCOMPATIBLE_SCOPE"; existingModality: string | null };

export type AiClassLabelResolution = {
  /** canonical class key -> Label.id for every resolved class (never contains `unknown` or a conflicting class) */
  labelIds: ReadonlyMap<string, string>;
  /** canonical class keys whose Dataset label was created by this call */
  created: readonly string[];
  conflicts: readonly AiLabelConflict[];
};

type LabelRow = { id: string; normalizedName: string; modality: string | null; scope: string };

/** The structural subset of a Prisma client/transaction this resolver needs (the worker and web pass their own). */
export interface AiLabelStore {
  label: {
    findMany(args: { where: { datasetId: string; normalizedName: { in: string[] } }; select: { id: true; normalizedName: true; modality: true; scope: true } }): Promise<LabelRow[]>;
    createMany(args: { data: Array<{ datasetId: string; modality: AiLabelModality; name: string; normalizedName: string; color: string }>; skipDuplicates: true }): Promise<{ count: number }>;
  };
}

/** Deterministic colour so a class keeps one colour across tasks, datasets and retries. */
export function aiLabelColor(classKey: string): string {
  let hash = 0;
  for (const char of classKey) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return LABEL_PALETTE[hash % LABEL_PALETTE.length]!;
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

function compatible(label: LabelRow, modality: AiLabelModality) {
  return (label.modality === null || label.modality === modality) && label.scope === "OBJECT";
}

export async function resolveAiClassLabels(
  store: AiLabelStore, datasetId: string, modality: AiLabelModality, rawClasses: Iterable<string>,
): Promise<AiClassLabelResolution> {
  // Validate everything first: one malformed class rejects the whole result before any write.
  const classes = new Map<string, string>();
  for (const raw of rawClasses) {
    const canonical = canonicalAiLabelKey(raw);
    if (canonical && !classes.has(canonical.key)) classes.set(canonical.key, canonical.display);
  }
  const labelIds = new Map<string, string>();
  const conflicts: AiLabelConflict[] = [];
  if (classes.size === 0) return { labelIds, created: [], conflicts };
  const keys = [...classes.keys()];
  const select = { id: true, normalizedName: true, modality: true, scope: true } as const;
  const classify = (rows: LabelRow[]) => {
    labelIds.clear(); conflicts.length = 0;
    const byKey = new Map(rows.map((row) => [row.normalizedName, row]));
    const missing: string[] = [];
    for (const key of keys) {
      const row = byKey.get(key);
      if (!row) { missing.push(key); continue; }
      if (compatible(row, modality)) labelIds.set(key, row.id);
      else conflicts.push({ classKey: key, reason: row.scope !== "OBJECT" && (row.modality === null || row.modality === modality) ? "INCOMPATIBLE_SCOPE" : "INCOMPATIBLE_MODALITY", existingModality: row.modality });
    }
    return missing;
  };
  const missing = classify(await store.label.findMany({ where: { datasetId, normalizedName: { in: keys } }, select }));
  const created: string[] = [];
  if (missing.length) {
    await store.label.createMany({
      data: missing.map((key) => ({ datasetId, modality, name: classes.get(key)!, normalizedName: key, color: aiLabelColor(key) })),
      skipDuplicates: true,
    });
    // Re-read: a concurrent task may have created the same key first (then it is reused, or reported if incompatible).
    const stillMissing = classify(await store.label.findMany({ where: { datasetId, normalizedName: { in: keys } }, select }));
    created.push(...missing.filter((key) => !stillMissing.includes(key)));
    if (stillMissing.length) throw new Error("AI_LABEL_RESOLUTION_FAILED");
  }
  return { labelIds, created, conflicts };
}
