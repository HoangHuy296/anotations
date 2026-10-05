/**
 * Confirmed-taxonomy contract for Dataset creation (Phase 029 / T015). Pure and browser-safe: no Node APIs, no I/O.
 *
 * - `confirmedClasses` is an optional list of class display names; absent and `[]` both mean "no confirmed classes".
 * - Identity is the SORTED set of normalized names. Request order and display casing are never part of identity.
 * - The normalization is `trim` + `toLocaleLowerCase("en-US")` (identical to the web `normalizeLabelName`); callers pass the web
 *   function in so the stored `Label.normalizedName` can never drift from the identity used here. No Unicode normalization.
 * - The first successful creation owns the trimmed display spelling; a replay never rewrites it.
 * - Colors are derived (never part of identity): the worker-style 31-hash picks a base slot in the supplied palette and the first
 *   `palette.length` classes (in sorted normalized order) probe forward, at most `palette.length` steps, to an unused color; every
 *   later class reuses its base slot. The probe loop is bounded by construction.
 */
export const MAX_CONFIRMED_CLASSES = 100;

export const normalizeClassName = (name: string): string => name.trim().toLocaleLowerCase("en-US");

export type ConfirmedClass = { readonly display: string; readonly normalized: string };
export type ConfirmedClassesAnalysis =
  | { readonly ok: true; readonly classes: readonly ConfirmedClass[]; readonly sortedNormalized: readonly string[] }
  | { readonly ok: false; readonly issue: "TOO_MANY" | "DUPLICATE" };

/** Absent/empty is valid and empty. More than the cap, or any duplicate normalized name, rejects the whole list. */
export function analyzeConfirmedClasses(names: readonly string[] | undefined, normalize: (name: string) => string = normalizeClassName): ConfirmedClassesAnalysis {
  const list = names ?? [];
  if (list.length > MAX_CONFIRMED_CLASSES) return { ok: false, issue: "TOO_MANY" };
  const seen = new Set<string>();
  const classes: ConfirmedClass[] = [];
  for (const name of list) {
    const normalized = normalize(name);
    if (seen.has(normalized)) return { ok: false, issue: "DUPLICATE" };
    seen.add(normalized);
    classes.push({ display: name.trim(), normalized });
  }
  // Plain code-unit order: locale-independent, so the identity is identical on every host.
  const sortedNormalized = [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ok: true, classes, sortedNormalized };
}

/** Repository identity fragment: present ONLY when the taxonomy is non-empty, so no-class identities stay byte-identical. */
export const repositoryTaxonomyIdentity = (sortedNormalized: readonly string[]): { v: 1; classes: readonly string[] } | undefined =>
  sortedNormalized.length === 0 ? undefined : { v: 1, classes: sortedNormalized };

/** Canonical, versioned text hashed into PreparedImport.creationRequestHash; null (stored as NULL) when there is no taxonomy. */
export const folderTaxonomyCanonical = (modality: string, sortedNormalized: readonly string[]): string | null =>
  sortedNormalized.length === 0 ? null : JSON.stringify({ v: 1, kind: "local-folder-creation", modality, taxonomy: sortedNormalized });

const slotHash = (normalizedName: string): number => {
  let hash = 0;
  for (const char of normalizedName) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  return hash;
};

/** Deterministic, request-order-independent colors for the sorted normalized names. */
export function assignClassColors(sortedNormalized: readonly string[], palette: readonly string[]): ReadonlyMap<string, string> {
  if (palette.length === 0) throw new Error("PALETTE_EMPTY");
  const colors = new Map<string, string>();
  const used = new Set<string>();
  sortedNormalized.forEach((name, index) => {
    const base = slotHash(name) % palette.length;
    let chosen = palette[base]!;
    if (index < palette.length) {
      for (let step = 0; step < palette.length; step += 1) {
        const candidate = palette[(base + step) % palette.length]!;
        if (!used.has(candidate)) { chosen = candidate; break; }
      }
    }
    used.add(chosen);
    colors.set(name, chosen);
  });
  return colors;
}

export type ConfirmedLabelRow<M extends string> = { readonly name: string; readonly normalizedName: string; readonly color: string; readonly modality: M; readonly scope: "OBJECT" };
/** Label rows in entry order. Modality is the Dataset's modality; scope is always OBJECT (no TEXT-specific scope is inferred). */
export function buildConfirmedLabelRows<M extends string>(classes: readonly ConfirmedClass[], sortedNormalized: readonly string[], modality: M, palette: readonly string[]): ConfirmedLabelRow<M>[] {
  const colors = assignClassColors(sortedNormalized, palette);
  return classes.map((entry) => ({ name: entry.display, normalizedName: entry.normalized, color: colors.get(entry.normalized)!, modality, scope: "OBJECT" as const }));
}
