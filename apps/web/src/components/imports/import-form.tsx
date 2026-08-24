"use client";

import { ArrowRight, CheckCircle, Eye, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { randomUUIDAuto } from "@/lib/browser-random-uuid";

type Visibility = "PUBLIC" | "PRIVATE";
type CredentialMode = "PUBLIC" | "EXISTING_SOURCE_CONNECTION" | "ONE_TIME_PAT";

type ImportPreview = {
  readyForImport: boolean;
  repository: { provider: "GITEA"; fullName: string; ref: string; revision: string | null; rootPath: string | null; visibility: Visibility };
  assetPreview: { detectedAssetCount: number; detectedBytes: number; truncated: boolean; sample: Array<{ path: string; size: number | null; modality: "IMAGE" | "VIDEO" | "AUDIO" | "TEXT" }> } | null;
  availableRefs: string[];
  availableCommits: Array<{ sha: string; message: string }>;
  visibility: { expected: Visibility; actual: Visibility; matches: boolean };
};
type ApiEnvelope<T> = { data?: T; error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } };
const inputClassName = "mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition-[border-color,box-shadow] placeholder:text-zinc-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:bg-zinc-100";

function value(form: FormData, name: string) {
  const item = form.get(name);
  return typeof item === "string" ? item.trim() : "";
}

/** Build a request just-in-time. The PAT remains in the password input DOM and
 * is never saved in React state, preview state, localStorage, or a DTO. */
function requestFromForm(form: FormData, credentialMode: CredentialMode) {
  const request: Record<string, unknown> = {
    provider: "GITEA",
    datasetName: value(form, "datasetName"),
    credentialMode,
    repository: {
      owner: value(form, "owner"),
      repo: value(form, "repo"),
      ref: value(form, "ref"),
      commit: value(form, "commit") || undefined,
      rootPath: value(form, "rootPath") || undefined,
      expectedVisibility: value(form, "expectedVisibility") || "PUBLIC",
    },
  };
  if (credentialMode === "PUBLIC") request.serverUrl = value(form, "serverUrl");
  if (credentialMode === "EXISTING_SOURCE_CONNECTION") request.sourceConnectionId = value(form, "sourceConnectionId");
  if (credentialMode === "ONE_TIME_PAT") {
    request.serverUrl = value(form, "serverUrl");
    request.personalAccessToken = value(form, "personalAccessToken");
    request.saveAsSourceConnection = form.get("saveAsSourceConnection") === "on";
    request.connectionName = value(form, "connectionName") || undefined;
  }
  return request;
}

