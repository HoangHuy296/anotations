"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function ChangePasswordForm() {
  const router = useRouter();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    if (newPassword !== confirmation) {
      setError("New password and confirmation must match.");
      return;
    }
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "We could not change your password.");
        return;
      }
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setMessage("Password changed. Other signed-in sessions have been signed out.");
      router.refresh();
    } catch {
      setError("The account service is unavailable. Try again shortly.");
    } finally {
      setPending(false);
    }
  }

  return <form className="mt-7 space-y-5" onSubmit={submit}>
    <label className="block text-sm font-semibold text-zinc-800">Current password
      <input className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-zinc-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} required maxLength={256} />
    </label>
    <label className="block text-sm font-semibold text-zinc-800">New password
      <input className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-zinc-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required minLength={12} maxLength={256} />
      <span className="mt-1 block text-xs font-normal text-zinc-500">Use at least 12 characters and a password you have not used here before.</span>
    </label>
    <label className="block text-sm font-semibold text-zinc-800">Confirm new password
      <input className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-zinc-950 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-100" type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required maxLength={256} />
    </label>
    {error ? <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{error}</p> : null}
    {message ? <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
    <button type="submit" disabled={pending} className="h-11 rounded-xl bg-sky-600 px-4 text-sm font-semibold text-white hover:bg-sky-700 disabled:opacity-50">{pending ? "Changing password…" : "Change password"}</button>
  </form>;
}
