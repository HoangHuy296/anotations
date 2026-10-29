"use client";

import { SpinnerGap, UsersThree } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";

/** Posts the token (never put in a URL query or logged) and opens the dataset workspace on success. */
export function JoinShareLinkButton({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/share-links/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const body = await response.json().catch(() => null) as { data?: { datasetId?: string }; error?: { message?: string } } | null;
      if (!response.ok || !body?.data?.datasetId) {
        setError(body?.error?.message ?? "This share link could not be used.");
        setBusy(false);
        return;
      }
      router.replace(`/workspace/${body.data.datasetId}`);
    } catch {
      setError("Network error. Please try again.");
      setBusy(false);
    }
  }

  return <div>
    <Button className="w-full" disabled={busy} onClick={() => void join()} type="button" size="lg">
      {busy ? <SpinnerGap aria-hidden="true" className="animate-spin" size={18} /> : <UsersThree aria-hidden="true" size={18} />}
      {busy ? "Joining..." : "Join dataset"}
    </Button>
    {error ? <p className="mt-3 text-center text-xs text-rose-700 dark:text-rose-400" role="alert">{error}</p> : null}
  </div>;
}
