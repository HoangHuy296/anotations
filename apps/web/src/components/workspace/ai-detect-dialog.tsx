"use client";

import { Atom, CheckCircle, SpinnerGap, StopCircle, WarningCircle, X } from "@phosphor-icons/react";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Modality } from "@internal/db";

import { cancelAiTaskClient, createAiTaskClient, listActiveAiModelsClient, listModelClassesClient, readAiTaskClient } from "@/lib/ai/ai-task-api-client";
import { aiTaskStatusMessage, modelSupportsModality, shouldPollAiTask } from "@/lib/ai/ai-detect-view";
import type { AiModelDto, AiTaskStatusDto } from "@/types/ai";

const POLL_INTERVAL_MS = 2_500;

type Phase = "loading-models" | "models-error" | "no-models" | "select-model" | "submitting" | "create-error" | "polling" | "succeeded" | "failed" | "canceled";

export type AiDetectDialogProps = {
  /** The asset AI Detect runs against. Identity only -- this component never inspects geometry or existing annotations. */
  assetId: string;
  children?: React.ReactNode;
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
export function AiDetectDialog({ assetId, modality, onClose, onCompleted, children }: AiDetectDialogProps) {
  const { datasetId } = useParams<{ datasetId: string }>();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    closeButtonRef.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  const [phase, setPhase] = useState<Phase>("loading-models");
  const [models, setModels] = useState<AiModelDto[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [task, setTask] = useState<AiTaskStatusDto | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);
  const [classResult, setClassResult] = useState<{ modelId: string; classes: string[]; failed: boolean } | null>(null);
  const [selectedClasses, setSelectedClasses] = useState<string[]>([]);
  const [confidenceThreshold, setConfidenceThreshold] = useState("0.5");
  const [iouThreshold, setIouThreshold] = useState("0.5");
  const thresholdsValid = [confidenceThreshold, iouThreshold].every((value) => value.trim() !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 1);
  const [classRetry, setClassRetry] = useState(0);
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const classesReady = classResult?.modelId === selectedModelId && !classResult?.failed;
  const canSubmit = thresholdsValid && selectedModel?.availableForTasks !== false && classesReady && selectedClasses.length > 0 && modality !== "VIDEO";

  useEffect(() => {
    if (!selectedModelId) return;
    let canceled = false;
    void listModelClassesClient(selectedModelId).then((result) => {
      if (canceled) return;
      setClassResult({ modelId: selectedModelId, classes: result.ok ? result.classes : [], failed: !result.ok });
      setSelectedClasses(result.ok ? result.classes : []);
    });
    return () => { canceled = true; };
  }, [selectedModelId, classRetry]);

  const [canceling, setCanceling] = useState(false);

  // The taskId a cancellation has been requested for. `refreshTask` checks
  // this before applying a result: cancellation is cooperative (`Job.status`
  // passes through `CANCELING` before the worker settles it `CANCELED`), so
  // a poll already in flight when the user clicks Cancel can still resolve
  // afterward. Without this guard that stale response could overwrite the
  // dialog with a pre-cancellation snapshot (e.g. still "RUNNING").
  const canceledTaskIdRef = useRef<string | null>(null);
  const completedTaskIdRef = useRef<string | null>(null);

  // Applies the fetched/filtered model list to state. Only ever invoked from
  // inside a `.then()`/async continuation (the mount effect below, or
  // `retry()`'s "models-error" branch as a plain event-handler call) --
  // never synchronously at the top of an effect body.
  const applyModelsResult = useCallback((result: Awaited<ReturnType<typeof listActiveAiModelsClient>>) => {
    if (!result.ok) { setErrorMessage("Could not load AI models. Try again."); setPhase("models-error"); return; }
    const applicable = result.models.filter((model) => modelSupportsModality(model, modality));
    setModels(applicable);
    if (applicable.length === 0) { setPhase("no-models"); return; }
    setSelectedModelId(applicable.find((model) => model.availableForTasks !== false)?.id ?? applicable[0].id);
    setPhase("select-model");
  }, [modality]);

  useEffect(() => {
    let canceled = false;
    void listActiveAiModelsClient(modality).then((result) => { if (!canceled) applyModelsResult(result); });
    return () => { canceled = true; };
  }, [applyModelsResult, modality]);

  const refreshTask = useCallback(async (taskId: string) => {
    const result = await readAiTaskClient(taskId);
    if (!result.ok) return;
    if (canceledTaskIdRef.current === taskId) return; // stale: cancellation was requested for this task while the poll was in flight
    setTask(result.task);
    if (result.task.status === "SUCCEEDED") {
      if (completedTaskIdRef.current === taskId) return;
      completedTaskIdRef.current = taskId;
      setPhase("succeeded");
      try {
        const applied = await onCompleted?.(taskId);
        setAppliedCount(typeof applied === "number" ? applied : null);
      } catch { setErrorMessage("Detection completed, but annotations could not be refreshed. Reload the workspace to view them."); }
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
    if (!selectedModelId || !datasetId || !canSubmit) return;
    setPhase("submitting");
    setErrorMessage(null);
    const result = await createAiTaskClient({ datasetId, modelId: selectedModelId, assetIds: [assetId], classes: selectedClasses, confidence_threshold: Number(confidenceThreshold), iou_threshold: Number(iouThreshold) });
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
    if (phase === "models-error") { setPhase("loading-models"); void listActiveAiModelsClient(modality).then(applyModelsResult); return; }
    setPhase(models.length > 0 ? "select-model" : "no-models");
  }

  return <aside aria-label="AI Detect" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }} className="absolute inset-y-0 left-0 z-30 w-80 max-w-full overflow-y-auto border-r border-zinc-200 bg-white text-zinc-900 shadow-xl">
    <div className="p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold text-zinc-950"><Atom size={18} className="text-sky-600" weight="duotone" />AI Detect</h2>
        <button ref={closeButtonRef} type="button" aria-label="Close" onClick={onClose} className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"><X size={16} /></button>
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
                <input type="radio" disabled={phase === "submitting"} name="ai-model" className="accent-sky-600" checked={selectedModelId === model.id} onChange={() => { setClassResult(null); setSelectedClasses([]); setSelectedModelId(model.id); }} />
                <span className="flex-1"><span className="block font-medium text-zinc-900">{model.displayName}</span><span className="block text-[11px] text-zinc-500">{model.availableForTasks === false ? "Not configured for AI tasks" : model.taskType.replaceAll("_", " ")}{model.modality === null ? " · multi-modal" : ""}</span></span>
              </label>
            </li>)}
          </ul>
          {selectedModelId && <fieldset disabled={phase === "submitting"} className="mt-4 border-t border-zinc-100 pt-4">
            <legend className="text-xs font-semibold text-zinc-600">Classes to detect</legend>
            {classResult?.modelId !== selectedModelId ? <StatusLine icon={<SpinnerGap className="animate-spin" size={16} />} text="Loading model classes…" /> : classResult.failed ? <div>
              <p className="text-xs text-rose-600">Could not load model classes.</p>
              <button type="button" onClick={() => { setClassResult(null); setClassRetry((value) => value + 1); }} className="mt-2 text-xs font-semibold text-sky-700">Retry classes</button>
            </div> : classResult.classes.length === 0 ? <p className="text-xs text-zinc-500">This model has no selectable classes.</p> : <>
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="text-zinc-500">{selectedClasses.length} of {classResult.classes.length} selected</span>
                <button type="button" className="font-semibold text-sky-700" onClick={() => setSelectedClasses(selectedClasses.length === classResult.classes.length ? [] : classResult.classes)}>{selectedClasses.length === classResult.classes.length ? "Clear all" : "Select all"}</button>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {classResult.classes.map((label) => <label key={label} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-zinc-50">
                  <input type="checkbox" className="accent-sky-600" checked={selectedClasses.includes(label)} onChange={(event) => setSelectedClasses((current) => event.target.checked ? [...current, label] : current.filter((item) => item !== label))} />{label}
                </label>)}
              </div>
              {selectedClasses.length === 0 && <p className="mt-2 text-xs text-zinc-500">Select at least one class to run detection.</p>}
            </>}
          </fieldset>}
          <fieldset disabled={phase === "submitting"} className="mt-4 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-4">
            <ThresholdInput label="Confidence threshold" value={confidenceThreshold} onChange={setConfidenceThreshold} />
            <ThresholdInput label="IoU threshold" value={iouThreshold} onChange={setIouThreshold} />
          </fieldset>
          {!thresholdsValid && <p className="mt-2 text-xs text-rose-600">Enter a value from 0 to 1 for both thresholds.</p>}
          {modality === "VIDEO" && <p className="mt-3 text-xs text-amber-700">Video detection is not supported by the current processing service yet.</p>}
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
          {phase === "succeeded" && <p className="text-xs text-zinc-500">{appliedCount === null ? "Results are ready." : appliedCount === 0 ? "Detection results are shown as previews below. Choose an existing label only if you want to save a draft." : `${appliedCount} AI-suggested annotation${appliedCount === 1 ? "" : "s"} added as drafts for review.`}</p>}
        </div>}
      </div>

      {phase === "succeeded" && errorMessage && <p role="alert" className="mt-2 text-xs text-rose-600">{errorMessage}</p>}
      {children}

      <div className="mt-5 flex justify-end gap-2">
        {phase === "polling" && <button type="button" disabled={canceling} onClick={() => void cancel()} className="flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50 disabled:opacity-50"><StopCircle size={15} />{canceling ? "Canceling…" : "Cancel"}</button>}
        {(phase === "failed" || phase === "canceled" || phase === "create-error" || phase === "models-error") && <button type="button" onClick={retry} className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-semibold text-zinc-700 hover:bg-zinc-50">Try again</button>}
        {(phase === "select-model" || phase === "submitting") && <button type="button" disabled={!selectedModelId || !canSubmit || phase === "submitting"} onClick={() => void submit()} className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-sky-500 disabled:opacity-50">{phase === "submitting" ? <SpinnerGap className="animate-spin" size={14} /> : <Atom size={14} />}Run AI Detect</button>}
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-zinc-500 hover:bg-zinc-100">{phase === "succeeded" || phase === "canceled" || phase === "failed" ? "Done" : "Close"}</button>
      </div>
    </div>
  </aside>;
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

/** Step buttons use 0.1 while step="any" preserves manually entered decimals. */
function ThresholdInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const adjust = (delta: number) => {
    const current = value.trim() !== "" && Number.isFinite(Number(value)) ? Number(value) : 0.5;
    onChange(String(Math.round(Math.min(1, Math.max(0, current + delta)) * 1e10) / 1e10));
  };
  return <div className="block text-xs font-semibold text-zinc-600">
    {label}
    <span className="mt-2 flex overflow-hidden rounded-md border border-zinc-200 focus-within:border-sky-500">
      <input aria-label={label} type="number" min={0} max={1} step="any" value={value} onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); adjust(event.key === "ArrowUp" ? 0.1 : -0.1); } }}
        className="w-full min-w-0 appearance-textfield bg-white px-3 py-2 text-center text-sm font-normal text-zinc-900 outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
      <span className="flex w-7 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50">
        <button type="button" aria-label={`Increase ${label.toLowerCase()}`} disabled={Number(value) >= 1} onClick={() => adjust(0.1)} className="flex-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30">⌃</button>
        <button type="button" aria-label={`Decrease ${label.toLowerCase()}`} disabled={value !== "" && Number(value) <= 0} onClick={() => adjust(-0.1)} className="flex-1 border-t border-zinc-200 text-zinc-500 hover:bg-zinc-100 disabled:opacity-30">⌄</button>
      </span>
    </span>
  </div>;
}
