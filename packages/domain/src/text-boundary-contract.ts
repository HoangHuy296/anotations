import { z } from "zod";
import { UTF16_CODE_UNIT } from "./text-annotation-contract.js";

/**
 * Versioned extended-grapheme boundary artifact schema. The worker writes
 * one of these per prepared source; the web loader reads and validates it.
 * Both sides import this module instead of duplicating the shape.
 */

export const TEXT_BOUNDARY_ARTIFACT_SCHEMA_VERSION = 1 as const;
export const TEXT_BOUNDARY_ALGORITHM = "EXTENDED_GRAPHEME_CLUSTER" as const;

export const textBoundaryProfileSchema = z
  .object({
    schemaVersion: z.literal(TEXT_BOUNDARY_ARTIFACT_SCHEMA_VERSION),
    algorithm: z.literal(TEXT_BOUNDARY_ALGORITHM),
    nodeVersion: z.string().min(1),
    icuVersion: z.string().min(1),
    unicodeVersion: z.string().min(1),
  })
  .strict();

export type TextBoundaryProfile = z.infer<typeof textBoundaryProfileSchema>;

export const textBoundaryArtifactSchema = z
  .object({
    schemaVersion: z.literal(TEXT_BOUNDARY_ARTIFACT_SCHEMA_VERSION),
    profile: textBoundaryProfileSchema,
    sourceIdentity: z.string().min(1),
    offsetUnit: z.literal(UTF16_CODE_UNIT),
    sourceCodeUnitLength: z.number().int().nonnegative().safe(),
    boundaryOffsets: z.array(z.number().int().nonnegative().safe()),
  })
  .strict()
  .superRefine((artifact, ctx) => {
    const { boundaryOffsets, sourceCodeUnitLength } = artifact;
    if (boundaryOffsets.length === 0) {
      ctx.addIssue({ code: "custom", message: "boundaryOffsets must not be empty" });
      return;
    }
    if (boundaryOffsets[0] !== 0) {
      ctx.addIssue({ code: "custom", message: "boundaryOffsets must start at 0" });
    }
    if (boundaryOffsets[boundaryOffsets.length - 1] !== sourceCodeUnitLength) {
      ctx.addIssue({ code: "custom", message: "boundaryOffsets must end at sourceCodeUnitLength" });
    }
    for (let i = 1; i < boundaryOffsets.length; i += 1) {
      if (boundaryOffsets[i] <= boundaryOffsets[i - 1]) {
        ctx.addIssue({ code: "custom", message: "boundaryOffsets must be strictly increasing" });
        break;
      }
    }
    for (const offset of boundaryOffsets) {
      if (offset > sourceCodeUnitLength) {
        ctx.addIssue({ code: "custom", message: "boundaryOffsets must not exceed sourceCodeUnitLength" });
        break;
      }
    }
  });

export type TextBoundaryArtifact = z.infer<typeof textBoundaryArtifactSchema>;

/** Binary search membership check: is `offset` an authoritative grapheme boundary? */
export function isTextBoundaryOffset(artifact: Pick<TextBoundaryArtifact, "boundaryOffsets">, offset: number): boolean {
  const offsets = artifact.boundaryOffsets;
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const candidate = offsets[mid];
    if (candidate === offset) return true;
    if (candidate < offset) low = mid + 1;
    else high = mid - 1;
  }
  return false;
}
