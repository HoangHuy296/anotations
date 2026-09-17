import type { z } from "zod";

import type { datasetLibraryQuerySchema } from "@/lib/datasets/dataset-library-query";

export type DatasetLibraryQuery = z.infer<typeof datasetLibraryQuerySchema>;
