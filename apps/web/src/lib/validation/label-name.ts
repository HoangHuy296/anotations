import { z } from "zod";

/** The one Label name rule (trimmed, 2-50 characters) and identity function; shared with confirmed classes without an import cycle. */
export const labelNameSchema = z
  .string()
  .trim()
  .min(2, "Name must contain at least 2 characters.")
  .max(50, "Name must contain at most 50 characters.");

export function normalizeLabelName(name: string) { return name.trim().toLocaleLowerCase("en-US"); }
