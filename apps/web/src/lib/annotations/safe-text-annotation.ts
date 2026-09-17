import "server-only";

import { serializeSafeTextAnnotation, type SafeTextAnnotation } from "@annotationplatform/domain/text-annotation-contract";

/**
 * Web adapter over the shared T005 safe serializer. Never redefines the
 * canonical shape — only composes it with an authorized source excerpt when
 * one is available. The worker's export serializer (text-export-serializer.ts)
 * must import `serializeSafeTextAnnotation` from packages/domain directly and
 * never depend on this file.
 */

export type SafeTextAnnotationWithExcerpt = SafeTextAnnotation & { excerpt: string | null };

/**
 * `sourceText` must be the exact verified decoded source for the same
 * `sourceIdentity` this annotation's geometry carries (i.e. text-source-
 * read-service.ts's `text` field for a READY read of the same asset) — this
 * function trusts the caller on that binding, it does not re-verify identity
 * itself. Selected excerpts exist only in this authorized in-memory
 * projection; they are never persisted or included in a safe annotation
 * returned without a verified source alongside it.
 */
export function toSafeTextAnnotationWithExcerpt(record: unknown, sourceText: string | null = null): SafeTextAnnotationWithExcerpt {
  const safe = serializeSafeTextAnnotation(record);
  if (sourceText === null || safe.geometry.kind !== "text-span") return { ...safe, excerpt: null };
  return { ...safe, excerpt: sourceText.slice(safe.geometry.startOffset, safe.geometry.endOffset) };
}
