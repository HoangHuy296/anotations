"use client";

import {
  ArrowLeft,
  CaretDown,
  CloudCheck,
  GearSix,
  UserCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAnnotationStore } from "@/stores/annotation-store";

type WorkspaceHeaderProps = {
  datasetName: string;
  branch: string;
  repositoryFullName: string;
  rootPath: string;
};

export function WorkspaceHeader({
  datasetName,
  branch,
  repositoryFullName,
  rootPath,
}: WorkspaceHeaderProps) {
  const saveStates = useAnnotationStore((store) => store.saveStates);
  const currentSaveStates = Object.values(saveStates);
  const conflict = currentSaveStates.includes("conflict") || currentSaveStates.includes("failed");
  const saving = currentSaveStates.includes("pending") || currentSaveStates.includes("saving");
  const saveLabel = conflict ? "Save needs attention" : saving ? "Saving changes" : "All changes saved";
  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-3 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Button asChild variant="icon" aria-label="Back to dashboard">
          <Link href="/dashboard">
            <ArrowLeft aria-hidden="true" size={18} />
          </Link>
        </Button>
        <span className="grid size-9 place-items-center rounded-xl bg-zinc-950 text-xs font-black tracking-tight text-white" aria-label="Fieldframe">FF</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-bold text-zinc-950">
              {datasetName}
            </h1>
            <Badge variant="info">{branch}</Badge>
            <Badge variant="neutral">Image</Badge>
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
        <Button type="button" variant="secondary" size="sm" aria-label="User menu is not available yet" disabled><UserCircle aria-hidden="true" size={17} />Account<CaretDown aria-hidden="true" size={13} weight="bold" /></Button>
      </div>
    </header>
  );
}
