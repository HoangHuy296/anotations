"use client";

import { useState } from "react";

type Member = { id: string; name: string; email: string; role: "OWNER" | "MANAGER" | "LABELER" | "REVIEWER" };
type Invitation = { id: string; inviteeUserId: string; role: string; status: string; expiresAt: string | Date; invitee?: { email: string; name: string | null } };
const managedRoles = ["MANAGER", "LABELER", "REVIEWER"] as const;

async function readError(response: Response) {
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  return body?.error?.message ?? "The collaboration change could not be completed.";
}

/** Dataset membership is intentionally a dataset-management panel, not workspace UI. */
export function DatasetMembersPanel({ datasetId, canManage, initialMembers, initialInvitations }: { datasetId: string; canManage: boolean; initialMembers: Member[]; initialInvitations: Invitation[] }) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [invitations, setInvitations] = useState<Invitation[]>(initialInvitations);
  const [inviteeUserId, setInviteeUserId] = useState("");
  const [role, setRole] = useState<(typeof managedRoles)[number]>("LABELER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const membersResponse = await fetch(`/api/datasets/${datasetId}/members`, { credentials: "same-origin" });
    if (membersResponse.ok) setMembers((await membersResponse.json() as { data: { items: Member[] } }).data.items);
    if (canManage) {
      const invitationsResponse = await fetch(`/api/datasets/${datasetId}/invitations`, { credentials: "same-origin" });
      if (invitationsResponse.ok) setInvitations((await invitationsResponse.json() as { data: { items: Invitation[] } }).data.items);
    }
  }

  async function mutate(url: string, method: string, body?: unknown) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(url, { method, credentials: "same-origin", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      if (!response.ok) { setError(await readError(response)); return false; }
      await refresh(); return true;
    } finally { setBusy(false); }
  }
  async function invite() {
    if (!inviteeUserId.trim()) { setError("Enter an existing user identifier."); return; }
    if (await mutate(`/api/datasets/${datasetId}/invitations`, "POST", { inviteeUserId: inviteeUserId.trim(), role })) setInviteeUserId("");
  }

  return <section className="mt-8 max-w-3xl rounded-2xl border border-zinc-200 p-5">
    <div className="flex items-baseline justify-between gap-3"><div><h2 className="text-lg font-bold text-zinc-950">Collaborators</h2><p className="mt-1 text-xs text-zinc-500">Dataset roles are enforced by the server for every protected action.</p></div><span className="text-sm font-semibold text-zinc-500">{members.length}</span></div>
    <ul className="mt-4 divide-y rounded-xl border border-zinc-200">{members.map((member) => <li key={member.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 text-sm"><div><p className="font-semibold text-zinc-900">{member.name}</p><p className="text-xs text-zinc-500">{member.email}</p></div><div className="flex items-center gap-2"><span className="rounded-full bg-zinc-100 px-2 py-1 text-xs font-semibold text-zinc-600">{member.role}</span>{canManage && member.role !== "OWNER" ? <><select aria-label={`Role for ${member.email}`} defaultValue={member.role} disabled={busy} onChange={(event) => void mutate(`/api/datasets/${datasetId}/members/${member.id}`, "PATCH", { role: event.target.value })} className="rounded-lg border border-zinc-200 bg-white px-2 py-1 text-xs"><option value="MANAGER">Manager</option><option value="LABELER">Labeler</option><option value="REVIEWER">Reviewer</option></select><button type="button" disabled={busy} onClick={() => void mutate(`/api/datasets/${datasetId}/members/${member.id}`, "DELETE")} className="text-xs font-semibold text-rose-700 disabled:opacity-50">Remove</button></> : null}</div></li>)}</ul>
    {canManage ? <div className="mt-5 border-t border-zinc-100 pt-5"><h3 className="text-sm font-bold text-zinc-950">Invite collaborator</h3><div className="mt-2 flex flex-wrap gap-2"><input value={inviteeUserId} onChange={(event) => setInviteeUserId(event.target.value)} aria-label="Existing user identifier" placeholder="Existing user ID" className="min-w-52 flex-1 rounded-lg border border-zinc-200 px-3 py-2 text-sm" /><select value={role} onChange={(event) => setRole(event.target.value as (typeof managedRoles)[number])} className="rounded-lg border border-zinc-200 bg-white px-2 py-2 text-sm">{managedRoles.map((value) => <option key={value} value={value}>{value[0]}{value.slice(1).toLowerCase()}</option>)}</select><button type="button" disabled={busy} onClick={() => void invite()} className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">Invite</button></div>
      {invitations.length ? <ul className="mt-4 divide-y rounded-xl border border-zinc-200">{invitations.map((invitation) => <li key={invitation.id} className="flex items-center justify-between gap-3 px-3 py-2 text-xs"><span>{invitation.invitee?.email ?? invitation.inviteeUserId} · {invitation.role} · {invitation.status}</span>{invitation.status === "PENDING" ? <button type="button" disabled={busy} onClick={() => void mutate(`/api/datasets/${datasetId}/invitations/${invitation.id}/revoke`, "POST")} className="font-semibold text-rose-700">Revoke</button> : null}</li>)}</ul> : null}</div> : null}
    {error ? <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p> : null}
  </section>;
}
