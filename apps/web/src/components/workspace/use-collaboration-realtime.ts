"use client";

import { useEffect, useRef } from "react";

type Options = { datasetIds: string[]; onInvalidate: () => void };

/**
 * Presence events (heartbeat/join/leave) only carry the member list and are consumed by `useWorkspacePresence`; they never change server-rendered
 * state. Treating them as invalidations made every 20 s heartbeat run `router.refresh()`, which re-applied the first server page to the video store.
 */
export function isInvalidatingGatewayMessage(raw: unknown): boolean {
  if (typeof raw !== "string") return true;
  try {
    const type = (JSON.parse(raw) as { type?: unknown } | null)?.type;
    return !(typeof type === "string" && type.startsWith("presence."));
  } catch { return true; }
}

function gatewayUrl(ticket: string) {
  const explicit = process.env.NEXT_PUBLIC_REALTIME_URL;
  if (explicit) return `${explicit.replace(/\/$/, "")}?ticket=${encodeURIComponent(ticket)}`;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  // Normal Compose exposes the private gateway on :3004; Review uses nginx.
  const base = window.location.port === "3000"
    ? `${protocol}//${window.location.hostname}:3004/`
    : `${protocol}//${window.location.host}/realtime`;
  return `${base}?ticket=${encodeURIComponent(ticket)}`;
}

/** Delivery is an invalidation hint only: authoritative state is refetched via Next.js/REST. */
export function useCollaborationRealtime({ datasetIds, onInvalidate }: Options) {
  const callback = useRef(onInvalidate);
  useEffect(() => { callback.current = onInvalidate; }, [onInvalidate]);
  const scopeKey = datasetIds.slice().sort().join(",");
  useEffect(() => {
    if (!scopeKey) return;
    let stopped = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    let hasConnected = false;
    const connect = async () => {
      try {
        const response = await fetch("/api/realtime/ticket", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ datasetIds: scopeKey.split(",") }) });
        const payload = await response.json() as { data?: { token?: string } };
        if (!response.ok || !payload.data?.token || stopped) return;
        socket = new WebSocket(gatewayUrl(payload.data.token));
        socket.onmessage = (event) => { if (isInvalidatingGatewayMessage(event.data)) callback.current(); };
        socket.onopen = () => {
          const reconnected = hasConnected;
          hasConnected = true;
          delay = 500;
          // Delivery is intentionally at-least-once and may be missed while
          // offline. A successful reconnect therefore invalidates the current
          // Next.js projection even when no subsequent gateway event arrives.
          if (reconnected) callback.current();
        };
        socket.onclose = () => {
          if (!stopped) { retry = setTimeout(() => void connect(), delay); delay = Math.min(delay * 2, 10_000); }
        };
      } catch {
        if (!stopped) { retry = setTimeout(() => void connect(), delay); delay = Math.min(delay * 2, 10_000); }
      }
    };
    void connect();
    return () => { stopped = true; if (retry) clearTimeout(retry); socket?.close(); };
  }, [scopeKey]); // Scope changes intentionally reconnect for a fresh ticket.
}
