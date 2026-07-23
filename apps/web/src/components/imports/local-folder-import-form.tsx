"use client";

import { CheckCircle, CloudArrowUp, File, FolderOpen, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import Link from "next/link";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";

type Prepared = { id: string; datasetId: string; jobId: string; items: { id: string }[] };
type Capability = { itemId: string; fileId: string; uploadUrl: string; formFields: Record<string, string> };
type FileEntry = { file: File; logicalPath: string; fingerprint: string };
type ImportStep = "idle" | "scanning" | "preparing" | "uploading" | "ready" | "failed";

async function fingerprint(file: File) {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${Math.round(value / 1_024)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function safeMessage(payload: unknown, fallback: string) {
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.length <= 180 ? message : fallback;
}

/** Browser-only folder scan. Relative names are used for the manifest; no local handle or absolute path leaves the browser. */
type LocalFolderImportFormProps = {
  /** When supplied, files are appended to this authorized Dataset instead of creating one. */
  datasetId?: string;
  datasetName?: string;
  onClose?: () => void;
};

export function LocalFolderImportForm({ datasetId, datasetName, onClose }: LocalFolderImportFormProps = {}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [name, setName] = useState("");
  const [step, setStep] = useState<ImportStep>("idle");
  const [completed, setCompleted] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const appendMode = Boolean(datasetId);
  const totalBytes = files.reduce((total, entry) => total + entry.file.size, 0);
  const busy = ["scanning", "preparing", "uploading"].includes(step);
  const uploadPercent = files.length ? Math.round((completed / files.length) * 100) : 0;

  async function scan() {
    const selected = Array.from(inputRef.current?.files ?? []);
    setStep("scanning"); setMessage(null); setCompleted(0); setJobId(null);
    try {
      const entries = await Promise.all(selected.map(async (file) => ({ file, logicalPath: file.webkitRelativePath || file.name, fingerprint: await fingerprint(file) })));
      setFiles(entries);
      if (!appendMode && !name && entries.length) setName(entries[0]?.logicalPath.split("/")[0] ?? "Local folder");
      setStep("idle");
    } catch {
      setStep("failed"); setMessage("The selected folder could not be scanned. Choose it again and retry.");
    }
  }

  async function submit() {
    if ((!appendMode && !name.trim()) || !files.length) return;
    setStep("preparing"); setMessage(null); setCompleted(0); setJobId(null);
    try {
      const started = await fetch(appendMode ? `/api/datasets/${datasetId}/imports/local-folder` : "/api/imports/local-folder", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ ...(appendMode ? {} : { name: name.trim() }), idempotencyKey: crypto.randomUUID() + crypto.randomUUID(), items: files.map(({ file, logicalPath, fingerprint }) => ({ logicalPath, contentType: file.type || "text/plain", sizeBytes: file.size, fingerprint })) }),
      });
      const startBody = await started.json().catch(() => null);
      if (!started.ok) throw new Error(safeMessage(startBody, "Could not prepare this import."));
      const preparation = (startBody as { data: { preparation: Prepared } }).data.preparation;
      if (preparation.items.length !== files.length) throw new Error("The prepared file count did not match the browser scan.");
      setJobId(preparation.jobId); setStep("uploading");

      const capabilityResponse = await fetch(`/api/imports/${preparation.id}/upload-capabilities`, {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ itemIds: preparation.items.map((item) => item.id) }),
      });
      const capabilityBody = await capabilityResponse.json().catch(() => null);
      if (!capabilityResponse.ok) throw new Error(safeMessage(capabilityBody, "Could not prepare secure upload forms."));
      const capabilities = (capabilityBody as { data: { capabilities: Capability[] } }).data.capabilities;
      if (capabilities.length !== files.length) throw new Error("The upload preparation is incomplete. Retry the import.");

      for (let index = 0; index < files.length; index += 1) {
        const capability = capabilities[index]!;
        const form = new FormData();
        Object.entries(capability.formFields).forEach(([key, value]) => form.append(key, value));
        form.append("file", files[index]!.file);
        const upload = await fetch(capability.uploadUrl, { method: "POST", body: form });
        if (!upload.ok) throw new Error("A file upload was rejected. No dataset has been committed.");
        const completedResponse = await fetch(`/api/imports/${preparation.id}/items/${capability.itemId}/complete`, {
          method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ fileId: capability.fileId }),
        });
        if (!completedResponse.ok) throw new Error("An uploaded file could not be verified. No dataset has been committed.");
        setCompleted(index + 1);
      }
      setStep("ready"); setMessage("Every file is verified. Review the durable job and commit the import when ready.");
    } catch (error) {
      setStep("failed"); setMessage(error instanceof Error ? error.message : "The import could not be completed.");
    }
  }

  return <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:py-12">
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section className="min-w-0">
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-sky-700">Direct local import</p>
        <h1 className="mt-3 max-w-2xl text-4xl font-bold tracking-[-0.05em] text-zinc-950 sm:text-5xl">{appendMode ? `Add a folder to ${datasetName ?? "this Dataset"}.` : "Bring a folder into a new Dataset."}</h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-500">Your browser scans files, uploads each binary through one scoped temporary form, and waits for your explicit commit before the import becomes terminal.</p>

        {!appendMode && <div className="mt-9 border-y border-zinc-200 py-6">
          <label className="block text-sm font-semibold text-zinc-900">Dataset name<input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} placeholder="e.g. North junction survey" className="mt-2 h-11 w-full rounded-xl border border-zinc-300 px-3 text-sm outline-none transition focus:border-sky-600 focus:ring-2 focus:ring-sky-100 disabled:bg-zinc-50" /></label>
          <p className="mt-2 text-xs leading-5 text-zinc-500">A Dataset is created only after the server authorizes this import. Local absolute paths are never sent.</p>
        </div>}

        <input ref={inputRef} type="file" multiple onChange={() => void scan()} className="sr-only" {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="mt-6 flex w-full items-center justify-between rounded-2xl border border-dashed border-zinc-300 bg-zinc-50 p-5 text-left transition hover:border-sky-400 hover:bg-sky-50 disabled:opacity-50"><span className="flex items-center gap-4"><span className="grid size-12 place-items-center rounded-xl bg-white text-sky-700 shadow-sm"><FolderOpen size={24} weight="duotone" /></span><span><span className="block text-sm font-bold text-zinc-900">Choose a local folder</span><span className="mt-1 block text-xs text-zinc-500">The browser reads files only after you select them.</span></span></span><span className="text-xs font-semibold text-sky-700">Browse</span></button>

        {files.length > 0 && <div className="mt-6"><div className="flex items-end justify-between gap-4"><div><h2 className="text-sm font-bold text-zinc-900">Folder manifest</h2><p className="mt-1 text-xs text-zinc-500">{files.length} files · {formatBytes(totalBytes)}</p></div><span className="text-xs font-medium text-zinc-500">Relative paths only</span></div><ul className="mt-3 divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white">{files.slice(0, 8).map((entry) => <li key={`${entry.logicalPath}-${entry.file.size}`} className="flex items-center gap-3 px-3 py-2.5"><File size={16} className="shrink-0 text-zinc-400" /><span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-700">{entry.logicalPath}</span><span className="shrink-0 font-mono text-[11px] text-zinc-400">{formatBytes(entry.file.size)}</span></li>)}{files.length > 8 && <li className="px-3 py-2.5 text-xs text-zinc-500">+ {files.length - 8} additional files</li>}</ul></div>}

        {step === "uploading" && <div className="mt-6 rounded-2xl border border-sky-100 bg-sky-50 p-4"><div className="flex items-center justify-between text-sm font-semibold text-sky-950"><span>Uploading and verifying</span><span>{completed} / {files.length}</span></div><div className="mt-3 h-2 overflow-hidden rounded-full bg-sky-100"><div className="h-full rounded-full bg-sky-600 transition-[width] duration-300" style={{ width: `${uploadPercent}%` }} /></div><p className="mt-2 text-xs text-sky-800">Each completed item is reconciled before the next file proceeds.</p></div>}
        {message && <div role={step === "failed" ? "alert" : "status"} className={`mt-6 flex gap-3 rounded-xl border p-4 text-sm ${step === "failed" ? "border-rose-200 bg-rose-50 text-rose-900" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>{step === "failed" ? <WarningCircle size={19} className="shrink-0" /> : <CheckCircle size={19} className="shrink-0" weight="fill" />}<p>{message}</p></div>}

        <div className="mt-7 flex flex-wrap gap-3"><Button type="button" disabled={busy || files.length === 0 || (!appendMode && !name.trim())} onClick={() => void submit()}>{busy ? <><SpinnerGap className="animate-spin" size={17} />{step === "scanning" ? "Scanning folder…" : step === "preparing" ? "Preparing import…" : "Uploading files…"}</> : <><CloudArrowUp size={18} weight="bold" />{appendMode ? "Add folder" : "Upload folder"}</>}</Button>{jobId && <Button asChild variant="secondary"><Link href={`/jobs/${jobId}`}>Open import job</Link></Button>}{onClose && <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>Close</Button>}</div>
      </section>
      <aside className="h-fit border-t border-zinc-200 pt-6 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0"><p className="text-xs font-bold uppercase tracking-[0.16em] text-zinc-400">Import lifecycle</p><ol className="mt-5 space-y-5">{[["1", "Scan", "Browser prepares a relative-path manifest."], ["2", "Transfer", "Files go directly to private storage through scoped forms."], ["3", "Verify", "Server reconciles each upload into metadata."], ["4", "Commit", "You confirm completion from the durable Job screen."]].map(([number, title, description]) => <li key={number} className="grid grid-cols-[28px_1fr] gap-3"><span className="grid size-7 place-items-center rounded-full border border-zinc-200 font-mono text-[11px] text-zinc-500">{number}</span><div><p className="text-sm font-semibold text-zinc-900">{title}</p><p className="mt-1 text-xs leading-5 text-zinc-500">{description}</p></div></li>)}</ol></aside>
    </div>
  </div>;
}

/** A focusable in-workspace dialog; its upload behavior is identical to local import. */
export function WorkspaceAppendFolderDialog({ datasetId, datasetName, onClose }: Required<Pick<LocalFolderImportFormProps, "datasetId">> & LocalFolderImportFormProps) {
  return <div role="dialog" aria-modal="true" aria-label="Add folder to dataset" className="fixed inset-0 z-50 overflow-y-auto bg-zinc-950/40 p-4 sm:p-8">
    <div className="mx-auto min-h-full max-w-6xl rounded-2xl bg-white shadow-2xl"><LocalFolderImportForm datasetId={datasetId} datasetName={datasetName} onClose={onClose} /></div>
  </div>;
}
