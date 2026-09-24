/**
 * Pure DOM-segment and search-match logic for the TEXT reader (T057/T058).
 * The canonical offset unit is UTF-16 code units (`UTF16_CODE_UNIT`) — the
 * same unit JavaScript string indexing already uses, so as long as the
 * reader renders the *exact* decoded source string with no transformation,
 * a JS string index equals the canonical source offset directly. Splitting
 * the text into segments (each rendered as its own DOM element carrying its
 * own `startOffset`) is the "source-indexed segment table": it lets the
 * DOM itself answer "which source offset does this text node belong to",
 * without a separately-maintained parallel data structure to keep in sync.
 */

export type TextSegmentKind = "plain" | "search-match" | "search-match-active" | "span" | "span-pending-relation";

export type TextSegment = {
  key: string;
  kind: TextSegmentKind;
  startOffset: number;
  endOffset: number;
  text: string;
  /** Set only for "span"/"span-pending-relation" segments -- the saved `Annotation.id` this text renders, and its label's color/name (for per-label styling and the hover title). `text-engine.tsx` uses these for click handling; `buildTextSegments` itself stays kind-agnostic. */
  annotationId?: string;
  color?: string;
  label?: string;
};

export type TextHighlightRange = { startOffset: number; endOffset: number; kind: Exclude<TextSegmentKind, "plain">; key: string; annotationId?: string; color?: string; label?: string };

/** Splits at every range boundary so nested entities never discard source text. */
export function buildTextSegments(text: string, highlights: readonly TextHighlightRange[] = []): TextSegment[] {
  const valid = highlights.filter((item) => Number.isInteger(item.startOffset) && Number.isInteger(item.endOffset) && item.startOffset >= 0 && item.startOffset < item.endOffset && item.endOffset <= text.length);
  const starts = new Map<number, TextHighlightRange[]>();
  const ends = new Map<number, TextHighlightRange[]>();
  for (const item of valid) {
    starts.set(item.startOffset, [...(starts.get(item.startOffset) ?? []), item]);
    ends.set(item.endOffset, [...(ends.get(item.endOffset) ?? []), item]);
  }
  const offsets = [...new Set([0, text.length, ...starts.keys(), ...ends.keys()])].sort((a, b) => a - b);
  const active = new Set<TextHighlightRange>();
  const segments: TextSegment[] = [];
  for (let index = 0; index < offsets.length - 1; index++) {
    const startOffset = offsets[index];
    const endOffset = offsets[index + 1];
    for (const item of ends.get(startOffset) ?? []) active.delete(item);
    for (const item of starts.get(startOffset) ?? []) active.add(item);
    const covering = [...active];
    const highlight = covering.find((item) => item.kind === "search-match-active")
      ?? covering.find((item) => item.kind === "search-match")
      ?? covering.find((item) => item.kind === "span-pending-relation")
      ?? covering.at(-1);
    const labels = [...new Set(covering.flatMap((item) => item.label ? [item.label] : []))];
    segments.push(highlight ? {
      key: startOffset === highlight.startOffset ? highlight.key : `${highlight.key}-${startOffset}`,
      kind: highlight.kind, startOffset, endOffset, text: text.slice(startOffset, endOffset),
      annotationId: highlight.annotationId, color: highlight.color,
      label: labels.length ? labels.join(" / ") : undefined,
    } : { key: `plain-${startOffset}`, kind: "plain", startOffset, endOffset, text: text.slice(startOffset, endOffset) });
  }
  return segments.length ? segments : [{ key: "plain-0", kind: "plain", startOffset: 0, endOffset: 0, text: "" }];
}

/**
 * Literal (non-regex, non-fuzzy), case-sensitive, non-overlapping UTF-16
 * substring matches. Deliberately not grapheme-boundary-snapped: search
 * matches are ephemeral presentation, not annotation geometry
 * (research.md D5), so a query that happens to bisect a combining sequence
 * still highlights exactly what the user typed.
 */
export function findLiteralMatches(source: string, query: string): Array<{ startOffset: number; endOffset: number }> {
  if (!query) return [];
  const matches: Array<{ startOffset: number; endOffset: number }> = [];
  let index = source.indexOf(query);
  while (index !== -1) {
    matches.push({ startOffset: index, endOffset: index + query.length });
    index = source.indexOf(query, index + query.length);
  }
  return matches;
}

/**
 * The next active-match index for search Previous/Next, wrapping in both
 * directions. `null` in, `null` out only when there are no matches at all
 * (`total === 0`) -- otherwise a `null` current index (no active match yet)
 * starts from position 0 before applying `delta`.
 */
export function nextTextMatchIndex(current: number | null, total: number, delta: 1 | -1): number | null {
  if (total === 0) return null;
  return ((current ?? 0) + delta + total) % total;
}

/** DOM element offsets count child nodes; Range converts both node kinds to UTF-16 offsets. */
export function resolveTextOffsetFromNode(container: Element, node: Node, localOffset: number): number | null {
  if (!container.contains(node) || !Number.isInteger(localOffset) || localOffset < 0) return null;
  try {
    const range = container.ownerDocument.createRange();
    range.selectNodeContents(container);
    range.setEnd(node, localOffset);
    return range.toString().length;
  } catch {
    return null;
  }
}

/** The current browser selection translated to canonical source offsets, normalized so `startOffset <= endOffset` regardless of drag direction. `null` for no/collapsed selection or a selection outside `container`. */
export function resolveContainerSelectionOffsets(container: Element): { startOffset: number; endOffset: number } | null {
  const selection = typeof window !== "undefined" ? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const start = resolveTextOffsetFromNode(container, range.startContainer, range.startOffset);
  const end = resolveTextOffsetFromNode(container, range.endContainer, range.endOffset);
  if (start === null || end === null) return null;
  return start <= end ? { startOffset: start, endOffset: end } : { startOffset: end, endOffset: start };
}