export function ImportForm({ connections, giteaServerUrl }: { connections: Array<{ id: string; name: string | null }>; giteaServerUrl?: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const importIdempotencyKeyRef = useRef<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [activeTab, setActiveTab] = useState<"settings" | "preview">("settings");
  const [mode, setMode] = useState<CredentialMode>(connections.length ? "EXISTING_SOURCE_CONNECTION" : "PUBLIC");
  const [saveOneTimeConnection, setSaveOneTimeConnection] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedRef, setSelectedRef] = useState("main");
  // "" means no commit is pinned -- the branch tip of `selectedRef` is used.
  // Set only when the user explicitly picks a commit from the list. Kept as
  // a field separate from `selectedRef` end-to-end (form, request, response)
  // so the branch stays the stable display/list anchor while a commit pin
  // only narrows what gets resolved.
  const [selectedCommit, setSelectedCommit] = useState("");

  function request(endpoint: string, payload: Record<string, unknown>) {
    return fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
      .then(async (response) => {
        const body = (await response.json()) as ApiEnvelope<ImportPreview | { dataset: { id: string }; job: { id: string } }>;
        if (!response.ok || !body.data) {
          const fieldMessage = body.error?.fieldErrors ? Object.values(body.error.fieldErrors).flat()[0] : null;
          throw new Error(fieldMessage ?? body.error?.message ?? "Repository import failed.");
        }
        return body.data;
      });
  }

  function previewImport(event: FormEvent<HTMLFormElement>) {
    // React 19 resets uncontrolled fields after a successful `<form action>`
    // callback. Import Preview must retain the original values because Start
    // Import revalidates the same request after the user changes tabs.
    event.preventDefault();
    setMessage(null);
    setPreview(null);
    const payload = requestFromForm(new FormData(event.currentTarget), mode);
    startTransition(() => {
      void request("/api/source-import-preflight", payload)
        .then((data) => {
          const next = data as ImportPreview;
          importIdempotencyKeyRef.current = null;
          setPreview(next);
          setActiveTab("preview");
          setMessage(next.readyForImport ? "Repository access verified. Start Import will validate it again before creating work." : "Repository visibility does not match the selected expectation.");
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Repository preflight failed."));
    });
  }

  function previewSelectedRef(refOverride?: string) {
    if (!formRef.current) return;
    const ref = (refOverride ?? selectedRef).trim();
    if (!ref) {
      setMessage("Enter a branch or ref before loading it.");
      return;
    }
    const form = new FormData(formRef.current);
    form.set("ref", ref);
    // A newly chosen branch drops any commit pinned on the previous branch --
    // its commit list no longer applies. The hidden "commit" input still
    // holds the stale value at this point in the render, so clear it in the
    // outgoing snapshot explicitly rather than relying on the next render.
    form.set("commit", "");
    setMessage(null);
    setSelectedCommit("");
    startTransition(() => {
      void request("/api/source-import-preflight", requestFromForm(form, mode))
        .then((data) => {
          const next = data as ImportPreview;
          setPreview(next);
          setSelectedRef(next.repository.ref);
          importIdempotencyKeyRef.current = null;
          setMessage(next.readyForImport ? "The selected ref is available and the repository preview has been refreshed." : "Repository visibility does not match the selected expectation.");
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The selected ref could not be previewed."));
    });
  }

  function previewSelectedCommit(sha: string) {
    if (!formRef.current) return;
    const commit = sha.trim();
    if (!commit) {
      // Clearing the pin re-previews the branch tip already selected above.
      setSelectedCommit("");
      previewSelectedRef(selectedRef);
      return;
    }
    const form = new FormData(formRef.current);
    // `ref` (the branch) is left untouched -- only the pinned commit changes.
    form.set("commit", commit);
    setMessage(null);
    startTransition(() => {
      void request("/api/source-import-preflight", requestFromForm(form, mode))
        .then((data) => {
          const next = data as ImportPreview;
          setPreview(next);
          setSelectedCommit(commit);
          importIdempotencyKeyRef.current = null;
          setMessage(next.readyForImport ? "The selected commit is available and the repository preview has been refreshed." : "Repository visibility does not match the selected expectation.");
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The selected commit could not be previewed."));
    });
  }

  function startImport() {
    if (!formRef.current || !preview) return;
    // The Settings form stays mounted but is visually hidden on Preview.
    // Use the controlled mode state rather than relying on hidden radio input
    // serialization when Start Import constructs the durable request.
    const requestPayload = requestFromForm(new FormData(formRef.current), mode);
    const previewRepository = requestPayload.repository as { repo: string; ref: string; commit?: string; [key: string]: unknown };
    const { repo, commit, ref, ...repository } = previewRepository;
    const payload = {
      ...requestPayload,
      // The Phase-014 preview contract names the repository segment `repo`
      // and carries `ref`/`commit` as two fields. The sole Phase-015 durable
      // contract names it `name` and accepts a single `ref`; translate only
      // at this UI adapter boundary rather than retaining a second API route.
      // A pinned commit takes the exact commit Preview most recently
      // verified; otherwise the branch tip is imported.
      repository: { ...repository, name: repo, ref: commit || ref },
      // Retain this key for a failed-network retry of the same preview. The
      // server computes its request hash and remains the idempotency authority.
      idempotencyKey: importIdempotencyKeyRef.current ??= randomUUIDAuto(),
    };
    if (mode === "ONE_TIME_PAT" && requestPayload.saveAsSourceConnection !== true) {
      setMessage("Save the one-time PAT as a source connection before starting an asynchronous import.");
      return;
    }
    setMessage(null);
    startTransition(() => {
      void request("/api/datasets/from-repository", payload)
        .then((data) => {
          const created = data as unknown as { progressPath: string };
          router.push(created.progressPath);
        })
        .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "The source import could not be started."));
    });
  }

  const oneTimeWithoutSave = mode === "ONE_TIME_PAT" && !saveOneTimeConnection;
  return (
    <div className="max-w-5xl">
      <div className="flex gap-1 border-b border-zinc-200" role="tablist" aria-label="Repository import steps">
        <Tab active={activeTab === "settings"} id="import-settings" label="Settings" onClick={() => setActiveTab("settings")} panelId="import-settings-panel" />
        <Tab active={activeTab === "preview"} disabled={!preview} id="import-preview" label="Import Preview" onClick={() => setActiveTab("preview")} panelId="import-preview-panel" />
      </div>

      <form ref={formRef} className={`mt-6 rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:p-6 ${activeTab === "settings" ? "" : "hidden"}`} id="import-settings-panel" onSubmit={previewImport} role="tabpanel" aria-labelledby="import-settings">
        <input name="ref" type="hidden" value={selectedRef} readOnly />
        <input name="commit" type="hidden" value={selectedCommit} readOnly />
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-200 pb-5">
          <div><p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Repository settings</p><p className="mt-2 text-sm leading-6 text-zinc-500">Preview is read-only. Start Import creates durable work only after it checks the repository again.</p></div>
          <label className="block"><span className="text-xs font-semibold text-zinc-700">Provider</span><select aria-label="Repository provider" className="mt-2 h-8 rounded-lg border border-sky-200 bg-sky-50 px-2 text-xs font-semibold text-sky-700" defaultValue="GITEA" disabled name="provider"><option value="GITEA">Gitea</option></select></label>
        </div>
        <fieldset className="mt-5"><legend className="text-xs font-semibold text-zinc-700">Credentials</legend><div className="mt-2 grid gap-2 sm:grid-cols-3">
          {(["PUBLIC", "EXISTING_SOURCE_CONNECTION", "ONE_TIME_PAT"] as const).map((candidate) => <label key={candidate} className="cursor-pointer rounded-xl border border-zinc-200 bg-white p-3 has-[:checked]:border-zinc-950 has-[:checked]:ring-1 has-[:checked]:ring-zinc-950"><input checked={mode === candidate} className="sr-only" name="credentialMode" onChange={() => { setMode(candidate); setPreview(null); importIdempotencyKeyRef.current = null; }} type="radio" value={candidate} /><span className="block text-xs font-bold text-zinc-900">{candidate === "PUBLIC" ? "Public repository" : candidate === "EXISTING_SOURCE_CONNECTION" ? "Use existing connection" : "Use one-time PAT"}</span><span className="mt-1 block text-[11px] leading-4 text-zinc-500">{candidate === "PUBLIC" ? "No credential is sent." : candidate === "EXISTING_SOURCE_CONNECTION" ? "Uses an active connection you own." : "Saved encrypted only when you start import."}</span></label>)}
        </div></fieldset>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          {mode === "EXISTING_SOURCE_CONNECTION" && <Field label="Source connection"><select className={inputClassName} disabled={isPending} name="sourceConnectionId" required><option value="">Select your active Gitea connection</option>{connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name ?? "Gitea connection"}</option>)}</select></Field>}
          {(mode === "PUBLIC" || mode === "ONE_TIME_PAT") && <Field label="Gitea server URL"><input className={inputClassName} disabled={isPending} name="serverUrl" placeholder={giteaServerUrl ?? "http://localhost:3100"} required type="url" /><span className="mt-1 block text-[11px] leading-4 text-zinc-500">Use the Gitea server root, not a clone URL such as <code>/owner/repository.git</code>{giteaServerUrl ? <> — for this deployment, that&rsquo;s exactly <code>{giteaServerUrl}</code>, nothing else</> : null}.</span></Field>}
          {mode === "ONE_TIME_PAT" && <Field label="Personal access token"><input autoComplete="off" className={inputClassName} disabled={isPending} name="personalAccessToken" required type="password" /></Field>}
          <fieldset><legend className="text-xs font-semibold text-zinc-700">Expected repository visibility</legend><div className="mt-2 grid h-10 grid-cols-2 rounded-xl border border-zinc-200 bg-white p-1">{(["PUBLIC", "PRIVATE"] as const).map((visibility) => <label key={visibility} className="grid cursor-pointer place-items-center rounded-lg has-[:checked]:bg-zinc-950 has-[:checked]:text-white"><input className="sr-only" defaultChecked={visibility === "PUBLIC"} disabled={isPending} name="expectedVisibility" type="radio" value={visibility} /><span className="text-xs font-semibold">{visibility === "PUBLIC" ? "Public" : "Private"}</span></label>)}</div></fieldset>
          <Field label="Owner"><input className={inputClassName} disabled={isPending} name="owner" placeholder="annotation-admin" required /></Field><Field label="Repository"><input className={inputClassName} disabled={isPending} name="repo" placeholder="ImageDataset" required /></Field>
        </div>
        {mode === "ONE_TIME_PAT" && <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-4"><label className="flex items-center gap-2 text-sm font-semibold text-zinc-800"><input checked={saveOneTimeConnection} name="saveAsSourceConnection" onChange={(event) => { setSaveOneTimeConnection(event.currentTarget.checked); setPreview(null); importIdempotencyKeyRef.current = null; }} type="checkbox" /> Save this PAT as a reusable source connection</label><p className="mt-1 text-xs leading-5 text-zinc-600">Asynchronous private imports require this choice. The PAT is encrypted server-side only when Start Import succeeds.</p><Field label="Connection name"><input className={inputClassName} disabled={isPending} name="connectionName" placeholder="Work Gitea" required={saveOneTimeConnection} /></Field></div>}
        <div className="mt-4 max-w-xl"><Field label="Dataset name"><input className={inputClassName} disabled={isPending} name="datasetName" placeholder="street-scenes-q2" required /></Field></div>
        <Button className="mt-6" disabled={isPending || (mode === "EXISTING_SOURCE_CONNECTION" && connections.length === 0)} type="submit">{isPending ? <SpinnerGap className="animate-spin" aria-hidden="true" size={17} /> : <Eye aria-hidden="true" size={17} />}{isPending ? "Checking repository..." : "Preview import"}</Button>
      </form>

      {activeTab === "preview" && <section className="mt-6 min-h-96 rounded-2xl border border-zinc-200 bg-white p-5 lg:p-6" id="import-preview-panel" role="tabpanel" aria-labelledby="import-preview">{preview && <Preview preview={preview} isPending={isPending} message={message} oneTimeWithoutSave={oneTimeWithoutSave} selectedRef={selectedRef} onRefChange={setSelectedRef} onPreviewRef={previewSelectedRef} selectedCommit={selectedCommit} onPreviewCommit={previewSelectedCommit} onImport={startImport} />}</section>}
      {message && activeTab === "settings" && <p className="mt-4 text-sm text-rose-700" aria-live="polite">{message}</p>}
    </div>
  );
}

function Preview({ preview, isPending, message, oneTimeWithoutSave, selectedRef, onRefChange, onPreviewRef, selectedCommit, onPreviewCommit, onImport }: { preview: ImportPreview; isPending: boolean; message: string | null; oneTimeWithoutSave: boolean; selectedRef: string; onRefChange: (value: string) => void; onPreviewRef: (ref?: string) => void; selectedCommit: string; onPreviewCommit: (sha: string) => void; onImport: () => void }) {
  const assets = preview.assetPreview;
  const currentCommit = selectedCommit || preview.repository.revision || "";
  return <><div className="grid gap-6 lg:grid-cols-[minmax(220px,0.42fr)_minmax(0,1fr)]"><section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4"><p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Choose ref / branch</p><h2 className="mt-2 text-sm font-bold text-zinc-950">Choose an available branch</h2><p className="mt-1 text-xs leading-5 text-zinc-500">The picker is read from the verified repository. Selecting a different branch automatically reloads the bounded asset preview.</p><label className="mt-4 block"><span className="text-xs font-semibold text-zinc-700">Available ref or branch</span><select className={inputClassName} disabled={isPending} onChange={(event) => { const ref = event.currentTarget.value; onRefChange(ref); onPreviewRef(ref); }} value={selectedRef}>{preview.availableRefs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}</select></label><label className="mt-4 block"><span className="text-xs font-semibold text-zinc-700">Choose commit</span><select className={inputClassName} disabled={isPending || preview.availableCommits.length === 0} onChange={(event) => onPreviewCommit(event.currentTarget.value)} value={currentCommit}>{preview.availableCommits.map((commit) => <option key={commit.sha} value={commit.sha}>{commit.sha.slice(0, 8)}{commit.message ? ` · ${commit.message}` : ""}</option>)}</select><span className="mt-1 block text-[11px] leading-4 text-zinc-500">Pins the import to that exact commit on the selected branch.</span></label><p className="mt-3 text-[11px] leading-4 text-zinc-500">Current resolved ref: <span className="font-mono text-zinc-700">{preview.repository.ref}</span></p></section><section><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">Resolved repository</p><h2 className="mt-2 text-lg font-bold text-zinc-950">{preview.repository.fullName}</h2><p className="mt-1 font-mono text-xs text-zinc-500">branch {preview.repository.ref} · commit {preview.repository.revision?.slice(0, 12) ?? "unresolved"} · {preview.repository.rootPath || "/"} · {preview.repository.visibility === "PRIVATE" ? "Private" : "Public"}</p></div>{preview.readyForImport ? <CheckCircle aria-hidden="true" className="text-emerald-600" size={24} weight="fill" /> : <WarningCircle aria-hidden="true" className="text-amber-600" size={24} weight="fill" />}</div>{!preview.visibility.matches && <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">Gitea reports this repository as <strong>{preview.visibility.actual.toLowerCase()}</strong>. Return to Settings and select that visibility before importing.</div>}{assets && <><div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200"><Metric label={assets.truncated ? "Assets detected (bounded)" : "Assets detected"} value={String(assets.detectedAssetCount)} /><Metric label="Preview bytes" value={formatBytes(assets.detectedBytes)} /></div>{assets.truncated && <p className="mt-3 text-xs text-zinc-500">The provider preview reached its safety limit; the displayed asset count is a lower bound, not a full manifest.</p>}{assets.sample.length > 0 && <div className="mt-5 max-h-52 overflow-y-auto border-y border-zinc-200">{assets.sample.map((asset) => <div key={asset.path} className="flex items-center justify-between gap-3 border-b border-zinc-100 py-2 text-xs last:border-b-0"><span className="truncate font-medium text-zinc-700">{asset.path}</span><span className="shrink-0 font-mono text-[10px] text-zinc-400">{asset.modality} · {asset.size === null ? "unknown" : formatBytes(asset.size)}</span></div>)}</div>}</>}</section></div><Button className="mt-5 w-full" disabled={!preview.readyForImport || oneTimeWithoutSave || isPending} onClick={onImport} type="button">Start import <ArrowRight aria-hidden="true" size={17} /></Button><p className={`mt-4 text-xs leading-5 ${preview.readyForImport ? "text-emerald-700" : "text-rose-700"}`} aria-live="polite">{oneTimeWithoutSave ? "Save the one-time PAT as a source connection to start asynchronous import." : message}</p></>;
}

function Tab({ active, disabled, id, label, onClick, panelId }: { active: boolean; disabled?: boolean; id: string; label: string; onClick: () => void; panelId: string }) { return <button aria-controls={panelId} aria-selected={active} className={`border-b-2 px-4 py-3 text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-sky-400 ${active ? "border-zinc-950 text-zinc-950" : "border-transparent text-zinc-500 hover:text-zinc-900"}`} disabled={disabled} id={id} onClick={onClick} role="tab" type="button">{label}</button>; }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block"><span className="text-xs font-semibold text-zinc-700">{label}</span>{children}</label>; }
function Metric({ label, value }: { label: string; value: string }) { return <div className="bg-zinc-50 p-4"><p className="text-[11px] font-medium text-zinc-400">{label}</p><p className="mt-2 font-mono text-xl font-semibold text-zinc-950">{value}</p></div>; }
function formatBytes(bytes: number) { if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB`; }
