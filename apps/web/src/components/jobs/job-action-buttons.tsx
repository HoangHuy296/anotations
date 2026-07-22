"use client";

import { useState, useTransition } from "react";
import { ArrowClockwise, CheckCircle, SpinnerGap, StopCircle } from "@phosphor-icons/react";

import { Button } from "@/components/ui/button";
import type { JobDisplayStatus } from "@/lib/jobs/job-progress-view";

type ActionResult = { successorId?: string };

export function JobActionButtons({ job, onChanged }: { job: JobDisplayStatus; onChanged: (result?: ActionResult) => void }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const canCancel = ["QUEUED", "RETRYING", "RUNNING"].includes(job.status);
  const canRetry = job.status === "FAILED";
  const canCommitImport = job.type === "IMPORT_DATASET" && ["RUNNING", "RETRYING"].includes(job.status);
  function action(name: "cancel" | "retry" | "commit-import") {
    setMessage(null);
    startTransition(() => { void fetch(`/api/jobs/${job.id}/${name}`, { method: "POST" }).then(async (response) => {
      const body = await response.json() as { data?: { id?: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Job action failed.");
      onChanged(name === "retry" ? { successorId: body.data?.id } : undefined);
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Job action failed.")); });
  }
  const pendingLabel = pending ? "Sending request…" : null;
  return <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_18px_45px_-38px_rgba(24,24,27,0.38)]" aria-label="Job actions"><div className="flex flex-wrap items-center gap-2"><Button type="button" variant="secondary" disabled={!canCancel || pending} onClick={() => action("cancel")}><StopCircle size={17} weight="bold" />Cancel</Button><Button type="button" variant="secondary" disabled={!canRetry || pending} onClick={() => action("retry")}><ArrowClockwise size={17} weight="bold" />Retry</Button>{canCommitImport ? <Button type="button" disabled={pending} onClick={() => action("commit-import")}><CheckCircle size={17} weight="bold" />Commit import</Button> : null}{pendingLabel ? <span className="ml-1 inline-flex items-center gap-2 text-sm text-zinc-500"><SpinnerGap className="animate-spin" size={16} />{pendingLabel}</span> : null}</div>{message ? <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{message}</p> : null}</section>;
}
