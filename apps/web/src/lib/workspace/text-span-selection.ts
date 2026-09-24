import type { TextSelectionRange } from "@/types/text";

/** Snap outward only against the verified server boundary map. */
export function normalizeTextSpanSelection(range: TextSelectionRange | null, boundaries: readonly number[]): TextSelectionRange | null {
  if (!range || boundaries.length < 2) return null;
  const start = Math.min(range.startOffset, range.endOffset);
  const end = Math.max(range.startOffset, range.endOffset);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > boundaries[boundaries.length - 1]) return null;
  let left = 0;
  let right = boundaries.length - 1;
  while (left < right) { const middle = Math.ceil((left + right) / 2); if (boundaries[middle] <= start) left = middle; else right = middle - 1; }
  const startOffset = boundaries[left];
  left = 0; right = boundaries.length - 1;
  while (left < right) { const middle = Math.floor((left + right) / 2); if (boundaries[middle] < end) left = middle + 1; else right = middle; }
  return { startOffset, endOffset: boundaries[left] };
}
