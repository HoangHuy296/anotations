"use client";

import {
  ArrowLeft,
  CaretDown,
  ChatCircleText,
  CloudCheck,
  GearSix,
  LockKey,
  UserCircle,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Modality } from "@internal/db";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { DiscussionDrawer } from "@/components/workspace/discussion-drawer";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { useAnnotationStore } from "@/stores/image-annotation-store";
import { workspaceEngineRegistry } from "@/lib/workspace/workspace-engine-registry";
import { useWorkflowShortcuts } from "@/components/workspace/use-workflow-shortcuts";
import { useCollaborationRealtime } from "@/components/workspace/use-collaboration-realtime";
import { CollaborationPresence } from "@/components/workspace/collaboration-presence";
import { useWorkspacePresence } from "@/components/workspace/use-workspace-presence";
import type { SafeWorkspaceWorkflow } from "@/types/workspace";
import { workflowAssetStateSchema } from "@/lib/validation/asset-workflow";

type WorkspaceHeaderProps = {
  datasetName: string;
  branch: string;
  repositoryFullName: string;
  rootPath: string;
  /** The active selection's engine, or `null` when no asset is selected (defaults to the IMAGE status fields). */
  engine: Modality | null;
  /** Signed-in actor, used to populate the account dropdown. `null` renders the trigger disabled. */
  actor: { email: string; name: string } | null;
  workflow?: SafeWorkspaceWorkflow | null;
  discussion?: { datasetId: string; assetId: string | null; commentId?: string | null };
};

/**
 * The shared status surface. Save/dirty/conflict display and the
 * "Connected" indicator are identical across engines; the modality badge
 * (and future per-engine fields — spec FR-037) come from
 * `workspaceEngineRegistry` (FR-041–FR-044).
 */
export function WorkspaceHeader({
  datasetName,
  branch,
  repositoryFullName,
  rootPath,
  engine,
  actor,
  workflow = null,
  discussion,
}: WorkspaceHeaderProps) {
  const { StatusFields } = workspaceEngineRegistry[engine ?? "IMAGE"];
  const saveStates = useAnnotationStore((store) => store.saveStates);
  const currentSaveStates = Object.values(saveStates);
  const conflict = currentSaveStates.includes("conflict") || currentSaveStates.includes("failed");
  const saving = currentSaveStates.includes("pending") || currentSaveStates.includes("saving");
  const saveLabel = conflict ? "Save needs attention" : saving ? "Saving changes" : "All changes saved";
  const [discussionOpen, setDiscussionOpen] = useState(Boolean(discussion?.commentId));
  const [collaborationRevision, setCollaborationRevision] = useState(0);
  const router = useRouter();
  useCollaborationRealtime({ datasetIds: discussion ? [discussion.datasetId] : [], onInvalidate: () => { setCollaborationRevision((value) => value + 1); router.refresh(); } });
  const presence = useWorkspacePresence({ datasetId: discussion?.datasetId, assetId: discussion?.assetId });

  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-white px-3 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <Button asChild variant="icon" aria-label="Back to datasets">
          <Link href="/datasets">
            <ArrowLeft aria-hidden="true" size={18} />
          </Link>
        </Button>
        <span className="grid size-9 place-items-center rounded-xl bg-zinc-950 text-xs font-black tracking-tight text-white" aria-label="Annotation Platform">AP</span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-sm font-bold text-zinc-950">
              {datasetName}
            </h1>
            <Badge variant="info">{branch}</Badge>
            <StatusFields />
          </div>
          <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
            {repositoryFullName}
            {rootPath ? ` / ${rootPath}` : ""}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {workflow ? <WorkflowControls key={`${workflow.assetId}:${workflow.revision}`} workflow={workflow} engine={engine ?? "IMAGE"} /> : null}
        {discussion ? <Button type="button" size="sm" variant="secondary" aria-label="Open asset discussion" onClick={() => setDiscussionOpen(true)}><ChatCircleText aria-hidden="true" size={17} />Discussion</Button> : null}
        <CollaborationPresence members={presence} />
        <span className={`hidden items-center gap-2 text-xs sm:flex ${conflict ? "text-rose-700" : "text-zinc-500"}`}>
          {conflict ? <WarningCircle aria-hidden="true" className="text-rose-600" size={17} weight="fill" /> : <CloudCheck
            aria-hidden="true"
            className="text-emerald-600"
            size={17}
            weight="fill"
          />}
          {saveLabel}
        </span>
        <span className="hidden rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 md:inline-flex">Connected</span>
        <Button type="button" variant="icon" aria-label="Settings are not available yet" disabled><GearSix aria-hidden="true" size={17} /></Button>
        {actor ? <NotificationBell /> : null}
        <AccountMenu actor={actor} />
      </div>
      {discussion ? <DiscussionDrawer datasetId={discussion.datasetId} assetId={discussion.assetId} highlightCommentId={discussion.commentId} refreshKey={collaborationRevision} open={discussionOpen} onClose={() => setDiscussionOpen(false)} /> : null}
    </header>
  );
}

