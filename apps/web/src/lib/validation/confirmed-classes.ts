import { z } from "zod";

import { analyzeConfirmedClasses, MAX_CONFIRMED_CLASSES } from "@annotationplatform/domain/confirmed-classes";
import { labelNameSchema, normalizeLabelName } from "@/lib/validation/label-name";

/**
 * Optional list of confirmed class display names (0..100). Each name follows the existing Label name rule; a normalized duplicate
 * rejects the whole request. Absent and [] both mean "no confirmed classes". Validation runs before any side effect.
 */
export const confirmedClassesSchema = z
  .array(labelNameSchema)
  .max(MAX_CONFIRMED_CLASSES, `At most ${MAX_CONFIRMED_CLASSES} classes can be confirmed.`)
  .superRefine((names, context) => {
    if (analyzeConfirmedClasses(names, normalizeLabelName).ok === false) context.addIssue({ code: "custom", message: "Class names must be unique (case-insensitive)." });
  })
  .optional();
