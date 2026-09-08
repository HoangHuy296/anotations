"use client";

import type { WorkspacePresenceMember } from "@/components/workspace/use-workspace-presence";

export function CollaborationPresence({ members }: { members: WorkspacePresenceMember[] }) {
  if (!members.length) return null;
  const visible = members.slice(0, 4);
  const detail = members.map((member) => `${member.userId.slice(0, 8)} · ${member.activity === "EDITING" ? "Editing this asset" : "Viewing"}`).join("; ");
  return <div className="flex items-center" aria-label={`Presence: ${detail}`} title={detail}>
    <div className="flex -space-x-2" aria-hidden="true">{visible.map((member) => <span key={member.userId} className={`grid size-7 place-items-center rounded-full border-2 border-white text-[9px] font-bold text-white ${member.activity === "EDITING" ? "bg-emerald-600" : "bg-sky-600"}`}>{member.userId.slice(0, 2).toUpperCase()}</span>)}</div>
    {members.length > visible.length ? <span className="ml-1 text-xs text-zinc-500">+{members.length - visible.length}</span> : null}
  </div>;
}
