import { labelSchema, normalizeLabelName } from "@/lib/validation/label";

/** Draft confirmed-class list: display names only. Server handling of this list is a separate, still-unapproved contract. */
export type ConfirmedClassDraft = readonly string[];

export type AddClassResult =
  | { ok: true; classes: ConfirmedClassDraft; name: string }
  | { ok: false; reason: "INVALID" | "DUPLICATE"; message: string };

/** Class names follow the existing Label name rule (trimmed, 2-50 characters); no new normalization. */
export function validateClassName(raw: string): { ok: true; name: string } | { ok: false; message: string } {
  const parsed = labelSchema.shape.name.safeParse(raw);
  return parsed.success ? { ok: true, name: parsed.data } : { ok: false, message: parsed.error.issues[0]?.message ?? "Enter a valid class name." };
}

/** Duplicates are detected with the existing Label identity (`normalizeLabelName`) and are not added. */
export function addConfirmedClass(classes: ConfirmedClassDraft, raw: string): AddClassResult {
  const checked = validateClassName(raw);
  if (!checked.ok) return { ok: false, reason: "INVALID", message: checked.message };
  const key = normalizeLabelName(checked.name);
  if (classes.some((existing) => normalizeLabelName(existing) === key)) return { ok: false, reason: "DUPLICATE", message: `"${checked.name}" is already added.` };
  return { ok: true, classes: [...classes, checked.name], name: checked.name };
}

export function removeConfirmedClass(classes: ConfirmedClassDraft, name: string): ConfirmedClassDraft {
  const key = normalizeLabelName(name);
  return classes.filter((existing) => normalizeLabelName(existing) !== key);
}
