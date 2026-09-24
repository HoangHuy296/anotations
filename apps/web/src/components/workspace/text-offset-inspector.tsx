"use client";

/**
 * T153: makes the current selection's offset *unit* explicit rather than
 * merely showing bare numbers next to a document-length label. TEXT's only
 * durable offset unit is UTF-16 code units (`UTF16_CODE_UNIT`,
 * `packages/domain/src/text-annotation-contract.ts`) -- distinct from raw
 * UTF-8 byte position (a multi-byte character spans several bytes but one
 * UTF-16 code unit for BMP characters) and from a rendered display column
 * (line-wrapping, font metrics, and grapheme clusters like combining
 * accents or emoji sequences all make "the Nth character on screen" a
 * different number than "the Nth UTF-16 code unit"). This component never
 * computes or displays either of those other two.
 */
export function TextOffsetInspector({ sourceLength, selection }: {
  sourceLength: number;
  selection: { startOffset: number; endOffset: number } | null;
}) {
  return (
    <span aria-live="polite">
      {sourceLength === 0 ? "Empty document" : `${sourceLength.toLocaleString()} UTF-16 code units`}
      {selection ? (
        <> · Selected [{selection.startOffset}, {selection.endOffset})<span className="ml-1 text-zinc-400">(UTF-16 code units, not bytes or display columns)</span></>
      ) : null}
    </span>
  );
}
