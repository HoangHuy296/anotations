"use client";

import { ChatCircleText, ClockCounterClockwise, PaperPlaneRight, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";

type CommentAuthor = { name: string | null; email: string };
type Reply = {
  id: string;
  body: string;
  deletedAt: string | null;
  author: CommentAuthor;
};
type DiscussionThread = {
  id: string;
  body: string;
  deletedAt: string | null;
  resolvedAt: string | null;
  author: CommentAuthor;
  replies: Reply[];
};

type DiscussionDrawerProps = {
  datasetId: string;
  assetId: string | null;
  open: boolean;
  onClose: () => void;
  highlightCommentId?: string | null;
  refreshKey?: number;
};
type ActivityItem = { id: string; kind: string; action: string; actor: string | null; createdAt: string };

function commentBody(body: string, deletedAt: string | null) {
  return deletedAt ? "This comment was deleted." : body;
}

/**
 * An overlay keeps discussion separate from workflow feedback and never adds a
 * permanent workspace column. The API remains the sole command/read boundary.
 */
export function DiscussionDrawer({ datasetId, assetId, open, onClose, highlightCommentId, refreshKey = 0 }: DiscussionDrawerProps) {
  const [threads, setThreads] = useState<DiscussionThread[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [tab, setTab] = useState<"discussion" | "activity">("discussion");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!assetId) {
      setThreads([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/datasets/${datasetId}/assets/${assetId}/comments`, {
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json().catch(() => null) as { data?: { items?: DiscussionThread[] }; error?: { message?: string } } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to load discussion.");
      setThreads(payload?.data?.items ?? []);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load discussion.");
    } finally {
      setLoading(false);
    }
  }, [assetId, datasetId]);

  const loadActivity = useCallback(async () => {
    if (!assetId) return setActivity([]);
    const response = await fetch(`/api/datasets/${datasetId}/assets/${assetId}/activity`, { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: { items?: ActivityItem[] } } | null;
    if (response.ok) setActivity(payload?.data?.items ?? []);
  }, [assetId, datasetId]);

  useEffect(() => {
    if (open) void Promise.resolve().then(() => { void load(); if (highlightCommentId) setTab("discussion"); });
  }, [highlightCommentId, load, open, refreshKey]);

  useEffect(() => { if (open && tab === "activity") void Promise.resolve().then(() => void loadActivity()); }, [loadActivity, open, refreshKey, tab]);

  const submit = useCallback(async () => {
    if (!assetId || !body.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/datasets/${datasetId}/assets/${assetId}/comments`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim(), ...(replyTo ? { parentId: replyTo } : {}) }),
      });
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? "Unable to save comment.");
      setBody("");
      setReplyTo(null);
      await load();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to save comment.");
    } finally {
      setLoading(false);
    }
  }, [assetId, body, datasetId, load, replyTo]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-zinc-950/20" role="presentation" onMouseDown={onClose}>
      <aside
        aria-label="Discussion"
        className="flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-400"><ChatCircleText aria-hidden="true" size={19} weight="duotone" /></span>
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-zinc-950 dark:text-zinc-50">Discussion</h2>
              <p className="mt-1 max-w-[30ch] text-xs leading-5 text-zinc-500 dark:text-zinc-400">Conversation and read-only activity for this asset.</p>
            </div>
          </div>
          <Button type="button" variant="icon" aria-label="Close discussion" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </Button>
        </div>

        <div role="tablist" aria-label="Discussion views" className="flex gap-1 border-b border-zinc-200 px-4 py-2 dark:border-zinc-800">
          <button type="button" role="tab" aria-selected={tab === "discussion"} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${tab === "discussion" ? "bg-sky-50 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300" : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`} onClick={() => setTab("discussion")}><ChatCircleText aria-hidden="true" size={15} />Discussion</button>
          <button type="button" role="tab" aria-selected={tab === "activity"} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${tab === "activity" ? "bg-sky-50 text-sky-800 dark:bg-sky-950/70 dark:text-sky-300" : "text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"}`} onClick={() => { setTab("activity"); void loadActivity(); }}><ClockCounterClockwise aria-hidden="true" size={15} />Activity</button>
        </div>
        {!assetId ? <div className="grid flex-1 place-items-center p-6 text-center"><div><span className="mx-auto grid size-11 place-items-center rounded-2xl border border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900"><ChatCircleText aria-hidden="true" size={21} /></span><p className="mt-3 text-sm font-semibold text-zinc-800 dark:text-zinc-200">Select an asset</p><p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Choose an asset to read or add a discussion.</p></div></div> : tab === "activity" ? <div className="min-h-0 flex-1 overflow-y-auto p-4">{activity.length ? <ol className="space-y-3">{activity.map((item) => <li key={item.id} className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-3 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-400"><b className="text-zinc-900 dark:text-zinc-100">{item.action.replaceAll("_", " ")}</b>{item.actor ? ` · ${item.actor}` : ""}<br /><time className="mt-1 inline-block text-zinc-400 dark:text-zinc-500">{new Date(item.createdAt).toLocaleString()}</time></li>)}</ol> : <p className="text-sm text-zinc-500 dark:text-zinc-400">No activity yet.</p>}</div> : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {loading && threads.length === 0 ? <div aria-label="Loading discussion" className="space-y-3">{[0, 1].map((row) => <div key={row} className="animate-pulse rounded-xl border border-zinc-100 p-4 dark:border-zinc-800"><div className="h-3 w-2/5 rounded bg-zinc-100 dark:bg-zinc-800" /><div className="mt-3 h-3 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800" /><div className="mt-2 h-3 w-3/5 rounded bg-zinc-100 dark:bg-zinc-800" /></div>)}</div> : null}
              {!loading && threads.length === 0 ? <div className="grid min-h-48 place-items-center text-center"><div><span className="mx-auto grid size-11 place-items-center rounded-2xl border border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900"><ChatCircleText aria-hidden="true" size={21} /></span><p className="mt-3 text-sm font-semibold text-zinc-800 dark:text-zinc-200">Start the conversation</p><p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Comments stay attached to this asset for the team.</p></div></div> : null}
              {threads.map((thread) => (
                <article key={thread.id} className={`rounded-xl border p-3.5 shadow-sm shadow-zinc-900/[0.025] ${highlightCommentId === thread.id || thread.replies.some((reply) => reply.id === highlightCommentId) ? "border-sky-500 ring-2 ring-sky-100 dark:ring-sky-950" : "border-zinc-200 dark:border-zinc-800"}`}>
                  <div className="flex items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                    <span className="flex min-w-0 items-center gap-2"><span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-zinc-100 text-[10px] font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{(thread.author.name ?? thread.author.email).slice(0, 1).toUpperCase()}</span><span className="truncate font-medium">{thread.author.name ?? thread.author.email}</span></span>
                    {thread.resolvedAt ? <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400">Resolved</span> : null}
                  </div>
                  <p className={`mt-2 whitespace-pre-wrap text-sm leading-6 ${thread.deletedAt ? "italic text-zinc-500 dark:text-zinc-400" : "text-zinc-800 dark:text-zinc-200"}`}>
                    {commentBody(thread.body, thread.deletedAt)}
                  </p>
                  {thread.replies.map((reply) => (
                    <div key={reply.id} className="mt-3 rounded-r-lg border-l-2 border-sky-200 bg-zinc-50/70 py-2 pl-3 pr-2 text-sm dark:border-sky-900 dark:bg-zinc-800/40">
                      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">{reply.author.name ?? reply.author.email}</p>
                      <p className={`mt-1 whitespace-pre-wrap leading-5 ${reply.deletedAt ? "italic text-zinc-500 dark:text-zinc-400" : "text-zinc-800 dark:text-zinc-200"}`}>
                        {commentBody(reply.body, reply.deletedAt)}
                      </p>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="mt-3 rounded-lg px-2 py-1 text-xs font-semibold text-sky-700 hover:bg-sky-50 hover:text-sky-800 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-sky-400 dark:hover:bg-sky-950/50 dark:hover:text-sky-300"
                    onClick={() => setReplyTo(thread.id)}
                  >
                    Reply
                  </button>
                </article>
              ))}
            </div>
            <div className="border-t border-zinc-200 bg-zinc-50/70 p-4 dark:border-zinc-800 dark:bg-zinc-900/60">
              {replyTo ? <p className="mb-2 text-xs text-zinc-500 dark:text-zinc-400">Replying to this thread <button type="button" className="font-semibold text-sky-700 dark:text-sky-400" onClick={() => setReplyTo(null)}>Cancel</button></p> : null}
              <label className="sr-only" htmlFor="discussion-body">Discussion message</label>
              <textarea id="discussion-body" value={body} onChange={(event) => setBody(event.target.value)} rows={3} maxLength={10_000} placeholder="Write a comment…" className="w-full resize-y rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-sm leading-5 text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-sky-500 focus:ring-2 focus:ring-sky-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-500 dark:focus:ring-sky-950" />
              {error ? <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-400">{error}</p> : null}
              <div className="mt-2 flex justify-end"><Button type="button" size="sm" disabled={loading || !body.trim()} onClick={() => void submit()}><PaperPlaneRight aria-hidden="true" size={14} />Send</Button></div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
