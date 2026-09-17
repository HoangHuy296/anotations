"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Switch } from "@/components/ui/switch";
import { saveAccountPreferences } from "@/lib/account/account-preferences-client";
import type { AccountAccessibility } from "@/lib/validation/account-preferences";

const rows: { key: keyof AccountAccessibility; label: string; description: string }[] = [
  { key: "reduceMotion", label: "Reduce motion", description: "Turn off transitions and animations across the app." },
  { key: "highContrast", label: "High contrast", description: "Use stronger text and border contrast for easier reading." },
  { key: "largeText", label: "Larger text", description: "Increase the base text size across the app." },
];

export function AccessibilityForm({ initial }: { initial: AccountAccessibility }) {
  const router = useRouter();
  const [values, setValues] = useState(initial);
  const [pendingKey, setPendingKey] = useState<keyof AccountAccessibility | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(key: keyof AccountAccessibility, next: boolean) {
    if (pendingKey) return;
    const previous = values;
    setValues((current) => ({ ...current, [key]: next }));
    setPendingKey(key);
    setError(null);
    try {
      const saved = await saveAccountPreferences({ accessibility: { [key]: next } });
      setValues(saved.accessibility);
      // AppShell reads these from the server on every navigation; refresh so
      // this page's own chrome reflects the change immediately too.
      router.refresh();
    } catch (caught) {
      setValues(previous);
      setError(caught instanceof Error ? caught.message : "This setting could not be saved.");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {rows.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-4 py-3.5 first:pt-0 last:pb-0">
          <div>
            <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{row.label}</p>
            <p className="mt-1 max-w-md text-sm leading-6 text-zinc-500 dark:text-zinc-400">{row.description}</p>
          </div>
          <Switch checked={values[row.key]} onCheckedChange={(next) => void toggle(row.key, next)} disabled={pendingKey !== null} label={row.label} />
        </div>
      ))}
      {error ? <p role="alert" className="pt-3 text-xs text-rose-700 dark:text-rose-400">{error}</p> : null}
    </div>
  );
}
