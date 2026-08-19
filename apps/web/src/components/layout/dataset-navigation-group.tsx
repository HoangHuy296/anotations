"use client";

import { CaretDown, Database, Folders, TrayArrowDown, UploadSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";

import { cn } from "@/lib/utils";

type DatasetNavigationGroupProps = { activePath: string };

/** Dataset creation is intentionally disclosed only after the parent group is active. */
export function DatasetNavigationGroup({ activePath }: DatasetNavigationGroupProps) {
  const isDatasetPath = activePath === "/datasets" || activePath.startsWith("/datasets/");
  const [expanded, setExpanded] = useState(isDatasetPath);
  const childLinkClass = (active: boolean) =>
    cn(
      "flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs font-semibold outline-none transition focus-visible:ring-2 focus-visible:ring-sky-400",
      active
        ? "bg-zinc-950 text-white"
        : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-950",
    );

  return (
    <div>
      <button
        aria-controls="dataset-navigation-actions"
        aria-expanded={expanded}
        className={cn(
          "flex min-h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm font-medium text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400",
        )}
        onClick={() => setExpanded((value) => !value)}
        type="button"
      >
        <Database aria-hidden="true" size={18} weight="regular" />
        <span className="flex-1">Datasets</span>
        <CaretDown aria-hidden="true" className={expanded ? "rotate-180 transition-transform" : "transition-transform"} size={14} weight="bold" />
      </button>
      {expanded ? (
        <div className="mt-1 space-y-1 pl-4" id="dataset-navigation-actions">
          <Link
            className={childLinkClass(activePath === "/datasets")}
            href="/datasets"
          >
            <Folders aria-hidden="true" size={15} />
            Browse datasets
          </Link>
          <Link
            className={childLinkClass(activePath === "/datasets/imports")}
            href="/datasets/imports"
          >
            <TrayArrowDown aria-hidden="true" size={15} />
            Imports
          </Link>
          <Link
            className={childLinkClass(activePath === "/datasets/local-folder")}
            href="/datasets/local-folder"
          >
            <UploadSimple aria-hidden="true" size={15} />
            Upload
          </Link>
        </div>
      ) : null}
    </div>
  );
}
