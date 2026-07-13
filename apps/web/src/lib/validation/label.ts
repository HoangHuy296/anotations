import { z } from "zod";

export const labelSchema = z.object({
  datasetId: z.string().cuid("Select a valid dataset."),
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
});

export const labelIdSchema = z.string().cuid("Invalid label identifier.");

export type LabelInput = z.input<typeof labelSchema>;
