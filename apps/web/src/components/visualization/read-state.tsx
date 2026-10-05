import { Button } from "@/components/ui/button";
export function ReadState({ error, retry }: { error?: string; retry: () => void }) {
  return <div className="py-12 text-center" role="status">{error ?? "Loading dataset…"}{error && <Button className="ml-3" variant="secondary" onClick={retry}>Retry read</Button>}</div>;
}
export function PageControls({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (value: number) => void }) {
  return <div className="mt-5 flex flex-wrap items-center justify-between gap-3 text-sm">
    <span>{total} records · Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</span>
    <div className="flex gap-2"><Button variant="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous page</Button><Button variant="secondary" disabled={page * pageSize >= total || page >= 10000} onClick={() => onPage(page + 1)}>Next page</Button></div>
  </div>;
}
