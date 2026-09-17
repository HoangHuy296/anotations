import {
  textBoundaryArtifactSchema,
  TEXT_BOUNDARY_ARTIFACT_SCHEMA_VERSION,
  TEXT_BOUNDARY_ALGORITHM,
  type TextBoundaryArtifact,
} from "@annotationplatform/domain/text-boundary-contract";
import { UTF16_CODE_UNIT } from "@annotationplatform/domain/text-annotation-contract";

/**
 * Computes the authoritative extended-grapheme-cluster boundary map (research.md
 * D1) for a decoded TEXT source, using the runtime's own Intl.Segmenter and
 * recording the actual Node/ICU/Unicode profile that produced it. The root
 * ("und") locale is used so segmentation is not tailored by any language
 * default. This is the single place boundary offsets are computed; the web
 * loader only reads and validates the resulting artifact (T026), never
 * recomputes it.
 */
/** Deterministic private derivative key: same source + profile always resolves to the same object, so a duplicate delivery overwrites in place rather than accumulating. */
export function textBoundaryArtifactObjectKey(input: { datasetId: string; assetId: string; sourceIdentity: string }): string {
  const digest = input.sourceIdentity.startsWith("sha256:") ? input.sourceIdentity.slice("sha256:".length) : input.sourceIdentity;
  return `text-boundaries/${input.datasetId}/${input.assetId}/${digest}.${TEXT_BOUNDARY_ALGORITHM.toLowerCase()}-v${TEXT_BOUNDARY_ARTIFACT_SCHEMA_VERSION}.json`;
}

export function computeTextBoundaryArtifact(input: { text: string; sourceIdentity: string }): TextBoundaryArtifact {
  const boundaryOffsets: number[] = [0];
  const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });
  for (const segment of segmenter.segment(input.text)) {
    if (segment.index !== 0) boundaryOffsets.push(segment.index);
  }
  if (input.text.length > 0) boundaryOffsets.push(input.text.length);

  return textBoundaryArtifactSchema.parse({
    schemaVersion: TEXT_BOUNDARY_ARTIFACT_SCHEMA_VERSION,
    profile: {
      schemaVersion: TEXT_BOUNDARY_ARTIFACT_SCHEMA_VERSION,
      algorithm: TEXT_BOUNDARY_ALGORITHM,
      nodeVersion: process.versions.node,
      icuVersion: process.versions.icu ?? "unknown",
      unicodeVersion: process.versions.unicode ?? "unknown",
    },
    sourceIdentity: input.sourceIdentity,
    offsetUnit: UTF16_CODE_UNIT,
    sourceCodeUnitLength: input.text.length,
    boundaryOffsets,
  });
}
