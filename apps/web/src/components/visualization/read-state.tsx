import { CaretLeft, CaretRight, WarningCircle } from "@phosphor-icons/react/dist/ssr";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ReadState({ error, retry }: { error?: string; retry: () => void }) {
  if (error) return <div className="flex min-h-64 flex-col items-center justify-center gap-3 px-6 py-10 text-center" role="alert">
    <WarningCircle aria-hidden="true" size={25} className="text-zinc-400" />
    <p className="text-sm text-zinc-600 dark:text-zinc-400">{error}</p>
    <Button size="sm" variant="secondary" onClick={retry}>Retry read</Button>
  </div>;
  return <div className="px-4 py-5" role="status" aria-label="Loading dataset">
    <span className="sr-only">Loading dataset…</span>
    <div aria-hidden="true" className="space-y-3 motion-safe:animate-pulse">{Array.from({ length: 6 }, (_, index) => <div key={index} className="flex items-center gap-4 border-b border-zinc-100 pb-3 dark:border-zinc-800">
      <div className="h-12 w-20 shrink-0 rounded bg-zinc-100 dark:bg-zinc-800" />
      <div className="h-2 flex-1 rounded bg-zinc-100 dark:bg-zinc-800" />
      <div className="h-2 w-16 rounded bg-zinc-100 dark:bg-zinc-800" />
    </div>)}</div>
  </div>;
}

export function PageControls({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (value: number) => void }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const lastPage = Math.min(10000, totalPages);
  const pages = [...new Set([1, page - 1, page, page + 1, lastPage].filter(value => value >= 1 && value <= lastPage))].sort((a, b) => a - b);
  const start = total === 0 || (page - 1) * pageSize >= total ? 0 : (page - 1) * pageSize + 1;
  const end = start === 0 ? 0 : Math.min(page * pageSize, total);
  return <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-200 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900/40">
    <p className="font-mono text-[10px] text-zinc-500" role="status">{start.toLocaleString()}–{end.toLocaleString()} of {total.toLocaleString()} records<span className="sr-only"> · Page {page} of {totalPages}</span></p>
    <nav aria-label="Record pages" className="flex items-center gap-1">
      <Button variant="ghost" size="sm" className="h-7 min-h-7 gap-1 rounded px-1.5 font-normal" disabled={page <= 1} aria-label="Previous page" onClick={() => onPage(page - 1)}><CaretLeft aria-hidden="true" size={12} /><span className="hidden sm:inline">Previous</span></Button>
      {pages.map((value, index) => <span key={value} className="inline-flex items-center gap-1">
        {index > 0 && value - pages[index - 1] > 1 && <span className="px-1 text-xs text-zinc-400" aria-hidden="true">…</span>}
        <Button variant="ghost" size="sm" className={cn("h-7 min-h-7 min-w-7 rounded px-1.5 font-mono font-normal", page === value && "bg-zinc-200/60 text-zinc-950 dark:bg-zinc-800 dark:text-zinc-100")} aria-label={`Page ${value}`} aria-current={page === value ? "page" : undefined} disabled={page === value} onClick={() => onPage(value)}>{value}</Button>
      </span>)}
      <Button variant="ghost" size="sm" className="h-7 min-h-7 gap-1 rounded px-1.5 font-normal" disabled={page * pageSize >= total || page >= 10000} aria-label="Next page" onClick={() => onPage(page + 1)}><span className="hidden sm:inline">Next</span><CaretRight aria-hidden="true" size={12} /></Button>
    </nav>
    {page >= 10000 && totalPages > 10000 && <p className="w-full text-xs text-zinc-500">Narrow your search to browse records beyond the first 10,000 pages.</p>}
  </div>;
}
