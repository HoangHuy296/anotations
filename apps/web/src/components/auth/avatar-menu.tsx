"use client";

import { CaretDown, Gear, LockKey, UserCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { SignOutButton } from "@/components/auth/sign-out-button";

type AvatarMenuProps = {
  actor: { email: string; name: string; role: string };
};

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "OP";
}

export function AvatarMenu({ actor }: AvatarMenuProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function closeOnOutsideClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        aria-label="Open account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
        className="flex size-9 items-center justify-center gap-0.5 rounded-xl bg-sky-100 text-xs font-bold text-sky-800 outline-none transition-colors hover:bg-sky-200 focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2"
      >
        {initials(actor.name)}
        <CaretDown aria-hidden="true" size={11} weight="bold" />
      </button>
      {open ? (
        <div role="menu" aria-label="Account menu" className="absolute right-0 z-30 mt-2 w-60 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl shadow-zinc-900/10">
          <div className="border-b border-zinc-100 px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-zinc-900">{actor.name}</p>
            <p className="mt-0.5 truncate text-xs text-zinc-500">{actor.email}</p>
          </div>
          <Link role="menuitem" href="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none">
            <UserCircle aria-hidden="true" size={17} /> Personal information
          </Link>
          <Link role="menuitem" href="/account/password" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none">
            <LockKey aria-hidden="true" size={17} /> Change password
          </Link>
          <Link role="menuitem" href="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none">
            <Gear aria-hidden="true" size={17} /> Account settings
          </Link>
          <div className="mt-1 border-t border-zinc-100 px-1 pt-1"><SignOutButton className="w-full justify-start px-2 py-2 text-sm" /></div>
        </div>
      ) : null}
    </div>
  );
}