type WorkflowEvent = { id: string; action: string; fromStatus: string | null; toStatus: string | null; feedback: string | null; createdAt: string; actor: { name: string | null; email: string } };
type WorkflowAssetResponse = { status: SafeWorkspaceWorkflow["status"]; revision: number };

function WorkflowControls({ workflow, engine }: { workflow: SafeWorkspaceWorkflow; engine: Modality }) {
  const router = useRouter();
  const [state, setState] = useState({ status: workflow.status, revision: workflow.revision });
  const [history, setHistory] = useState<WorkflowEvent[] | null>(null);
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const can = useCallback((action: SafeWorkspaceWorkflow["permittedActions"][number]) => workflow.permittedActions.includes(action), [workflow.permittedActions]);

  const loadHistory = useCallback(async () => {
    const response = await fetch(`/api/datasets/${workflow.datasetId}/assets/${workflow.assetId}/workflow`, { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: { asset?: WorkflowAssetResponse; history?: WorkflowEvent[] } } | null;
    const parsed = workflowAssetStateSchema.safeParse(payload?.data?.asset);
    if (response.ok && parsed.success) { setState(parsed.data); setHistory(payload?.data?.history ?? []); }
    else { setError("Workflow data is unavailable. Reload the workspace."); }
  }, [workflow.assetId, workflow.datasetId]);
  const act = useCallback(async (action: SafeWorkspaceWorkflow["permittedActions"][number]) => {
    // Dirty work must finish, and the caller must read the resulting current
    // asset revision, before Submit/Resubmit use it -- a failed flush blocks
    // the action entirely rather than proceeding with stale state (a prior
    // gap: firing both flushes and immediately reusing the page-load
    // revision prop could spuriously 409 "this asset changed" against the
    // user's own just-saved edit).
    let expectedRevision = state.revision;
    if (action === "SUBMIT" || action === "RESUBMIT") {
      setBusy(true); setError(null);
      const flushed = await workspaceEngineRegistry[engine].flush(workflow.datasetId, workflow.assetId);
      if (!flushed.ok) { setBusy(false); setError("Your changes could not be saved. Try again before submitting."); return; }
      expectedRevision = flushed.assetRevision;
    }
    setBusy(true); setError(null);
    const response = await fetch(`/api/datasets/${workflow.datasetId}/assets/${workflow.assetId}/workflow`, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, expectedRevision, ...(action === "REJECT" ? { feedback } : {}) }) });
    const payload = await response.json().catch(() => null) as { data?: { asset?: WorkflowAssetResponse }; error?: { code?: string; message?: string } } | null;
    setBusy(false);
    const parsed = workflowAssetStateSchema.safeParse(payload?.data?.asset);
    if (!response.ok || !parsed.success) { setError(payload?.error?.code === "STALE_REVISION" ? "This asset changed. Reload before deciding." : payload?.error?.message ?? "Workflow action failed."); return; }
    setState(parsed.data); setFeedback(""); await loadHistory(); router.refresh();
  }, [engine, feedback, loadHistory, router, state.revision, workflow.assetId, workflow.datasetId]);
  const submitShortcut = useCallback(() => { void act("SUBMIT"); }, [act]);
  const approveShortcut = useCallback(() => { void act("APPROVE"); }, [act]);
  const validState = workflowAssetStateSchema.safeParse(state).success;
  useWorkflowShortcuts({ canSubmit: validState && can("SUBMIT") && state.status === "IN_PROGRESS", canApprove: validState && can("APPROVE") && state.status === "NEEDS_REVIEW", onSubmit: submitShortcut, onApprove: approveShortcut });
  if (!validState) return <div role="alert" className="flex items-center gap-2 text-xs text-rose-700">Workflow unavailable<Button size="sm" variant="secondary" onClick={() => { void loadHistory(); router.refresh(); }}>Reload</Button></div>;
  const submitAction = state.status === "NEW" || state.status === "READY" ? "START" : state.status === "IN_PROGRESS" ? "SUBMIT" : state.status === "REJECTED" ? "START_REWORK" : null;
  return <div className="flex items-center gap-1.5">
    <Badge variant={state.status === "REVIEWED" ? "success" : state.status === "REJECTED" ? "danger" : "info"}>{state.status.replaceAll("_", " ")}</Badge>
    {submitAction && can(submitAction) ? <Button size="sm" disabled={busy} onClick={() => void act(submitAction)}>{submitAction === "START_REWORK" ? "Start rework" : submitAction === "START" ? "Start" : "Submit"}</Button> : null}
    {state.status === "NEEDS_REVIEW" ? <>{can("OPEN_REVIEW") ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act("OPEN_REVIEW")}>Open review</Button> : null}{can("APPROVE") ? <Button size="sm" disabled={busy} onClick={() => void act("APPROVE")}>Approve</Button> : null}{can("REJECT") ? <><input aria-label="Rejection feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="Feedback required" className="w-40 rounded border border-zinc-300 px-2 py-1 text-xs" /><Button size="sm" variant="secondary" disabled={busy || !feedback.trim()} onClick={() => void act("REJECT")}>Reject</Button></> : null}</> : null}
    <Button size="sm" variant="secondary" onClick={() => { setShowHistory((value) => !value); if (!history) void loadHistory(); }}>History</Button>
    {error ? <span role="alert" className="flex items-center gap-1 text-xs text-rose-700">{error}{error.startsWith("This asset changed") ? <button type="button" className="font-semibold underline" onClick={() => { void loadHistory(); router.refresh(); }}>Reload</button> : null}</span> : null}
    {showHistory ? <div className="absolute right-3 top-16 z-40 max-h-80 w-96 overflow-y-auto rounded-xl border border-zinc-200 bg-white p-3 shadow-xl"><p className="text-sm font-bold text-zinc-900">Workflow history</p>{history?.length ? <ol className="mt-2 space-y-2">{history.map((event) => <li key={event.id} className="border-t border-zinc-100 pt-2 text-xs text-zinc-600"><b>{event.action.replaceAll("_", " ")}</b> · {event.actor.name ?? event.actor.email}<br />{event.fromStatus ?? "—"} → {event.toStatus ?? "—"}{event.feedback ? <p className="mt-1 text-zinc-800">{event.feedback}</p> : null}</li>)}</ol> : <p className="mt-2 text-xs text-zinc-500">No workflow activity yet.</p>}</div> : null}
  </div>;
}

