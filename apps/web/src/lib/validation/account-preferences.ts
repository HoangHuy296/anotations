import { z } from "zod";

/**
 * Self-service, non-authoritative account preferences. Never credentials,
 * never used for authorization -- purely UX state (notification delivery,
 * interface language, accessibility). Stored as `User.preferences` JSON and
 * always read back through `readAccountPreferences`, never trusted raw.
 */

/** Only "en" is a functioning interface language today; the rest are surfaced
 * in the picker as a disabled "coming soon" preview of the roadmap so the
 * setting is honest about what it currently does. */
export const supportedLanguages = [
  { code: "en", label: "English", available: true },
  { code: "vi", label: "Tiếng Việt", available: false },
  { code: "zh", label: "中文", available: false },
] as const;

export type LanguageCode = typeof supportedLanguages[number]["code"];

export const accountPreferencesSchema = z.object({
  notificationsEnabled: z.boolean().optional(),
  language: z.literal("en").optional(),
  theme: z.enum(["light", "dark"]).optional(),
  accessibility: z.object({
    reduceMotion: z.boolean().optional(),
    highContrast: z.boolean().optional(),
    largeText: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export type AccountPreferencesPatch = z.infer<typeof accountPreferencesSchema>;

export type AccountTheme = "light" | "dark";
export type AccountAccessibility = { reduceMotion: boolean; highContrast: boolean; largeText: boolean };
export type AccountPreferences = { notificationsEnabled: boolean; language: LanguageCode; theme: AccountTheme; accessibility: AccountAccessibility };

const defaults: AccountPreferences = {
  notificationsEnabled: true,
  language: "en",
  theme: "light",
  accessibility: { reduceMotion: false, highContrast: false, largeText: false },
};

/** Never trusts the stored JSON's shape -- re-parses it through the same
 * schema used for writes and falls back to defaults for anything invalid. */
export function readAccountPreferences(raw: unknown): AccountPreferences {
  const parsed = accountPreferencesSchema.safeParse(raw && typeof raw === "object" ? raw : {});
  if (!parsed.success) return defaults;
  return {
    notificationsEnabled: parsed.data.notificationsEnabled ?? defaults.notificationsEnabled,
    language: parsed.data.language ?? defaults.language,
    theme: parsed.data.theme ?? defaults.theme,
    accessibility: { ...defaults.accessibility, ...parsed.data.accessibility },
  };
}

/** A patch only ever overrides the keys it sends; every other stored
 * preference (including sibling accessibility flags) must survive untouched. */
export function mergeAccountPreferences(current: AccountPreferences, patch: AccountPreferencesPatch): AccountPreferences {
  return {
    notificationsEnabled: patch.notificationsEnabled ?? current.notificationsEnabled,
    language: patch.language ?? current.language,
    theme: patch.theme ?? current.theme,
    accessibility: { ...current.accessibility, ...patch.accessibility },
  };
}
