"use client";

import { X } from "@phosphor-icons/react";
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
};

function commentBody(body: string, deletedAt: string | null) {
  return deletedAt ? "This comment was deleted." : body;
}

/**
 * An overlay keeps discussion separate from workflow feedback and never adds a
 * permanent workspace column. The API remains the sole command/read boundary.
 */
export function DiscussionDrawer({ datasetId, assetId, open, onClose }: DiscussionDrawerProps) {
  const [threads, setThreads] = useState<DiscussionThread[]>([]);
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

  useEffect(() => {
    if (open) void Promise.resolve().then(load);
  }, [load, open]);

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
        className="flex h-full w-full max-w-md flex-col border-l border-zinc-200 bg-white shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
          <div>
            <h2 className="text-sm font-bold text-zinc-950">Discussion</h2>
            <p className="text-xs text-zinc-500">Asset conversation, separate from review feedback.</p>
          </div>
          <Button type="button" variant="icon" aria-label="Close discussion" onClick={onClose}>
            <X aria-hidden="true" size={18} />
          </Button>
        </div>

        {!assetId ? <p className="p-4 text-sm text-zinc-500">Select an asset to start a discussion.</p> : (
          <>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {loading && threads.length === 0 ? <p className="text-sm text-zinc-500">Loading discussion…</p> : null}
              {!loading && threads.length === 0 ? <p className="text-sm text-zinc-500">No discussion yet.</p> : null}
              {threads.map((thread) => (
                <article key={thread.id} className="rounded-lg border border-zinc-200 p-3">
                  <div className="flex items-center justify-between gap-2 text-xs text-zinc-500">
                    <span>{thread.author.name ?? thread.author.email}</span>
                    {thread.resolvedAt ? <span className="font-semibold text-emerald-700">Resolved</span> : null}
                  </div>
                  <p className={`mt-1 whitespace-pre-wrap text-sm ${thread.deletedAt ? "italic text-zinc-500" : "text-zinc-800"}`}>
                    {commentBody(thread.body, thread.deletedAt)}
                  </p>
                  {thread.replies.map((reply) => (
                    <div key={reply.id} className="mt-3 border-l-2 border-zinc-200 pl-3 text-sm">
                      <p className="text-xs text-zinc-500">{reply.author.name ?? reply.author.email}</p>
                      <p className={`mt-1 whitespace-pre-wrap ${reply.deletedAt ? "italic text-zinc-500" : "text-zinc-800"}`}>
                        {commentBody(reply.body, reply.deletedAt)}
                      </p>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="mt-3 text-xs font-semibold text-sky-700 hover:text-sky-800"
                    onClick={() => setReplyTo(thread.id)}
                  >
                    Reply
                  </button>
                </article>
              ))}
            </div>
            <div className="border-t border-zinc-200 p-4">
              {replyTo ? <p className="mb-2 text-xs text-zinc-500">Replying to this thread <button type="button" className="font-semibold text-sky-700" onClick={() => setReplyTo(null)}>Cancel</button></p> : null}
              <label className="sr-only" htmlFor="discussion-body">Discussion message</label>
              <textarea id="discussion-body" value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={10_000} placeholder="Write a comment. Mention a member with @email." className="w-full resize-y rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-sky-500" />
              {error ? <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p> : null}
              <div className="mt-2 flex justify-end"><Button type="button" size="sm" disabled={loading || !body.trim()} onClick={() => void submit()}>Send</Button></div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