/**
 * Account dropdown for the workspace header — mirrors the dashboard's
 * `AvatarMenu` (same trigger/outside-click/escape pattern and destinations),
 * anchored to the header's "Account" button instead of an avatar.
 */
function AccountMenu({ actor }: { actor: { email: string; name: string } | null }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (!actor) {
    return (
      <Button type="button" variant="secondary" size="sm" aria-label="User menu is not available yet" disabled>
        <UserCircle aria-hidden="true" size={17} />Account<CaretDown aria-hidden="true" size={13} weight="bold" />
      </Button>
    );
  }

  return (
    <div className="relative" ref={menuRef}>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        aria-label="Open account menu"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <UserCircle aria-hidden="true" size={17} />Account<CaretDown aria-hidden="true" size={13} weight="bold" />
      </Button>
      {open ? (
        <div role="menu" aria-label="Account menu" className="absolute right-0 z-30 mt-2 w-60 overflow-hidden rounded-xl border border-zinc-200 bg-white py-1 shadow-xl shadow-zinc-900/10">
          <div className="border-b border-zinc-100 px-3 py-2.5">
            <p className="truncate text-sm font-semibold text-zinc-900">{actor.name}</p>
            <p className="mt-0.5 truncate text-xs text-zinc-500">{actor.email}</p>
          </div>
          <Link role="menuitem" href="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none">
            <UserCircle aria-hidden="true" size={17} /> Personal information
          </Link>
          <Link role="menuitem" href="/account/password" onClick={() => setOpen(false)} className="flex items-center gap-2 px-3 py-2 text-sm text-zinc-700 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none">
            <LockKey aria-hidden="true" size={17} /> Change password
          </Link>
          <div className="mt-1 border-t border-zinc-100 px-1 pt-1"><SignOutButton className="w-full justify-start px-2 py-2 text-sm" /></div>
        </div>
      ) : null}
    </div>
  );
}
