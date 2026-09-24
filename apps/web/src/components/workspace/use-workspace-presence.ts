"use client";

import { useEffect, useRef, useState } from "react";

export type WorkspacePresenceMember = { userId: string; assetId: string | null; activity: "VIEWING" | "EDITING" };

function url(ticket: string) {
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (explicit) return `${explicit.replace(/\/$/, "")}?ticket=${encodeURIComponent(ticket)}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return window.location.port === "3000" ? `${protocol}//${window.location.hostname}:3004/?ticket=${encodeURIComponent(ticket)}` : `${protocol}//${window.location.host}/realtime?ticket=${encodeURIComponent(ticket)}`;
}

/** Ephemeral coordination only. This hook sends no annotation content or geometry. */
export function useWorkspacePresence(input: { datasetId?: string; assetId?: string | null }) {
  const [members, setMembers] = useState<WorkspacePresenceMember[]>([]);
  const activity = useRef<WorkspacePresenceMember["activity"]>("VIEWING");
  useEffect(() => {
    if (!input.datasetId) return;
    let socket: WebSocket | undefined;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let inactivity: ReturnType<typeof setTimeout> | undefined;
    const send = () => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "presence.heartbeat", datasetId: input.datasetId, assetId: input.assetId ?? undefined, activity: activity.current }));
    const editing = () => { activity.current = "EDITING"; send(); if (inactivity) clearTimeout(inactivity); inactivity = setTimeout(() => { activity.current = "VIEWING"; send(); }, 30_000); };
    const viewing = () => { activity.current = "VIEWING"; send(); };
    const editingInteraction = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      // The DOM-element check covers IMAGE's canvas and ordinary form
      // fields; TEXT's own interactive surface is a plain `<pre>` (never
      // input/textarea/contenteditable/canvas), so it instead relies on the
      // same `document.documentElement.dataset.annotationInteraction`
      // gesture flag `use-workflow-shortcuts.ts` already reads --
      // `text-engine.tsx` sets it exactly while a highlight-span drag or a
      // relation click-sequence is in progress, never while merely reading.
      if (target?.closest("textarea,input,[contenteditable='true'],canvas") || document.documentElement.dataset.annotationInteraction === "active") editing();
    };
    const connect = async () => {
      try {
        const response = await fetch("/api/realtime/ticket", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ datasetIds: [input.datasetId] }) });
        const payload = await response.json() as { data?: { token?: string } };
        if (!response.ok || !payload.data?.token || stopped) return;
        socket = new WebSocket(url(payload.data.token));
        socket.onopen = () => send();
        socket.onmessage = (event) => {
          const data = JSON.parse(event.data) as { type?: string; datasetId?: string; payload?: { members?: WorkspacePresenceMember[] } };
          if (data.datasetId === input.datasetId && data.type?.startsWith("presence.") && Array.isArray(data.payload?.members)) setMembers(data.payload.members);
        };
        socket.onclose = () => { if (!stopped) retry = setTimeout(() => void connect(), 500); };
      } catch { if (!stopped) retry = setTimeout(() => void connect(), 500); }
    };
    const heartbeat = setInterval(send, 20_000);
    window.addEventListener("pointerdown", editingInteraction);
    window.addEventListener("keydown", editingInteraction);
    window.addEventListener("blur", viewing);
    void connect();
    return () => { stopped = true; clearInterval(heartbeat); if (retry) clearTimeout(retry); if (inactivity) clearTimeout(inactivity); window.removeEventListener("pointerdown", editingInteraction); window.removeEventListener("keydown", editingInteraction); window.removeEventListener("blur", viewing); socket?.close(); };
  }, [input.assetId, input.datasetId]);
  return members;
}
