import { z } from "zod";

/** Protocol bounds, shared by HTTP validation, services and the TEXT editor. */
export const TEXT_CUSTOM_PROPERTY_LIMITS = Object.freeze({
  maxKeys: 32,
  maxKeyLength: 64,
  maxStringCodeUnits: 2048,
  maxEncodedBytes: 16384,
  maxNumberMagnitude: 1e15,
});

const reservedKeys = new Set([
  "__proto__", "prototype", "constructor", "geometry", "sourceIdentity",
  "revision", "labelId", "fromAnnotationId", "toAnnotationId",
]);
const keySchema = z.string().max(TEXT_CUSTOM_PROPERTY_LIMITS.maxKeyLength)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .refine((key) => !reservedKeys.has(key), "Reserved property key");
const valueSchema = z.union([
  z.null(), z.boolean(),
  z.number().finite().min(-TEXT_CUSTOM_PROPERTY_LIMITS.maxNumberMagnitude).max(TEXT_CUSTOM_PROPERTY_LIMITS.maxNumberMagnitude),
  z.string().max(TEXT_CUSTOM_PROPERTY_LIMITS.maxStringCodeUnits),
]);

// Check raw keys before Zod's record parser drops prototype-sensitive names.
const rawKeysSchema = z.unknown().superRefine((value, ctx) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value)) {
      if (!keySchema.safeParse(key).success) {
        ctx.addIssue({ code: "custom", message: "Invalid custom property key", path: [key] });
      }
    }
  }
});

export const textCustomMapSchema = rawKeysSchema.pipe(z.record(keySchema, valueSchema)).superRefine((value, ctx) => {
  if (Object.keys(value).length > TEXT_CUSTOM_PROPERTY_LIMITS.maxKeys) {
    ctx.addIssue({ code: "custom", message: "Too many custom properties" });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > TEXT_CUSTOM_PROPERTY_LIMITS.maxEncodedBytes) {
    ctx.addIssue({ code: "custom", message: "Custom properties exceed the encoded size limit" });
  }
});

export const textPropertiesSchema = z.object({ custom: textCustomMapSchema }).strict();
export const textPropertyPatchSchema = z.object({
  set: textCustomMapSchema,
  unset: z.array(keySchema).max(TEXT_CUSTOM_PROPERTY_LIMITS.maxKeys),
}).strict().superRefine((patch, ctx) => {
  if (Object.keys(patch.set).length + patch.unset.length === 0) {
    ctx.addIssue({ code: "custom", message: "Empty property patch" });
  }
  if (new Set(patch.unset).size !== patch.unset.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate unset key" });
  }
  if (patch.unset.some((key) => Object.hasOwn(patch.set, key))) {
    ctx.addIssue({ code: "custom", message: "A property cannot be set and unset together" });
  }
});

export type TextCustomMap = z.infer<typeof textCustomMapSchema>;
export type TextProperties = z.infer<typeof textPropertiesSchema>;
export type TextPropertyPatch = z.infer<typeof textPropertyPatchSchema>;

/** Pure merge: the caller owns authorization, revisions and transaction scope. */
export function applyTextPropertyPatch(
  original: Readonly<Record<string, unknown>>,
  input: unknown,
): Record<string, unknown> & TextProperties {
  const patch = textPropertyPatchSchema.parse(input);
  const custom = { ...textCustomMapSchema.parse(original.custom ?? {}), ...patch.set };
  for (const key of patch.unset) delete custom[key];
  return { ...original, custom: textCustomMapSchema.parse(custom) };
}

/** Projection excludes all unallowlisted system/provider metadata. */
export function projectTextProperties(original: Readonly<Record<string, unknown>>): TextProperties {
  return { custom: textCustomMapSchema.parse(original.custom ?? {}) };
}
