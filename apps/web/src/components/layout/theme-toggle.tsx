"use client";

import { Moon, Sun } from "@phosphor-icons/react";
import { useState } from "react";
import { useRouter } from "next/navigation";

import { saveAccountPreferences } from "@/lib/account/account-preferences-client";
import type { AccountTheme } from "@/lib/validation/account-preferences";

export function ThemeToggle({ initialTheme }: { initialTheme: AccountTheme }) {
  const router = useRouter();
  const [theme, setTheme] = useState<AccountTheme>(initialTheme);
  const [pending, setPending] = useState(false);
  const dark = theme === "dark";

  async function toggle() {
    if (pending) return;
    const previous = theme;
    const next: AccountTheme = dark ? "light" : "dark";
    setTheme(next);
    setPending(true);
    try {
      const saved = await saveAccountPreferences({ theme: next });
      setTheme(saved.theme);
      // AppShell renders `data-theme` server-side from the same preferences
      // this just saved; refresh so the rest of the shell (not just this
      // button's own icon) picks up the new theme immediately.
      router.refresh();
    } catch {
      setTheme(previous);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={`Switch to ${dark ? "light" : "dark"} mode`}
      title={`Switch to ${dark ? "light" : "dark"} mode`}
      disabled={pending}
      onClick={() => void toggle()}
      className="grid size-9 shrink-0 place-items-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:text-zinc-400 dark:hover:bg-zinc-800"
    >
      {dark ? <Sun aria-hidden="true" size={19} /> : <Moon aria-hidden="true" size={19} />}
    </button>
  );
}
