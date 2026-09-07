import { AssetStatus, Modality } from "@internal/db";
import { z } from "zod";

/**
 * A `FILTERED` selection's query, deliberately `.strict()` with no `sort`/
 * `order`/`cursor`/`limit`/`page` fields -- those are display/pagination
 * concerns and must never define what a Selection matches (022 research.md
 * §3; contracts/assets-bulk.md rejects a request carrying them here).
 */
export const bulkSelectionQuerySchema = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  status: z.array(z.nativeEnum(AssetStatus)).min(1).optional(),
  modality: z.nativeEnum(Modality).optional(),
  labelId: z.array(z.string().cuid()).min(1).optional(),
  assignedToId: z.string().cuid().optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  updatedFrom: z.string().datetime().optional(),
  updatedTo: z.string().datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) context.addIssue({ code: "custom", path: ["createdTo"], message: "createdTo must not be before createdFrom." });
  if (value.updatedFrom && value.updatedTo && value.updatedFrom > value.updatedTo) context.addIssue({ code: "custom", path: ["updatedTo"], message: "updatedTo must not be before updatedFrom." });
});

const bulkSelectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("EXPLICIT"), assetIds: z.array(z.string().cuid()).min(1).max(1000) }),
  z.object({ mode: z.literal("FILTERED"), query: bulkSelectionQuerySchema }),
]);

const addLabelPayloadSchema = z.union([
  z.object({ labelId: z.string().cuid() }).strict(),
  z.object({ createLabel: z.object({ name: z.string().trim().min(2).max(50), color: z.string().trim().regex(/^#[0-9A-Fa-f]{6}$/) }).strict() }).strict(),
]);
const removeLabelPayloadSchema = z.object({ labelId: z.string().cuid(), confirmedAnnotationWarning: z.boolean().optional() }).strict();
const changeStatusPayloadSchema = z.object({ status: z.nativeEnum(AssetStatus) }).strict();
const assignPayloadSchema = z.object({ assignedToId: z.string().cuid().nullable() }).strict();
const emptyPayloadSchema = z.object({}).strict().optional();

/** One coherent bulk-operation boundary (022 §5/§34) rather than unrelated per-action routes. */
export const assetBulkRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("ADD_LABEL"), selection: bulkSelectionSchema, payload: addLabelPayloadSchema }),
  z.object({ action: z.literal("REMOVE_LABEL"), selection: bulkSelectionSchema, payload: removeLabelPayloadSchema }),
  z.object({ action: z.literal("CHANGE_STATUS"), selection: bulkSelectionSchema, payload: changeStatusPayloadSchema }),
  z.object({ action: z.literal("ASSIGN"), selection: bulkSelectionSchema, payload: assignPayloadSchema }),
  z.object({ action: z.literal("DELETE"), selection: bulkSelectionSchema, payload: emptyPayloadSchema }),
  z.object({ action: z.literal("EXPORT_SELECTED"), selection: bulkSelectionSchema, payload: emptyPayloadSchema }),
]);

export type AssetBulkRequest = z.infer<typeof assetBulkRequestSchema>;
