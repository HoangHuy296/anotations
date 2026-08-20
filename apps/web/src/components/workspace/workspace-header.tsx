"use client";

import {
  ArrowLeft,
  CaretDown,
  CloudCheck,
  GearSix,
  LockKey,
  UserCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Modality } from "@internal/db";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";

type WorkspaceHeaderProps = {
  datasetName: string;
  branch: string;
  repositoryFullName: string;
  rootPath: string;
  /** The active selection's engine, or `null` when no asset is selected (defaults to the IMAGE status fields). */
  engine: Modality | null;
  /** Signed-in actor, used to populate the account dropdown. `null` renders the trigger disabled. */
  actor: { email: string; name: string } | null;
};

/**
 * The shared status surface. Save/dirty/conflict display and the
 * "Connected" indicator are identical across engines; the modality badge
 * (and future per-engine fields — spec FR-037) come from
 * `workspaceEngineRegistry` (FR-041–FR-044).
 */
export function WorkspaceHeader({
  datasetName,
  branch,
  repositoryFullName,
  rootPath,
  engine,
  actor,
}: WorkspaceHeaderProps) {
  const { StatusFields } = workspaceEngineRegistry[engine ?? "IMAGE"];
  const saveStates = useAnnotationStore((store) => store.saveStates);
  const currentSaveStates = Object.values(saveStates);
  const conflict = currentSaveStates.includes("conflict") || currentSaveStates.includes("failed");
  const saving = currentSaveStates.includes("pending") || currentSaveStates.includes("saving");
  const saveLabel = conflict ? "Save needs attention" : saving ? "Saving changes" : "All changes saved";

  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-3 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Button asChild variant="icon" aria-label="Back to datasets">
          <Link href="/datasets">
            <ArrowLeft aria-hidden="true" size={18} />
          </Link>
        </Button>
        <span className="grid size-9 place-items-center rounded-xl bg-zinc-950 text-xs font-black tracking-tight text-white" aria-label="Annotation Platform">AP</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-bold text-zinc-950">
              {datasetName}
            </h1>
            <Badge variant="info">{branch}</Badge>
            <StatusFields />
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
            {repositoryFullName}
            {rootPath ? ` / ${rootPath}` : ""}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className={`hidden items-center gap-2 text-xs sm:flex ${conflict ? "text-rose-700" : "text-zinc-500"}`}>
          {conflict ? <WarningCircle aria-hidden="true" className="text-rose-600" size={17} weight="fill" /> : <CloudCheck
            aria-hidden="true"
            className="text-emerald-600"
            size={17}
            weight="fill"
          />}
          {saveLabel}
        </span>
        <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 md:inline-flex">Connected</span>
        <Button type="button" variant="icon" aria-label="Settings are not available yet" disabled><GearSix aria-hidden="true" size={17} /></Button>
        <AccountMenu actor={actor} />
      </div>
    </header>
  );
}

/**
 * Account dropdown for the workspace header — mirrors the dashboard's
 * `AvatarMenu` (same trigger/outside-click/escape pattern and destinations),
 * anchored to the header's "Account" button instead of an avatar.
 */
function AccountMenu({ actor }: { actor: { email: string; name: string } | null }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  if (!actor) {
    return (
      <Button type="button" variant="secondary" size="sm" aria-label="User menu is not available yet" disabled>
        <UserCircle aria-hidden="true" size={17} />Account<CaretDown aria-hidden="true" size={13} weight="bold" />
      </Button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label="Open account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <UserCircle aria-hidden="true" size={17} />Account<CaretDown aria-hidden="true" size={13} weight="bold" />
      </Button>
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
          <div className="mt-1 border-t border-zinc-100 px-1 pt-1"><SignOutButton className="w-full justify-start px-2 py-2 text-sm" /></div>
        </div>
      ) : null}
    </div>
  );
}
