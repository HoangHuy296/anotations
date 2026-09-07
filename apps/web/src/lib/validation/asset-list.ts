import { AssetStatus, Modality } from "@internal/db";
import { z } from "zod";

/** Repeatable query params (`?status=A&status=B`) also accept a single bare value for backward compatibility. */
const asArray = <T extends z.ZodTypeAny>(schema: T) => z.union([schema, z.array(schema)]).transform((value) => (Array.isArray(value) ? value : [value]));

export const assetListQuerySchema = z.object({
  cursor: z.string().cuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  status: asArray(z.nativeEnum(AssetStatus)).optional(),
  modality: z.nativeEnum(Modality).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  labelId: asArray(z.string().cuid()).optional(),
  assignedToId: z.string().cuid().optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  updatedFrom: z.string().datetime().optional(),
  updatedTo: z.string().datetime().optional(),
  sort: z.enum(["createdAt", "updatedAt", "filename"]).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
}).superRefine((value, context) => {
  if (value.createdFrom && value.createdTo && value.createdFrom > value.createdTo) {
    context.addIssue({ code: "custom", path: ["createdTo"], message: "createdTo must not be before createdFrom." });
  }
  if (value.updatedFrom && value.updatedTo && value.updatedFrom > value.updatedTo) {
    context.addIssue({ code: "custom", path: ["updatedTo"], message: "updatedTo must not be before updatedFrom." });
  }
});
