"use client";

import { Bell, Check, Checks, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useNotifications } from "@/lib/collaboration/notification-client";

function notificationHref(item: { datasetId?: string | null; assetId?: string | null; commentId?: string | null }) {
  if (!item.datasetId || !item.assetId) return "#";
  return `/workspace/${item.datasetId}?image=${item.assetId}${item.commentId ? `&discussion=${item.commentId}` : ""}`;
}

function notificationTime(createdAt: string) {
  const elapsed = Math.max(0, Date.now() - new Date(createdAt).getTime());
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(createdAt).toLocaleDateString();
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const notifications = useNotifications();
  const count = notifications.unreadCount;

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-label={`Notifications${count ? `, ${count} unread` : ""}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className="relative grid size-9 place-items-center rounded-xl text-zinc-600 transition-colors hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-zinc-400 dark:hover:bg-zinc-800"
      >
        <Bell size={19} aria-hidden="true" />
        {count > 0 ? <span className="absolute -right-1 -top-1 grid min-h-4 min-w-4 place-items-center rounded-full bg-rose-600 px-1 text-[10px] font-bold leading-none text-white">{count > 99 ? "99+" : count}</span> : null}
      </button>

      {open ? (
        <section role="dialog" aria-label="Notifications" className="absolute right-0 z-50 mt-2 flex max-h-[min(34rem,calc(100dvh-5rem))] w-[min(22rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_22px_70px_-28px_rgba(24,24,27,0.42)] dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/50">
          <header className="flex items-center gap-3 border-b border-zinc-100 px-4 py-3.5 dark:border-zinc-800">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-400"><Bell aria-hidden="true" size={18} weight="duotone" /></span>
            <div className="min-w-0 flex-1">
              <h2 className="text-sm font-bold text-zinc-950 dark:text-zinc-50">Notifications</h2>
              <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{count ? `${count} unread update${count === 1 ? "" : "s"}` : "You’re all caught up"}</p>
            </div>
            {count > 0 ? <button type="button" onClick={() => void notifications.markAllRead()} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-sky-700 transition hover:bg-sky-50 focus-visible:outline-2 focus-visible:outline-sky-500 dark:text-sky-400 dark:hover:bg-sky-950/60"><Checks aria-hidden="true" size={15} />Mark all read</button> : null}
            <button type="button" aria-label="Close notifications" onClick={() => setOpen(false)} className="grid size-7 shrink-0 place-items-center rounded-lg text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:outline-2 focus-visible:outline-sky-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"><X aria-hidden="true" size={15} /></button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {notifications.loading ? (
              <div aria-label="Loading notifications" className="space-y-2 p-1">
                {[0, 1, 2].map((row) => <div key={row} className="animate-pulse rounded-xl border border-zinc-100 p-3 dark:border-zinc-800"><div className="h-3 w-2/5 rounded bg-zinc-100 dark:bg-zinc-800" /><div className="mt-2 h-3 w-4/5 rounded bg-zinc-100 dark:bg-zinc-800" /></div>)}
              </div>
            ) : notifications.error ? (
              <p role="alert" className="m-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{notifications.error}</p>
            ) : notifications.items.length ? (
              <ul className="space-y-1">
                {notifications.items.map((item) => (
                  <li key={item.id}>
                    <Link href={notificationHref(item)} aria-disabled={item.unavailable || !item.datasetId || !item.assetId} onClick={(event) => { if (item.unavailable || !item.datasetId || !item.assetId) event.preventDefault(); else { if (!item.readAt) void notifications.markRead(item.id); setOpen(false); } }} className={`group flex gap-3 rounded-xl p-3 transition-colors focus-visible:outline-2 focus-visible:outline-sky-500 ${item.readAt ? "hover:bg-zinc-50 dark:hover:bg-zinc-800/70" : "bg-sky-50/75 hover:bg-sky-50 dark:bg-sky-950/35 dark:hover:bg-sky-950/55"} ${item.unavailable ? "cursor-default opacity-60" : ""}`}>
                      <span className={`mt-1.5 size-2 shrink-0 rounded-full ${item.readAt ? "bg-transparent" : "bg-sky-600 dark:bg-sky-400"}`} aria-label={item.readAt ? undefined : "Unread"} />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-3">
                          <span className={`text-sm leading-5 ${item.readAt ? "font-medium text-zinc-800 dark:text-zinc-200" : "font-semibold text-zinc-950 dark:text-zinc-50"}`}>{item.title}</span>
                          <time dateTime={item.createdAt} className="shrink-0 pt-0.5 text-[10px] text-zinc-400 dark:text-zinc-500">{notificationTime(item.createdAt)}</time>
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-zinc-600 dark:text-zinc-400">{item.body}</span>
                        {item.unavailable ? <span className="mt-1.5 block text-[10px] font-medium text-zinc-400 dark:text-zinc-500">This item is no longer available.</span> : null}
                        {!item.readAt ? <span className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold text-sky-700 dark:text-sky-400"><Check aria-hidden="true" size={12} />Unread</span> : null}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="grid min-h-48 place-items-center px-5 py-8 text-center">
                <div><span className="mx-auto grid size-11 place-items-center rounded-2xl border border-zinc-200 bg-zinc-50 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800"><Bell aria-hidden="true" size={21} weight="duotone" /></span><p className="mt-3 text-sm font-semibold text-zinc-800 dark:text-zinc-200">No notifications yet</p><p className="mt-1 text-xs leading-5 text-zinc-500 dark:text-zinc-400">Updates about your annotation work will appear here.</p></div>
              </div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}
