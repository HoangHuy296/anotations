"use client";

import { CaretDown, Database, TrayArrowDown, UploadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/** A compact disclosure for creation choices; global navigation remains a link. */
export function DatasetActionMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="relative" ref={rootRef}>
      <Button
        aria-controls="dashboard-dataset-actions"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        size="lg"
        type="button"
      >
        <Database aria-hidden="true" size={18} />
        Datasets
        <CaretDown aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"} size={15} />
      </Button>
      {open ? (
        <div
          className="absolute right-0 z-20 mt-2 w-64 rounded-2xl border border-zinc-200 bg-white p-2 shadow-[0_20px_45px_-24px_rgba(24,24,27,0.35)]"
          id="dashboard-dataset-actions"
          role="menu"
        >
          <Link
            className="flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-zinc-800 outline-none transition hover:bg-sky-50 hover:text-sky-800 focus-visible:ring-2 focus-visible:ring-sky-400"
            href="/datasets/imports"
            onClick={() => setOpen(false)}
            role="menuitem"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-sky-50 text-sky-700"><TrayArrowDown aria-hidden="true" size={17} /></span>
            <span><span className="block">Import</span><span className="mt-0.5 block text-xs font-normal text-zinc-500">Repository-backed dataset</span></span>
          </Link>
          <Link
            className="mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-semibold text-zinc-800 outline-none transition hover:bg-sky-50 hover:text-sky-800 focus-visible:ring-2 focus-visible:ring-sky-400"
            href="/datasets/new/local-folder"
            onClick={() => setOpen(false)}
            role="menuitem"
          >
            <span className="grid size-9 place-items-center rounded-lg bg-emerald-50 text-emerald-700"><UploadSimple aria-hidden="true" size={17} /></span>
            <span><span className="block">Upload</span><span className="mt-0.5 block text-xs font-normal text-zinc-500">Local folder dataset</span></span>
          </Link>
        </div>
      ) : null}
    </div>
  );
}
