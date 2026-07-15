"use client";

import {
  ArrowRight,
  CheckCircle,
  Eye,
  SpinnerGap,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

type ImportPreview = {
  mode: "preview";
  readyForPersistence: boolean;
  repository: {
    fullName: string;
    defaultBranch: string;
  };
  summary: {
    imageCount: number;
    totalBytes: number;
    treeTruncated: boolean;
    importLimit: number;
  };
  images: Array<{
    path: string;
    mimeType: string;
    size: number | null;
  }>;
  imagePreviewTruncated: boolean;
};

type ApiEnvelope<T> = {
  data?: T;
  error?: {
    message?: string;
    fieldErrors?: Record<string, string[]>;
  };
};

const inputClassName =
  "mt-2 h-10 w-full rounded-xl border border-zinc-200 bg-white px-3 text-sm text-zinc-900 outline-none transition-[border-color,box-shadow] placeholder:text-zinc-400 focus:border-sky-400 focus:ring-2 focus:ring-sky-100 disabled:bg-zinc-100";

export function ImportForm({ connections }: { connections: Array<{ id: string; name: string | null }> }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [lastPayload, setLastPayload] = useState<Record<string, string> | null>(
    null,
  );

  function submit(mode: "preview" | "persist", payload: Record<string, string>) {
    setMessage(null);
    startTransition(() => {
      void fetch("/api/gitea/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, mode }),
      })
        .then(async (response) => {
          const body = (await response.json()) as ApiEnvelope<
            ImportPreview | { mode: "persisted"; datasetId: string }
          >;
          if (!response.ok || !body.data) {
            const fieldMessage = body.error?.fieldErrors
              ? Object.values(body.error.fieldErrors).flat()[0]
              : null;
            throw new Error(
              fieldMessage ?? body.error?.message ?? "Import failed.",
            );
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
          setMessage(
            data.readyForPersistence
              ? "Preview complete. This dataset is ready to import."
              : "Preview complete, but this tree cannot be imported safely.",
          );
        })
        .catch((error: unknown) => {
          setMessage(
            error instanceof Error ? error.message : "Import failed.",
          );
        });
    });
  }

  function handlePreview(formData: FormData) {
    const payload = {
      owner: String(formData.get("owner") ?? ""),
      repo: String(formData.get("repo") ?? ""),
      sourceConnectionId: String(formData.get("sourceConnectionId") ?? ""),
      branch: String(formData.get("branch") ?? ""),
      rootPath: String(formData.get("rootPath") ?? ""),
      name: String(formData.get("name") ?? ""),
    };
    setPreview(null);
    setLastPayload(payload);
    submit("preview", payload);
  }

  return (
    <div className="grid items-start gap-7 xl:grid-cols-[minmax(320px,0.75fr)_minmax(0,1.25fr)]">
      <form action={handlePreview} className="rounded-2xl border border-zinc-200 bg-zinc-50 p-5 lg:p-6">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
          Repository source
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <Field label="Source connection">
            <select
              className={inputClassName}
              defaultValue={lastPayload?.sourceConnectionId}
              disabled={isPending}
              name="sourceConnectionId"
              required
            >
              <option value="">Select your active Gitea connection</option>
              {connections.map((connection) => <option key={connection.id} value={connection.id}>{connection.name ?? "Gitea connection"}</option>)}
            </select>
          </Field>
          <Field label="Owner">
            <input
              className={inputClassName}
              defaultValue={lastPayload?.owner}
              disabled={isPending}
              name="owner"
              placeholder="vision-lab"
              required
            />
          </Field>
          <Field label="Repository">
            <input
              className={inputClassName}
              defaultValue={lastPayload?.repo}
              disabled={isPending}
              name="repo"
              placeholder="training-images"
              required
            />
          </Field>
          <Field label="Branch or ref">
            <input
              className={inputClassName}
              defaultValue={lastPayload?.branch ?? "main"}
              disabled={isPending}
              name="branch"
              placeholder="main"
              required
            />
          </Field>
          <Field label="Root path">
            <input
              className={inputClassName}
              defaultValue={lastPayload?.rootPath}
              disabled={isPending}
              name="rootPath"
              placeholder="images/urban"
            />
          </Field>
        </div>
        <div className="mt-4">
          <Field label="Dataset name">
            <input
              className={inputClassName}
              defaultValue={lastPayload?.name}
              disabled={isPending}
              name="name"
              placeholder="street-scenes-q2"
              required
            />
          </Field>
        </div>
        <Button className="mt-5 w-full" disabled={isPending} type="submit">
          {isPending ? (
            <SpinnerGap className="animate-spin" aria-hidden="true" size={17} />
          ) : (
            <Eye aria-hidden="true" size={17} />
          )}
          {isPending ? "Checking repository..." : "Preview import"}
        </Button>
      </form>

      <section className="min-h-96 rounded-2xl border border-zinc-200 bg-white p-5 lg:p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-zinc-400">
              Import preview
            </p>
            <h2 className="mt-2 text-lg font-bold text-zinc-950">
              {preview?.repository.fullName ?? "No repository checked"}
            </h2>
          </div>
          {preview?.readyForPersistence && (
            <CheckCircle
              aria-hidden="true"
              className="text-emerald-600"
              size={24}
              weight="fill"
            />
          )}
        </div>

        {preview ? (
          <>
            <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-zinc-200 bg-zinc-200">
              <Metric label="Images" value={String(preview.summary.imageCount)} />
              <Metric
                label="Source bytes"
                value={formatBytes(preview.summary.totalBytes)}
              />
            </div>
            <div className="mt-5 max-h-56 overflow-y-auto border-y border-zinc-200">
              {preview.images.slice(0, 12).map((image) => (
                <div
                  key={image.path}
                  className="flex items-center justify-between gap-4 border-b border-zinc-100 py-2.5 text-xs last:border-b-0"
                >
                  <span className="truncate font-medium text-zinc-700">
                    {image.path}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-400">
                    {image.mimeType}
                  </span>
                </div>
              ))}
            </div>
            <Button
              className="mt-5 w-full"
              disabled={!preview.readyForPersistence || isPending || !lastPayload}
              onClick={() => {
                if (lastPayload) submit("persist", lastPayload);
              }}
              type="button"
            >
              Import {preview.summary.imageCount} images
              <ArrowRight aria-hidden="true" size={17} />
            </Button>
          </>
        ) : (
          <div className="grid min-h-64 place-items-center text-center">
            <p className="max-w-xs text-sm leading-6 text-zinc-400">
              Enter a repository location to inspect supported image files
              before any database records are written.
            </p>
          </div>
        )}

        <p
          className={`mt-4 text-xs leading-5 ${
            preview?.readyForPersistence ? "text-emerald-700" : "text-rose-700"
          }`}
          aria-live="polite"
        >
          {message}
        </p>
      </section>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-zinc-700">{label}</span>
      {children}
    </label>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-zinc-50 p-4">
      <p className="text-[11px] font-medium text-zinc-400">{label}</p>
      <p className="mt-2 font-mono text-xl font-semibold text-zinc-950">
        {value}
      </p>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
