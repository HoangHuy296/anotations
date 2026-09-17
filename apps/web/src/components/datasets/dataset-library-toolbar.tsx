"use client";

import { CaretDown, SlidersHorizontal, TrayArrowDown, UploadSimple, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { datasetLibraryHref, datasetStatusLabels } from "@/lib/datasets/dataset-library-query";
import type { DatasetLibraryQuery } from "@/types/dataset-library";

type Filters = Pick<DatasetLibraryQuery, "status" | "method">;
const selectClass = "h-10 w-full appearance-none rounded-xl border border-zinc-200 bg-white pl-3 pr-9 text-sm font-medium text-zinc-700 outline-none transition-colors hover:border-zinc-300 focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:border-zinc-600 dark:focus-visible:ring-sky-900";

export function DatasetLibraryToolbar({ status, method }: Filters) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const active = status !== "ALL" || method !== "ALL";
  function update(next: Partial<Filters>) {
    startTransition(() => router.push(datasetLibraryHref({ status, method, ...next }), { scroll: false }));
  }

  return <div className="flex flex-wrap items-end gap-3" aria-busy={pending}>
    <div className="flex flex-1 flex-wrap items-end gap-2 sm:flex-none">
      <SlidersHorizontal aria-hidden="true" size={18} className="mb-3 mr-1 hidden text-zinc-400 xl:block" />
      <label className="min-w-36 flex-1 sm:flex-none">
        <span className="mb-1.5 block text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">Status</span>
        <span className="relative block">
          <select aria-label="Filter by status" className={selectClass} disabled={pending} value={status} onChange={(event) => update({ status: event.target.value as Filters["status"] })}>
            <option value="ALL">All statuses</option>
            {Object.entries(datasetStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <CaretDown aria-hidden="true" className="pointer-events-none absolute right-3 top-3.5 text-zinc-400" size={13} />
        </span>
      </label>
      <label className="min-w-36 flex-1 sm:flex-none">
        <span className="mb-1.5 block text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">Creation method</span>
        <span className="relative block">
          <select aria-label="Filter by creation method" className={selectClass} disabled={pending} value={method} onChange={(event) => update({ method: event.target.value as Filters["method"] })}>
            <option value="ALL">All methods</option>
            <option value="UPLOAD">Upload</option>
            <option value="IMPORT">Import</option>
          </select>
          <CaretDown aria-hidden="true" className="pointer-events-none absolute right-3 top-3.5 text-zinc-400" size={13} />
        </span>
      </label>
      {active ? <Button variant="ghost" aria-label="Clear dataset filters" disabled={pending} onClick={() => update({ status: "ALL", method: "ALL" })}><X size={15} /> <span className="sm:sr-only">Clear</span></Button> : null}
    </div>
    <div className="flex items-center gap-2 sm:border-l sm:border-zinc-200 sm:pl-3 dark:sm:border-zinc-800">
      <Button asChild variant="secondary"><Link href="/datasets/local-folder"><UploadSimple aria-hidden="true" size={16} />Upload</Link></Button>
      <Button asChild><Link href="/datasets/imports"><TrayArrowDown aria-hidden="true" size={16} />Import dataset</Link></Button>
    </div>
    <span className="sr-only" role="status">{pending ? "Updating datasets…" : ""}</span>
  </div>;
}
