import { z } from "zod";

/** Upper bound of one PURGE_ASSETS job: matches the synchronous bulk-action cap so one job stays bounded and resumable. */
export const PURGE_ASSETS_MAX = 1000;

/** `Job.input` of PURGE_ASSETS. PURGE_DATASET carries an empty input: the dataset is the Job's own `datasetId`. */
export const purgeAssetsJobInputSchema = z.object({ assetIds: z.array(z.string().min(1)).min(1).max(PURGE_ASSETS_MAX) }).strict();
export type PurgeAssetsJobInput = z.infer<typeof purgeAssetsJobInputSchema>;
