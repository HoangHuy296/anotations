"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Switch } from "@/components/ui/switch";
import { saveAccountPreferences } from "@/lib/account/account-preferences-client";

export function NotificationsToggle({ initialEnabled }: { initialEnabled: boolean }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    if (pending) return;
    setEnabled(next);
    setError(null);
    setPending(true);
    try {
      const saved = await saveAccountPreferences({ notificationsEnabled: next });
      setEnabled(saved.notificationsEnabled);
      router.refresh();
    } catch (caught) {
      setEnabled(!next);
      setError(caught instanceof Error ? caught.message : "This setting could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">In-app notifications</p>
        <p className="mt-1 max-w-md text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          Get notified in Annotation Platform about comments, mentions, assignments, and review activity on datasets you belong to.
        </p>
        {error ? <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-400">{error}</p> : null}
      </div>
      <Switch checked={enabled} onCheckedChange={(next) => void toggle(next)} disabled={pending} label="In-app notifications" />
    </div>
  );
}
