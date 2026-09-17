"use client";

import { Bell } from "@phosphor-icons/react";
import Link from "next/link";
import { useState } from "react";

import { useNotifications } from "@/lib/collaboration/notification-client";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const count = notifications.unreadCount;
  return <div className="relative"><button type="button" aria-label={`Notifications${count ? `, ${count} unread` : ""}`} aria-expanded={open} onClick={() => setOpen((value) => !value)} className="relative grid size-9 place-items-center rounded-xl text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"><Bell size={19} aria-hidden="true" />{count ? <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-rose-600 px-1 text-[10px] font-bold text-white">{count > 99 ? "99+" : count}</span> : null}</button>{open ? <div className="absolute right-0 z-50 mt-2 w-80 rounded-xl border border-zinc-200 bg-white p-3 shadow-xl dark:border-zinc-800 dark:bg-zinc-900"><div className="flex items-center justify-between"><b className="text-sm text-zinc-950 dark:text-zinc-50">Notifications</b><button type="button" className="text-xs text-sky-700 dark:text-sky-400" onClick={() => void notifications.markAllRead()}>Mark all read</button></div><div className="mt-2 space-y-2">{notifications.loading ? <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p> : notifications.error ? <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">{notifications.error}</p> : notifications.items.length ? notifications.items.map((item) => <Link key={item.id} href={item.datasetId && item.assetId ? `/workspace/${item.datasetId}?image=${item.assetId}${item.commentId ? `&discussion=${item.commentId}` : ""}` : "#"} onClick={() => void notifications.markRead(item.id)} className="block rounded-lg p-2 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800"><b className="text-zinc-950 dark:text-zinc-50">{item.title}</b><p className="text-xs text-zinc-500 dark:text-zinc-400">{item.body}</p></Link>) : <p className="text-sm text-zinc-500 dark:text-zinc-400">No notifications.</p>}</div></div> : null}</div>;
}
