"use client";

import { Atom, CheckCircle, SpinnerGap, StopCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Modality } from "@internal/db";

import { cancelAiTaskClient, createAiTaskClient, listActiveAiModelsClient, readAiTaskClient } from "@/lib/ai/ai-task-api-client";
import { aiTaskStatusMessage, modelSupportsModality, shouldPollAiTask } from "@/lib/ai/ai-detect-view";
import type { AiModelDto, AiTaskStatusDto } from "@/types/ai";

const POLL_INTERVAL_MS = 2_500;

type Phase = "loading-models" | "models-error" | "no-models" | "select-model" | "submitting" | "create-error" | "polling" | "succeeded" | "failed" | "canceled";

export type AiDetectDialogProps = {
  /** The asset AI Detect runs against. Identity only -- this component never inspects geometry or existing annotations. */
  assetId: string;
  /**
   * The asset's own modality (`Asset.modality`) -- the workspace is
   * modality-driven (IMAGE/VIDEO/AUDIO/TEXT each own an engine + toolbox via
   * `workspaceEngineRegistry`); this dialog is that same shape applied to AI
   * Detect. It never assumes IMAGE: models are filtered by whatever
   * `modality` its caller passes, and it never touches an engine-specific
   * annotation store directly.
   */
  modality: Modality;
  onClose: () => void;
  /**
   * Applying a completed task's results is engine-owned (IMAGE writes into
   * `image-annotation-store`; a future VIDEO/AUDIO/TEXT caller would write
   * into its own store) -- this dialog only reports that `taskId` reached
   * `SUCCEEDED` and lets the caller return how many new predictions it
   * applied, so the dialog can say so without knowing what an annotation is.
   */
  onCompleted?: (taskId: string) => Promise<number | void> | number | void;
};

/**
 * Model-selection + submit + poll UI for "AI Detect" (`contracts/ai-api.md`).
 * Deliberately owns no drawing/canvas/toolbox logic and imports nothing
 * IMAGE-specific -- `image-toolbox.tsx` only ever sets `tool: "aidetect"`;
 * this component is what an engine mounts in response to that, the same way
 * every other tool's UI lives outside the toolbox button itself.
 */
