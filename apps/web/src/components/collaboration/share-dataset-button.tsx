"use client";

import { Check, Copy, LinkSimple, ShareNetwork, SpinnerGap, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

type ShareLink = {
  id: string;
  expiresAt: string;
  maxUses: number | null;
  useCount: number;
  revokedAt: string | null;
  createdAt: string;
  state: "ACTIVE" | "EXPIRED" | "REVOKED" | "EXHAUSTED";
};
type Envelope<T> = { data?: T; error?: { message?: string } };

const EXPIRY_OPTIONS = [{ days: 1, label: "1 day" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }];
const USE_OPTIONS: Array<{ value: number | null; label: string }> = [{ value: null, label: "Unlimited" }, { value: 1, label: "1 person" }, { value: 5, label: "5 people" }, { value: 25, label: "25 people" }];

function relative(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const unit = abs >= 86_400_000 ? [Math.round(abs / 86_400_000), "d"] : abs >= 3_600_000 ? [Math.round(abs / 3_600_000), "h"] : [Math.max(1, Math.round(abs / 60_000)), "m"];
  return ms >= 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`;
}

/**
 * Header "Share" control for dataset owners/managers. A created link joins whoever opens it (after signing in)
 * as a LABELER. The raw link is shown once, right after creation; afterwards only its metadata is listed.
 */
export function ShareDatasetButton({ datasetId }: { datasetId: string }) {
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/datasets/${datasetId}/share-links`, { cache: "no-store" });
      const body = await response.json() as Envelope<{ items: ShareLink[] }>;
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Share links could not be loaded.");
      setLinks(body.data.items);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Share links could not be loaded."); }
  }, [datasetId]);

  useEffect(() => { if (open) { setError(null); void load(); } }, [open, load]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); rootRef.current?.querySelector<HTMLButtonElement>("button[aria-haspopup]")?.focus(); } };
    const onDown = (event: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  async function create() {
    setBusy(true); setError(null); setCopied(false);
    try {
      const response = await fetch(`/api/datasets/${datasetId}/share-links`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresInDays: days, maxUses }) });
      const body = await response.json() as Envelope<{ token: string }>;
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "The share link could not be created.");
      setCreated(`${window.location.origin}/join/${body.data.token}`);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The share link could not be created."); }
    finally { setBusy(false); }
  }

  async function copy() {
    if (!created) return;
    try { await navigator.clipboard.writeText(created); } catch {
      const field = document.getElementById("share-link-url") as HTMLInputElement | null;
      field?.select(); document.execCommand("copy");
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  async function revoke(id: string) {
    setError(null);
    const response = await fetch(`/api/datasets/${datasetId}/share-links/${id}`, { method: "DELETE" });
    if (!response.ok) { setError("The share link could not be revoked."); return; }
    setCreated(null);
    await load();
  }

  const active = (links ?? []).filter((link) => link.state === "ACTIVE");

  return <div ref={rootRef} className="relative">
    <Button type="button" size="sm" variant="secondary" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <ShareNetwork aria-hidden="true" size={17} />Share
    </Button>
    {open ? <div role="dialog" aria-label="Share dataset" className="absolute right-0 top-full z-50 mt-2 w-[min(92vw,380px)] rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-zinc-950 dark:text-zinc-50">Share this dataset</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Anyone with the link who signs in joins as a <strong className="font-semibold text-zinc-700 dark:text-zinc-200">labeler</strong> and sees the assets you assign to them.</p>
        </div>
        <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800"><X aria-hidden="true" size={16} /></button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Expires after
          <select value={days} onChange={(event) => setDays(Number(event.target.value))} className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
            {EXPIRY_OPTIONS.map((option) => <option key={option.days} value={option.days}>{option.label}</option>)}
          </select>
        </label>
        <label className="block text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">Can be used by
          <select value={maxUses ?? ""} onChange={(event) => setMaxUses(event.target.value === "" ? null : Number(event.target.value))} className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-2 py-2 text-xs text-zinc-800 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100">
            {USE_OPTIONS.map((option) => <option key={option.label} value={option.value ?? ""}>{option.label}</option>)}
          </select>
        </label>
      </div>
      <Button className="mt-3 w-full" size="sm" type="button" disabled={busy} onClick={() => void create()}>
        {busy ? <SpinnerGap aria-hidden="true" className="animate-spin" size={16} /> : <LinkSimple aria-hidden="true" size={16} />}{busy ? "Creating..." : "Create share link"}
      </Button>

      {created ? <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50 p-3 dark:border-sky-900 dark:bg-sky-950/40">
        <div className="flex gap-2">
          <input id="share-link-url" readOnly value={created} onFocus={(event) => event.currentTarget.select()} aria-label="Share link" className="min-w-0 flex-1 rounded-lg border border-sky-200 bg-white px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:border-sky-900 dark:bg-zinc-900 dark:text-zinc-200" />
          <Button type="button" size="sm" onClick={() => void copy()} aria-live="polite">{copied ? <Check aria-hidden="true" size={15} /> : <Copy aria-hidden="true" size={15} />}{copied ? "Copied" : "Copy"}</Button>
        </div>
        <p className="mt-2 text-[11px] text-sky-800 dark:text-sky-300">Copy it now &mdash; for security this link is shown only once.</p>
      </div> : null}

      {error ? <p role="alert" className="mt-3 text-xs text-rose-700 dark:text-rose-400">{error}</p> : null}

      <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <h3 className="text-[11px] font-bold uppercase tracking-[0.1em] text-zinc-400">Active links</h3>
        {links === null ? <p className="mt-2 text-xs text-zinc-400">Loading...</p> : active.length === 0 ? <p className="mt-2 text-xs text-zinc-400">No active links.</p> : <ul className="mt-2 space-y-1.5">
          {active.map((link) => <li key={link.id} className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-2.5 py-2 text-xs dark:bg-zinc-800/60">
            <span className="min-w-0 text-zinc-600 dark:text-zinc-300">Expires {relative(link.expiresAt)} <span className="text-zinc-400">&middot; {link.useCount}{link.maxUses ? `/${link.maxUses}` : ""} joined</span></span>
            <button type="button" onClick={() => void revoke(link.id)} className="shrink-0 font-semibold text-rose-700 hover:underline dark:text-rose-400">Revoke</button>
          </li>)}
        </ul>}
      </div>
    </div> : null}
  </div>;
}
