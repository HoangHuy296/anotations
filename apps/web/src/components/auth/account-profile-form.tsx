"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

type AccountProfileFormProps = { initialName: string; email: string };

export function AccountProfileForm({ initialName, email }: AccountProfileFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initialName);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "We could not update your profile.");
        return;
      }
      setMessage("Personal information saved.");
      router.refresh();
    } catch {
      setError("The account service is unavailable. Try again shortly.");
    } finally {
      setPending(false);
    }
  }

  return <form className="mt-7 space-y-5" onSubmit={submit}>
    <label className="block text-sm font-semibold text-zinc-800">Display name
      <input className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-zinc-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" type="text" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} required minLength={1} maxLength={100} />
    </label>
    <label className="block text-sm font-semibold text-zinc-800">Email
      <input className="mt-2 h-11 w-full cursor-not-allowed rounded-xl border border-zinc-200 bg-zinc-50 px-3 text-zinc-500" type="email" value={email} readOnly aria-readonly="true" />
      <span className="mt-1 block text-xs font-normal text-zinc-500">Email addresses are managed by an administrator.</span>
    </label>
    {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
    {message ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
    <button type="submit" disabled={pending} className="h-11 rounded-xl bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">{pending ? "Saving…" : "Save changes"}</button>
  </form>;
}