export function AiDetectDialog({ assetId, modality, onClose, onCompleted }: AiDetectDialogProps) {
  const { datasetId } = useParams<{ datasetId: string }>();
  const [phase, setPhase] = useState<Phase>("loading-models");
  const [models, setModels] = useState<AiModelDto[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [task, setTask] = useState<AiTaskStatusDto | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const [canceling, setCanceling] = useState(false);

  // The taskId a cancellation has been requested for. `refreshTask` checks
  // this before applying a result: cancellation is cooperative (`Job.status`
  // passes through `CANCELING` before the worker settles it `CANCELED`), so
  // a poll already in flight when the user clicks Cancel can still resolve
  // afterward. Without this guard that stale response could overwrite the
  // dialog with a pre-cancellation snapshot (e.g. still "RUNNING").
  const canceledTaskIdRef = useRef<string | null>(null);

  // Applies the fetched/filtered model list to state. Only ever invoked from
  // inside a `.then()`/async continuation (the mount effect below, or
  // `retry()`'s "models-error" branch as a plain event-handler call) --
  // never synchronously at the top of an effect body.
  const applyModelsResult = useCallback((result: Awaited<ReturnType<typeof listActiveAiModelsClient>>) => {
    if (!result.ok) { setErrorMessage("Could not load AI models. Try again."); setPhase("models-error"); return; }
    const applicable = result.models.filter((model) => modelSupportsModality(model, modality));
    setModels(applicable);
    if (applicable.length === 0) { setPhase("no-models"); return; }
    setSelectedModelId(applicable[0]?.id ?? null);
    setPhase("select-model");
  }, [modality]);

  useEffect(() => {
    let canceled = false;
    void listActiveAiModelsClient().then((result) => { if (!canceled) applyModelsResult(result); });
    return () => { canceled = true; };
  }, [applyModelsResult]);

  const refreshTask = useCallback(async (taskId: string) => {
    const result = await readAiTaskClient(taskId);
    if (!result.ok) return;
    if (canceledTaskIdRef.current === taskId) return; // stale: cancellation was requested for this task while the poll was in flight
    setTask(result.task);
    if (result.task.status === "SUCCEEDED") {
      setPhase("succeeded");
      const applied = await onCompleted?.(taskId);
      setAppliedCount(typeof applied === "number" ? applied : null);
    } else if (result.task.status === "FAILED") {
      setPhase("failed");
    } else if (result.task.status === "CANCELED") {
      setPhase("canceled");
    }
  }, [onCompleted]);

  // Polls at a fixed interval while a task is in flight. Every successful
  // poll sets a new `task` object, which re-runs this effect (clearing the
  // old timer and starting a fresh one) -- so it always closes over the
  // latest status without needing a ref. It stops the instant a terminal
  // status is reached (`refreshTask` moves `phase` off "polling") or the tab
  // is hidden, and always clears its timer on unmount -- the dialog closing
  // (tool changes away from "aidetect") must never leave a stray interval
  // running against an unmounted component.
  useEffect(() => {
    if (phase !== "polling" || !task || !shouldPollAiTask(task.status)) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refreshTask(task.taskId); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase, task, refreshTask]);

  async function submit() {
    if (!selectedModelId || !datasetId) return;
    setPhase("submitting");
    setErrorMessage(null);
    const result = await createAiTaskClient({ datasetId, modelId: selectedModelId, assetIds: [assetId] });
    if (!result.ok) {
      setErrorMessage(createErrorMessage(result.code));
      setPhase("create-error");
      return;
    }
    const model = models.find((item) => item.id === selectedModelId) ?? null;
    setTask({
      taskId: result.taskId, jobId: result.jobId, datasetId, status: "QUEUED", type: model?.taskType ?? "",
      modality: model?.modality ?? modality, modelNameSnapshot: model?.displayName ?? "", modelVersionSnapshot: null,
      pollAttempts: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null, errorCode: null,
    });
    setPhase("polling");
    void refreshTask(result.taskId);
  }

  // Cancellation is one-way: the backend endpoint requests cancellation of
  // the Job, it is never a pause a later call can undo, and the same job
  // must never be canceled twice. `canceling` disables the button the
  // instant this starts (both against a double click and to make a second
  // `POST /api/ai/tasks/{taskId}/cancel` for this task unreachable), and on
  // success the task is retired for good -- `canceledTaskIdRef` blocks any
  // poll already in flight from reviving it, and the polling effect stops
  // itself because it only runs in phase "polling". The only way forward
  // from here is `retry()`, which discards this task/job entirely and goes
  // back to model selection for a fresh `POST /api/ai/tasks`.
  async function cancel() {
    if (!task || canceling) return;
    canceledTaskIdRef.current = task.taskId;
    setCanceling(true);
    setErrorMessage(null);
    const result = await cancelAiTaskClient(task.taskId);
    setCanceling(false);
    if (!result.ok) {
      canceledTaskIdRef.current = null; // cancellation did not take -- this task is still live, let polling keep going
      setErrorMessage(cancelErrorMessage(result.code));
      return;
    }
    setPhase("canceled");
  }

  function retry() {
    setTask(null);
    canceledTaskIdRef.current = null;
    setErrorMessage(null);
    setAppliedCount(null);
    // A model-fetch failure retries the fetch itself; a task-level failure
    // (create/poll/cancel) already has a good model list and just goes back
    // to picking one.
    if (phase === "models-error") { setPhase("loading-models"); void listActiveAiModelsClient().then(applyModelsResult); return; }
    setPhase(models.length > 0 ? "select-model" : "no-models");
  }

  return <div role="dialog" aria-modal="true" aria-label="AI Detect" className="fixed inset-0 z-50 grid place-items-center bg-zinc-950/40 p-4">
    <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-2xl">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-950"><Atom size={18} className="text-sky-600" weight="duotone" />AI Detect</h2>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X size={16} /></button>
      </div>

      <div className="mt-4" aria-live="polite">
        {phase === "loading-models" && <StatusLine icon={<SpinnerGap className="animate-spin" size={16} />} text="Loading available AI models…" />}
        {phase === "models-error" && <StatusLine icon={<WarningCircle size={16} />} text={errorMessage ?? "Could not load AI models."} tone="error" />}
        {phase === "no-models" && <StatusLine icon={<WarningCircle size={16} />} text="No active AI models are available for this asset's modality yet." />}

        {(phase === "select-model" || phase === "submitting" || phase === "create-error") && models.length > 0 && <div>
          <p className="text-xs font-semibold text-zinc-500">Choose a model</p>
          <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
            {models.map((model) => <li key={model.id}>
              <label className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm ${selectedModelId === model.id ? "border-sky-500 bg-sky-50" : "border-zinc-200 hover:bg-zinc-50"}`}>
                <input type="radio" name="ai-model" className="accent-sky-600" checked={selectedModelId === model.id} onChange={() => setSelectedModelId(model.id)} />
                <span className="flex-1"><span className="block font-medium text-zinc-900">{model.displayName}</span><span className="block text-[11px] text-zinc-500">{model.taskType.replaceAll("_", " ")}{model.modality === null ? " · multi-modal" : ""}</span></span>
              </label>
            </li>)}
          </ul>
          {phase === "create-error" && <StatusLine icon={<WarningCircle size={16} />} text={errorMessage ?? "The AI task could not be created."} tone="error" />}
        </div>}

        {(phase === "polling" || phase === "succeeded" || phase === "failed" || phase === "canceled") && task && <div className="space-y-2">
          <p className="text-sm text-zinc-700">{task.modelNameSnapshot}</p>
          <StatusLine
            icon={phase === "polling" ? <SpinnerGap className="animate-spin" size={16} /> : phase === "succeeded" ? <CheckCircle size={16} /> : <WarningCircle size={16} />}
            text={aiTaskStatusMessage(task)}
            tone={phase === "succeeded" ? "success" : phase === "failed" ? "error" : "default"}
          />
          {phase === "polling" && errorMessage && <StatusLine icon={<WarningCircle size={16} />} text={errorMessage} tone="error" />}
          {phase === "succeeded" && <p className="text-xs text-zinc-500">{appliedCount === null ? "Results are ready." : appliedCount === 0 ? "No detections were returned for this asset." : `${appliedCount} AI-suggested annotation${appliedCount === 1 ? "" : "s"} added as drafts for review.`}</p>}
        </div>}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        {phase === "polling" && <button type="button" disabled={canceling} onClick={() => void cancel()} className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"><StopCircle size={15} />{canceling ? "Canceling…" : "Cancel"}</button>}
        {(phase === "failed" || phase === "canceled" || phase === "create-error" || phase === "models-error") && <button type="button" onClick={retry} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50">Try again</button>}
        {(phase === "select-model" || phase === "submitting") && <button type="button" disabled={!selectedModelId || phase === "submitting"} onClick={() => void submit()} className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{phase === "submitting" ? <SpinnerGap className="animate-spin" size={14} /> : <Atom size={14} />}Run AI Detect</button>}
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zinc-500 hover:bg-zinc-100">{phase === "succeeded" || phase === "canceled" || phase === "failed" ? "Done" : "Close"}</button>
      </div>
    </div>
  </div>;
}

function StatusLine({ icon, text, tone = "default" }: { icon: React.ReactNode; text: string; tone?: "default" | "error" | "success" }) {
  const color = tone === "error" ? "text-rose-600" : tone === "success" ? "text-emerald-600" : "text-zinc-500";
  return <p className={`flex items-center gap-2 text-xs ${color}`}>{icon}{text}</p>;
}

function cancelErrorMessage(code: string): string {
  switch (code) {
    case "JOB_CONFLICT": return "This task can no longer be canceled.";
    default: return "Could not cancel this task. Try again.";
  }
}

function createErrorMessage(code: string): string {
  switch (code) {
    case "AI_MODEL_INACTIVE": return "This model is no longer active. Choose another model.";
    case "AI_MODEL_NOT_FOUND": return "This model is no longer available. Choose another model.";
    case "ASSET_NOT_IN_DATASET": return "This asset is no longer part of the dataset.";
    case "FORBIDDEN": return "You do not have permission to request AI pre-annotation for this dataset.";
    case "DATASET_NOT_FOUND": return "This dataset is no longer available.";
    default: return "The AI task could not be created. Try again.";
  }
}
