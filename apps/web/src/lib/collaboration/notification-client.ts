"use client";

import { useCallback, useEffect, useState } from "react";

import type { SafeNotification } from "@/types/collaboration";

type NotificationPage = { items: SafeNotification[]; unreadCount: number; nextCursor: string | null };

/** REST-only notification state; future realtime may call `invalidate` without owning state. */
export function useNotifications() {
  const [page, setPage] = useState<NotificationPage>({ items: [], unreadCount: 0, nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(async () => {
    const response = await fetch("/api/notifications?limit=25", { credentials: "same-origin", cache: "no-store" });
    const payload = await response.json().catch(() => null) as { data?: NotificationPage } | null;
    if (response.ok && payload?.data) { setPage(payload.data); setError(null); }
    else setError("Unable to load notifications.");
    setLoading(false);
  }, []);
  useEffect(() => { void Promise.resolve().then(refetch); }, [refetch]);
  const markRead = useCallback(async (id: string) => { await fetch(`/api/notifications/${id}/read`, { method: "POST", credentials: "same-origin" }); await refetch(); }, [refetch]);
  const markAllRead = useCallback(async () => { await fetch("/api/notifications/read-all", { method: "POST", credentials: "same-origin" }); await refetch(); }, [refetch]);
  return { ...page, loading, error, refetch, invalidate: refetch, markRead, markAllRead };
}
