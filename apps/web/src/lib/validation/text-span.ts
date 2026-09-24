import { z } from "zod";
import { textPropertiesSchema, textPropertyPatchSchema } from "@annotationplatform/domain/text-properties-contract";

export const createTextSpanSchema = z.object({
  operationId: z.string().min(1).max(128),
  sourceIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedPolicyRevision: z.number().int().positive().safe(),
  command: z.object({
    kind: z.literal("createSpan"),
    startOffset: z.number().int().nonnegative().safe(),
    endOffset: z.number().int().positive().safe(),
    labelId: z.string().min(1).max(128).nullable(),
    properties: textPropertiesSchema.optional(),
  }).strict(),
}).strict();
export type CreateTextSpanInput = z.infer<typeof createTextSpanSchema>;

/** `updateSpan`: a nonempty patch limited to range, label, and/or custom properties (contracts/workspace.md). */
export const updateTextSpanSchema = z.object({
  operationId: z.string().min(1).max(128),
  sourceIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedPolicyRevision: z.number().int().positive().safe(),
  command: z.object({
    kind: z.literal("updateSpan"),
    annotationId: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive().safe(),
    startOffset: z.number().int().nonnegative().safe().optional(),
    endOffset: z.number().int().positive().safe().optional(),
    labelId: z.string().min(1).max(128).nullable().optional(),
    propertyPatch: textPropertyPatchSchema.optional(),
  }).strict().refine((command) => command.startOffset !== undefined || command.endOffset !== undefined || command.labelId !== undefined || command.propertyPatch !== undefined, "updateSpan requires a nonempty patch"),
}).strict();
export type UpdateTextSpanInput = z.infer<typeof updateTextSpanSchema>;

export const deleteTextAnnotationSchema = z.object({
  operationId: z.string().min(1).max(128),
  sourceIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedPolicyRevision: z.number().int().positive().safe(),
  command: z.object({
    kind: z.literal("deleteAnnotation"),
    annotationId: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive().safe(),
  }).strict(),
}).strict();
export type DeleteTextAnnotationInput = z.infer<typeof deleteTextAnnotationSchema>;

/** Cheap, non-throwing peek at `command.kind` before picking which strict schema to fully parse against -- avoids duplicating the discriminated-union machinery across near-identical envelopes (span and relation commands alike). */
export function peekTextAnnotationCommandKind(rawInput: unknown): "createSpan" | "updateSpan" | "deleteAnnotation" | "createRelation" | "updateRelation" | "replaceClassification" | null {
  if (!rawInput || typeof rawInput !== "object") return null;
  const command = (rawInput as { command?: unknown }).command;
  if (!command || typeof command !== "object") return null;
  const kind = (command as { kind?: unknown }).kind;
  return kind === "createSpan" || kind === "updateSpan" || kind === "deleteAnnotation" || kind === "createRelation" || kind === "updateRelation" || kind === "replaceClassification" ? kind : null;
}
