/**
 * T154/G5 (research.md D5): "No durable linguistic token, POS, sentence or
 * paragraph indices in this delivery... Grapheme boundaries support safe
 * character annotation and are not linguistic tokenization." No versioned
 * tokenizer/segmenter authority exists yet, so this module is the explicit
 * *absence* path -- not a tokenizer, and not a stub for one. It exists so:
 *
 * 1. "No structural view is offered" is a deliberate, testable contract
 *    (`resolveTextStructuralViews` always returns `[]`) rather than merely
 *    "not implemented yet."
 * 2. A future authoritative segmenter has one obvious integration point to
 *    replace this function's body, instead of the absence being implicit
 *    scattered across UI code.
 * 3. It is structurally impossible for a view this module could ever
 *    produce to be saved as geometry: `TextGeometry`
 *    (`packages/domain/src/text-annotation-contract.ts`) is a closed
 *    discriminated union of exactly `text-span` | `text-document` |
 *    `text-relation` -- there is no `token`/`sentence`/`paragraph` kind to
 *    persist one into, with or without this module.
 */

export type TextStructuralViewKind = "token" | "sentence" | "paragraph";

export type TextStructuralView = {
  kind: TextStructuralViewKind;
  /** The segmentation profile that produced this view, for display only -- never treated as verified/authoritative the way T006's boundary profile is. */
  algorithm: string;
  ranges: readonly { startOffset: number; endOffset: number }[];
};

/**
 * Always returns an empty array in this delivery. Never throws, never
 * guesses a segmentation from an unversioned heuristic (e.g. splitting on
 * whitespace or `Intl.Segmenter`'s word/sentence granularities without a
 * pinned, recorded profile) -- an unauthoritative guess would be worse than
 * no view at all, since a reader could mistake it for a verified boundary.
 */
export function resolveTextStructuralViews(): readonly TextStructuralView[] {
  return [];
}
