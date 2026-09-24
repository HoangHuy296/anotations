import { z } from "zod";
import { datasetIdSchema } from "@/lib/validation/dataset";

/**
 * TEXT eligibility scope (025-text-workspace-engine): reuses the existing
 * generic `Label.scope`/`Label.modality` fields — `LabelScope` already
 * contains ENTITY/CLASSIFICATION/SENTIMENT/INTENT/RELATION, no new column.
 * "NONE" is an explicit, deliberate clear back to the universal default
 * (`modality: null`, `scope: OBJECT`); omitting the field entirely (the
 * common case for every non-TEXT label edit) leaves modality/scope
 * untouched. See text-policy-service.ts for how these scopes are consumed.
 */
export const textEligibilityScopeValues = ["ENTITY", "CLASSIFICATION", "SENTIMENT", "INTENT", "RELATION"] as const;
export const textEligibilityScopeSchema = z.enum(textEligibilityScopeValues);
export type TextEligibilityScope = z.infer<typeof textEligibilityScopeSchema>;

// Plain string enum (not a transform/preprocess) so the client-facing input
// type stays a simple string for react-hook-form; "" and omission both mean
// "no change requested" — normalized in label-management.ts's
// `resolveTextEligibilityTarget`, not here.
export const textEligibilityFieldSchema = z.enum(["", "NONE", ...textEligibilityScopeValues]).optional();
export type TextEligibilityField = z.infer<typeof textEligibilityFieldSchema>;

export const labelSchema = z.object({
  datasetId: datasetIdSchema,
  name: z
    .string()
    .trim()
    .min(2, "Name must contain at least 2 characters.")
    .max(50, "Name must contain at most 50 characters."),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Use a 6-digit hex color such as #0EA5E9.")
    .transform((value) => value.toUpperCase()),
  description: z
    .string()
    .trim()
    .max(280, "Description must contain at most 280 characters."),
  hotkey: z
    .string()
    .trim()
    .refine(
      (value) => value === "" || /^[A-Za-z0-9]$/.test(value),
      "Hotkey must be one letter or number.",
    )
    .transform((value) => value.toUpperCase()),
  textEligibility: textEligibilityFieldSchema,
});

export const labelIdSchema = z.string().cuid("Invalid label identifier.");
export const labelMutationSchema = z.object({
  name: labelSchema.shape.name,
  color: labelSchema.shape.color,
  description: labelSchema.shape.description.default(""),
  hotkey: labelSchema.shape.hotkey.default(""),
  textEligibility: textEligibilityFieldSchema,
});
export function normalizeLabelName(name: string) { return name.trim().toLocaleLowerCase("en-US"); }

export type LabelInput = z.input<typeof labelSchema>;
