import { z } from "zod";

/**
 * `Job.input` shape shared by `BULK_DELETE_ASSETS` and `BULK_EXPORT_SELECTED`
 * (022 User Story 3/4) -- the exact wire `selection` shape from
 * `apps/web/src/lib/validation/asset-bulk.ts`'s `bulkSelectionSchema`,
 * duplicated here (rather than imported, since `apps/web` and `apps/worker`
 * never import each other's app code -- only shared, pure schemas/logic
 * live in this package) so both the web request handler that writes
 * `Job.input` and the worker processor that reads it agree on one contract.
 * Deliberately excludes `sort`/`order`/pagination -- never part of what a
 * selection matches (research.md §3).
 */
const bulkAssetJobQuerySchema = z.object({
  q: z.string().optional(),
  status: z.array(z.string()).optional(),
  modality: z.string().optional(),
  labelId: z.array(z.string()).optional(),
  assignedToId: z.string().optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  updatedFrom: z.string().optional(),
  updatedTo: z.string().optional(),
}).strict();

export const bulkAssetJobInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("EXPLICIT"), assetIds: z.array(z.string()).min(1) }).strict(),
  z.object({ mode: z.literal("FILTERED"), query: bulkAssetJobQuerySchema }).strict(),
]);

export type BulkAssetJobInput = z.infer<typeof bulkAssetJobInputSchema>;
