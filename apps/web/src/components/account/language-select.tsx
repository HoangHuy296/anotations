"use client";

import { CheckCircle } from "@phosphor-icons/react";
import { useState } from "react";

import { saveAccountPreferences } from "@/lib/account/account-preferences-client";
import { supportedLanguages, type LanguageCode } from "@/lib/validation/account-preferences";

export function LanguageSelect({ initialLanguage }: { initialLanguage: LanguageCode }) {
  const [language, setLanguage] = useState<LanguageCode>(initialLanguage);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function select(code: typeof supportedLanguages[number]["code"]) {
    if (pending || code === language) return;
    if (code !== "en") return;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await saveAccountPreferences({ language: code });
      setLanguage(saved.language);
      setMessage("Language preference saved.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This setting could not be saved.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <p className="text-sm leading-6 text-zinc-500 dark:text-zinc-400">
        Annotation Platform&rsquo;s interface is currently available in English. Other languages are on the roadmap and will unlock here once translated.
      </p>
      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {supportedLanguages.map((option) => {
          const selected = option.code === language;
          return (
            <button
              key={option.code}
              type="button"
              disabled={!option.available || pending}
              onClick={() => void select(option.code)}
              aria-pressed={selected}
              className={`flex items-center justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${selected ? "border-sky-600 bg-sky-50 text-sky-800 dark:border-sky-500 dark:bg-sky-950 dark:text-sky-300" : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-600 dark:hover:bg-zinc-800/70"}`}
            >
              <span>
                {option.label}
                {!option.available ? <span className="ml-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-400">Coming soon</span> : null}
              </span>
              {selected ? <CheckCircle aria-hidden="true" className="text-sky-600 dark:text-sky-400" size={16} weight="fill" /> : null}
            </button>
          );
        })}
      </div>
      {error ? <p role="alert" className="mt-3 text-xs text-rose-700 dark:text-rose-400">{error}</p> : null}
      {message ? <p role="status" className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">{message}</p> : null}
    </div>
  );
}
