import { textGeometrySchema, type TextGeometry } from "@annotationplatform/domain/text-annotation-contract";
import { projectTextProperties, type TextProperties } from "@annotationplatform/domain/text-properties-contract";

/**
 * T085/research.md D6: the optional `text` projection added to TEXT
 * annotation/asset export records. Consumes only T005/T004 shared domain
 * contracts -- never `apps/web` types -- matching every other worker export
 * module's own boundary rule. `export-manifest.ts`/`export-selected-manifest.ts`
 * call these pure functions against a coherent Prisma snapshot; they do not
 * themselves touch the database.
 */

export type TextAnnotationExportProjection = {
  geometry: TextGeometry;
  properties: TextProperties;
  /** Relation endpoint identities (TEXT_RELATION only; null for a span). */
  fromAnnotationId: string | null;
  toAnnotationId: string | null;
};

export type TextAssetSourceExportMetadata = {
  sourceIdentity: string;
  sourceEncoding: string;
  offsetUnit: string;
  sourceByteLength: number;
  sourceCodeUnitLength: number;
};

/**
 * A TEXT annotation row's geometry/properties, re-validated the same way
 * `serializeSafeTextAnnotation` does (never trusting stored JSON as already
 * safe) -- but export deliberately excludes `createdById`/`updatedById`,
 * matching `export-manifest.ts`'s existing "excludes creator" allowlist for
 * every other modality's exported annotations. Returns null for a row whose
 * geometry does not parse as a canonical TEXT shape (never exports
 * unverifiable content).
 */
export function projectTextAnnotationForExport(row: { geometry: unknown; properties: unknown; fromAnnotationId: string | null; toAnnotationId: string | null }): TextAnnotationExportProjection | null {
  const geometry = textGeometrySchema.safeParse(row.geometry);
  if (!geometry.success) return null;
  const properties = projectTextProperties((row.properties as Record<string, unknown> | null) ?? {});
  const isRelation = geometry.data.kind === "text-relation";
  return {
    geometry: geometry.data,
    properties,
    fromAnnotationId: isRelation ? row.fromAnnotationId : null,
    toAnnotationId: isRelation ? row.toAnnotationId : null,
  };
}

/**
 * Safe TEXT source metadata for an exported asset: verified identity/
 * encoding/offset-unit/length only. Deliberately excludes
 * `boundaryArtifactKey`/`boundaryArtifactDigest` (private MinIO derivative
 * locators, AGENTS.md "Security rules") and `boundaryProfile`/
 * `preparedSourceFingerprint` (internal preparation bookkeeping, not
 * durable content). Returns null when the source has not been verified
 * (prepare never completed, or ran before these columns existed).
 */
export function projectTextAssetSourceForExport(textAsset: { sourceIdentity: string | null; sourceEncoding: string | null; offsetUnit: string | null; sourceByteLength: number | null; sourceCodeUnitLength: number | null } | null): TextAssetSourceExportMetadata | null {
  if (!textAsset) return null;
  const { sourceIdentity, sourceEncoding, offsetUnit, sourceByteLength, sourceCodeUnitLength } = textAsset;
  if (sourceIdentity === null || sourceEncoding === null || offsetUnit === null || sourceByteLength === null || sourceCodeUnitLength === null) return null;
  return { sourceIdentity, sourceEncoding, offsetUnit, sourceByteLength, sourceCodeUnitLength };
}

/**
 * research.md D6: "every exported relation must resolve in the export set
 * or the Job fails safely." A TEXT_RELATION whose `fromAnnotationId`/
 * `toAnnotationId` do not both resolve within the exact set of annotation
 * ids being exported (e.g. Export Selected covering only some assets)
 * breaks closure -- the caller must fail the whole export, never silently
 * drop the relation or emit a dangling reference.
 */
export function textRelationsResolveWithinExportSet(annotations: readonly { id: string; modality: string; fromAnnotationId: string | null; toAnnotationId: string | null }[]): boolean {
  const ids = new Set(annotations.map((row) => row.id));
  return annotations.every((row) => {
    if (row.modality !== "TEXT" || (row.fromAnnotationId === null && row.toAnnotationId === null)) return true;
    return (row.fromAnnotationId === null || ids.has(row.fromAnnotationId)) && (row.toAnnotationId === null || ids.has(row.toAnnotationId));
  });
}
