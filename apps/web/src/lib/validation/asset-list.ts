import { AssetStatus, Modality } from "@internal/db";
import { z } from "zod";

export const assetListQuerySchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: z.nativeEnum(AssetStatus).optional(),
  modality: z.nativeEnum(Modality).optional(),
  q: z.string().trim().min(1).max(100).optional(),
});
