"use client";

import { GearSix, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

export function WorkspaceSettingsOverlay() {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeOverlay = () => { setOpen(false); triggerRef.current?.focus(); };
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") closeOverlay(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <button ref={triggerRef} type="button" aria-label="Settings" onClick={() => setOpen(true)} className="grid size-9 place-items-center rounded-lg text-zinc-600 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-500">
        <GearSix aria-hidden="true" size={17} />
      </button>
      {open ? (
        <div className="fixed inset-0 z-[100] bg-zinc-950/45 p-2 sm:p-6" onMouseDown={(event) => { if (event.target === event.currentTarget) closeOverlay(); }}>
          <section role="dialog" aria-modal="true" aria-label="Workspace settings" className="mx-auto flex h-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-zinc-200 px-4">
              <h2 className="text-sm font-semibold text-zinc-900">Settings</h2>
              <button ref={closeRef} type="button" aria-label="Close settings" onClick={closeOverlay} className="grid size-8 place-items-center rounded-lg text-zinc-500 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-500"><X aria-hidden="true" size={17} /></button>
            </div>
            <iframe title="Account settings" src="/account#account" className="min-h-0 flex-1 border-0" />
          </section>
        </div>
      ) : null}
    </>
  );
}
