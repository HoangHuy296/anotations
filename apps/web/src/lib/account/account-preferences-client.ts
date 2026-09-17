"use client";

import type { AccountPreferences, AccountPreferencesPatch } from "@/lib/validation/account-preferences";

type ApiEnvelope<T> = { data?: T; error?: { message?: string } };

/** Every account settings toggle sends only the keys it owns; the API
 * route merges the patch into whatever preferences are already stored. */
export async function saveAccountPreferences(patch: AccountPreferencesPatch): Promise<AccountPreferences> {
  const response = await fetch("/api/auth/preferences", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(patch),
  });
  const body = await response.json() as ApiEnvelope<AccountPreferences>;
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Your preference could not be saved.");
  return body.data;
}
