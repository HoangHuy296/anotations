"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { cn } from "@/lib/utils";

export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } finally {
      router.replace("/login");
      router.refresh();
      setPending(false);
    }
  }

  return <button type="button" onClick={() => void signOut()} disabled={pending} className={cn("rounded-lg px-2 py-1 text-xs font-semibold text-zinc-600 hover:bg-zinc-100 disabled:opacity-50", className)}>{pending ? "Signing out…" : "Sign out"}</button>;
}
