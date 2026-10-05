export const accountSectionIds = ["account", "notifications", "exports", "language", "accessibility", "support"] as const;
export type AccountSectionId = typeof accountSectionIds[number];

export function accountSectionFromHash(hash: string): AccountSectionId {
  let id = hash.startsWith("#") ? hash.slice(1) : hash;
  try { id = decodeURIComponent(id); } catch { /* malformed hashes fall back to the default section */ }
  return accountSectionIds.includes(id as AccountSectionId) ? id as AccountSectionId : "account";
}
