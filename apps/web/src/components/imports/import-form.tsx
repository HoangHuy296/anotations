"use client";

import { ArrowRight, CheckCircle, Eye, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

type Visibility = "PUBLIC" | "PRIVATE";

type ImportPreview = {
  mode: "preview";
  readyForPersistence: boolean;
  repository: { fullName: string; defaultBranch: string; private: boolean };
  visibility: { expected: Visibility | null; actual: Visibility; matches: boolean };
  dataset: { name: string; branch: string; rootPath: string; primaryModality: "IMAGE" | null };
  summary: { imageCount: number; totalBytes: number; treeTruncated: boolean; importLimit: number };
  images: Array<{ path: string; mimeType: string; size: number | null }>;
  imagePreviewTruncated: boolean;
};

type ApiEnvelope<T> = { data?: T; error?: { message?: string; fieldErrors?: Record<string, string[]> } };

const inputClassName = "mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition-[border-color,box-shadow] placeholder:text-zinc-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:bg-zinc-100";

export function ImportForm({ connections }: { connections: Array<{ id: string; name: string | null }> }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState<"settings" | "preview">("settings");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastPayload, setLastPayload] = useState<Record<string, string> | null>(null);

  function submit(mode: "preview" | "persist", payload: Record<string, string>) {
    setMessage(null);
    startTransition(() => {
      void fetch("/api/gitea/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, mode }),
      })
        .then(async (response) => {
          const body = (await response.json()) as ApiEnvelope<ImportPreview | { mode: "persisted"; datasetId: string }>;
          if (!response.ok || !body.data) {
            const fieldMessage = body.error?.fieldErrors ? Object.values(body.error.fieldErrors).flat()[0] : null;
            throw new Error(fieldMessage ?? body.error?.message ?? "Import failed.");
          }
          return body.data;
        })
        .then((data) => {
          if (data.mode === "persisted") {
            router.push(`/workspace/${data.datasetId}`);
            router.refresh();
            return;
          }
          setPreview(data);
          setLastPayload(payload);
          setActiveTab("preview");
          setMessage(data.readyForPersistence ? "Preview complete. This dataset is ready to import." : "Preview complete, but this selection cannot be imported yet.");
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Import failed."));
    });
  }

  function handlePreview(formData: FormData) {
    const payload = {
      sourceConnectionId: String(formData.get("sourceConnectionId") ?? ""),
      owner: String(formData.get("owner") ?? ""),
      repo: String(formData.get("repo") ?? ""),
      branch: String(formData.get("branch") ?? ""),
      rootPath: String(formData.get("rootPath") ?? ""),
      name: String(formData.get("name") ?? ""),
      expectedVisibility: String(formData.get("expectedVisibility") ?? "PUBLIC"),
      primaryModality: "IMAGE",
    };
    setPreview(null);
    setLastPayload(payload);
    submit("preview", payload);
  }

  return (
    <div className="max-w-5xl">
      <div className="flex gap-1 border-b border-zinc-200" role="tablist" aria-label="Repository import steps">
        <Tab active={activeTab === "settings"} id="import-settings" label="Settings" onClick={() => setActiveTab("settings")} panelId="import-settings-panel" />
        <Tab active={activeTab === "preview"} disabled={!preview} id="import-preview" label="Import Preview" onClick={() => setActiveTab("preview")} panelId="import-preview-panel" />
      </div>

      {activeTab === "settings" ? (
        <form action={handlePreview} className="mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:p-6" id="import-settings-panel" role="tabpanel" aria-labelledby="import-settings">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Repository settings</p>
              <p className="mt-2 text-sm leading-6 text-zinc-500">Fieldframe uses your existing Gitea connection only. Credentials stay on the server.</p>
            </div>
            <span className="rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700">Provider: Gitea</span>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Source connection">
              <select className={inputClassName} defaultValue={lastPayload?.sourceConnectionId} disabled={isPending} name="sourceConnectionId" required>
                <option value="">Select your active Gitea connection</option>
                {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name ?? "Gitea connection"}</option>)}
              </select>
            </Field>
            <fieldset>
              <legend className="text-xs font-semibold text-zinc-700">Expected repository visibility</legend>
              <div className="mt-2 grid h-10 grid-cols-2 rounded-xl border border-zinc-200 bg-white p-1">
                {(["PUBLIC", "PRIVATE"] as const).map((visibility) => (
                  <label key={visibility} className="grid cursor-pointer place-items-center rounded-lg has-[:checked]:bg-zinc-950 has-[:checked]:text-white">
                    <input className="sr-only" defaultChecked={(lastPayload?.expectedVisibility ?? "PUBLIC") === visibility} disabled={isPending} name="expectedVisibility" type="radio" value={visibility} />
                    <span className="text-xs font-semibold">{visibility === "PUBLIC" ? "Public" : "Private"}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Owner"><input className={inputClassName} defaultValue={lastPayload?.owner} disabled={isPending} name="owner" placeholder="vision-lab" required /></Field>
            <Field label="Repository"><input className={inputClassName} defaultValue={lastPayload?.repo} disabled={isPending} name="repo" placeholder="training-images" required /></Field>
            <Field label="Ref"><input className={inputClassName} defaultValue={lastPayload?.branch ?? "main"} disabled={isPending} name="branch" placeholder="main" required /></Field>
            <Field label="Root path"><input className={inputClassName} defaultValue={lastPayload?.rootPath} disabled={isPending} name="rootPath" placeholder="images/urban" /></Field>
          </div>
          <div className="mt-4 max-w-xl"><Field label="Dataset name"><input className={inputClassName} defaultValue={lastPayload?.name} disabled={isPending} name="name" placeholder="street-scenes-q2" required /></Field></div>
          <Button className="mt-6" disabled={isPending || connections.length === 0} type="submit">
            {isPending ? <SpinnerGap className="animate-spin" aria-hidden="true" size={17} /> : <Eye aria-hidden="true" size={17} />}
            {isPending ? "Checking repository..." : "Preview import"}
          </Button>
          {connections.length === 0 && <p className="mt-3 text-xs text-amber-700">Add an active Gitea source connection before creating an import preview.</p>}
        </form>
      ) : (
        <section className="mt-6 min-h-96 rounded-2xl border border-zinc-200 bg-white p-5 lg:p-6" id="import-preview-panel" role="tabpanel" aria-labelledby="import-preview">
          {preview && <Preview preview={preview} isPending={isPending} message={message} onImport={() => lastPayload && submit("persist", lastPayload)} />}
        </section>
      )}
    </div>
  );
}

function Preview({ preview, isPending, message, onImport }: { preview: ImportPreview; isPending: boolean; message: string | null; onImport: () => void }) {
  const hasVisibilityMismatch = !preview.visibility.matches;
  return <>
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Resolved repository</p><h2 className="mt-2 text-lg font-bold text-zinc-950">{preview.repository.fullName}</h2><p className="mt-1 font-mono text-xs text-zinc-500">ref {preview.dataset.branch} · {preview.dataset.rootPath || "/"} · {preview.visibility.actual === "PRIVATE" ? "Private" : "Public"} · {preview.visibility.expected ? `expected ${preview.visibility.expected.toLowerCase()}` : "visibility not specified"}</p></div>
      {preview.readyForPersistence ? <CheckCircle aria-hidden="true" className="text-emerald-600" size={24} weight="fill" /> : <WarningCircle aria-hidden="true" className="text-amber-600" size={24} weight="fill" />}
    </div>
    {hasVisibilityMismatch && <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">Gitea reports this repository as <strong>{preview.visibility.actual.toLowerCase()}</strong>, which does not match your expected visibility. Return to Settings and correct the selection before importing.</div>}
    <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200"><Metric label="Images" value={String(preview.summary.imageCount)} /><Metric label="Source bytes" value={formatBytes(preview.summary.totalBytes)} /></div>
    <div className="mt-5 max-h-64 overflow-y-auto border-y border-zinc-200">
      {preview.images.map((image) => <div key={image.path} className="flex items-center justify-between gap-4 border-b border-zinc-100 py-2.5 text-xs last:border-b-0"><span className="truncate font-medium text-zinc-700">{image.path}</span><span className="shrink-0 font-mono text-[10px] text-zinc-400">{image.mimeType}</span></div>)}
    </div>
    {preview.imagePreviewTruncated && <p className="mt-3 text-xs text-zinc-500">Showing the first 100 supported files.</p>}
    <Button className="mt-5 w-full" disabled={!preview.readyForPersistence || isPending} onClick={onImport} type="button">Import {preview.summary.imageCount} images <ArrowRight aria-hidden="true" size={17} /></Button>
    <p className={`mt-4 text-xs leading-5 ${preview.readyForPersistence ? "text-emerald-700" : "text-rose-700"}`} aria-live="polite">{message}</p>
  </>;
}

function Tab({ active, disabled, id, label, onClick, panelId }: { active: boolean; disabled?: boolean; id: string; label: string; onClick: () => void; panelId: string }) {
  return <button aria-controls={panelId} aria-selected={active} className={`border-b-2 px-4 py-3 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-400 ${active ? "border-zinc-950 text-zinc-950" : "border-transparent text-zinc-500 hover:text-zinc-900"}`} disabled={disabled} id={id} onClick={onClick} role="tab" type="button">{label}</button>;
}
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="text-xs font-semibold text-zinc-700">{label}</span>{children}</label>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="bg-zinc-50 p-4"><p className="text-[11px] font-medium text-zinc-400">{label}</p><p className="mt-2 font-mono text-xl font-semibold text-zinc-950">{value}</p></div>; }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
