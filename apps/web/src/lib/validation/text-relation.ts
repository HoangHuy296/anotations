import { z } from "zod";

/**
 * `createRelation`: links two existing TEXT entity spans on the same asset
 * under a configured relation type (`Dataset.textPolicy.relationTypes`).
 * Mirrors `createTextSpanSchema`'s envelope shape (operationId/sourceIdentity/
 * expectedPolicyRevision) so it flows through the same guarded-command
 * machinery (`text-command-service.ts`) as span commands.
 */
export const createTextRelationSchema = z.object({
  operationId: z.string().min(1).max(128),
  sourceIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedPolicyRevision: z.number().int().positive().safe(),
  command: z.object({
    kind: z.literal("createRelation"),
    relationLabelId: z.string().min(1).max(128),
    fromAnnotationId: z.string().min(1).max(128),
    toAnnotationId: z.string().min(1).max(128),
  }).strict().refine((command) => command.fromAnnotationId !== command.toAnnotationId, { message: "A relation cannot connect an entity to itself", path: ["toAnnotationId"] }),
}).strict();
export type CreateTextRelationInput = z.infer<typeof createTextRelationSchema>;

export const updateTextRelationSchema = z.object({
  operationId: z.string().min(1).max(128),
  sourceIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedPolicyRevision: z.number().int().positive().safe(),
  command: z.object({
    kind: z.literal("updateRelation"),
    annotationId: z.string().min(1).max(128),
    expectedRevision: z.number().int().positive().safe(),
    relationLabelId: z.string().min(1).max(128).optional(),
    fromAnnotationId: z.string().min(1).max(128).optional(),
    toAnnotationId: z.string().min(1).max(128).optional(),
  }).strict().refine((command) => command.relationLabelId !== undefined || command.fromAnnotationId !== undefined || command.toAnnotationId !== undefined, "A relation update requires a patch"),
}).strict();
