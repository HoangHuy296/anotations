import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { CollaborationOutboxEventType, DatasetMemberRole, UserRole } from "@internal/db";

import { createOrReuseCollaborationOutboxEvent, enqueueCollaborationOutboxDispatch } from "@/lib/collaboration/collaboration-outbox-service";
import { enqueueMembershipDispatches, removeDatasetMember } from "@/lib/collaboration/dataset-membership-service";
import { db } from "@/lib/db";
import { verifyRealtimeTicket } from "@/lib/realtime/ticket-service";
import { addWorkspaceMember, cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

const enabled = process.env.COMPOSE_REALTIME_ACCEPTANCE === "1";
const webOrigin = process.env.COMPOSE_WEB_ORIGIN ?? "http://127.0.0.1:3000";
const realtimeOrigin = process.env.COMPOSE_REALTIME_ORIGIN ?? "ws://127.0.0.1:3004";
type GatewayEvent = { datasetId?: string };

function waitFor(condition: () => boolean, message: string, timeoutMs = 15_000) {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (condition()) { clearInterval(timer); resolve(); }
      else if (Date.now() > deadline) { clearInterval(timer); reject(new Error(message)); }
    }, 25);
  });
}

async function loginAndTicket(email: string, password: string, datasetIds: string[]) {
  const login = await fetch(`${webOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(login.status, 200, "fixture user must authenticate through running web service");
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie, "login must create a session cookie");
  const ticket = await fetch(`${webOrigin}/api/realtime/ticket`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ datasetIds }) });
  assert.equal(ticket.status, 200, "running web service must issue an authorized realtime ticket");
  return { token: (await ticket.json() as { data: { token: string } }).data.token, cookie };
}

function connect(ticket: string) {
  const socket = new WebSocket(`${realtimeOrigin}/?ticket=${encodeURIComponent(ticket)}`);
  const messages: unknown[] = [];
  let closed = false;
  socket.addEventListener("message", (event) => messages.push(JSON.parse(String(event.data))));
  socket.addEventListener("close", () => { closed = true; });
  return { socket, messages, get closed() { return closed; } };
}

test("T067 Compose: durable membership revocation removes every affected socket while another scope remains", { skip: !enabled, timeout: 60_000 }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const member = await createWorkspaceUser(UserRole.LABELER);
  const primary = await createWorkspaceDataset(owner.id);
  const secondary = await createWorkspaceDataset(owner.id);
  const actor = { id: owner.id, email: owner.email, name: owner.name, role: owner.role };
  const sockets: ReturnType<typeof connect>[] = [];
  try {
    await Promise.all([
      addWorkspaceMember(primary.id, member.id, DatasetMemberRole.LABELER),
      addWorkspaceMember(secondary.id, member.id, DatasetMemberRole.LABELER),
    ]);
    // Independent tickets model separate browser tabs. The web API, rather than
    // a test signer, remains the ticket issuer under test.
    const [firstSession, secondSession, primaryOnlySession] = await Promise.all([
      loginAndTicket(member.email, member.password, [primary.id, secondary.id]),
      loginAndTicket(member.email, member.password, [primary.id, secondary.id]),
      loginAndTicket(member.email, member.password, [primary.id]),
    ]);
    assert.ok(verifyRealtimeTicket(firstSession.token), "web-issued ticket must validate against the resolved integration secret");
    sockets.push(connect(firstSession.token), connect(secondSession.token), connect(primaryOnlySession.token));
    await Promise.all(sockets.map(({ socket }) => new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("close", (event) => reject(new Error(`realtime connection closed during upgrade (${event.code}: ${event.reason || "no reason"})`)), { once: true });
      socket.addEventListener("error", () => reject(new Error("realtime connection failed during upgrade")), { once: true });
    })));

    // This invokes the actual membership mutation, which persists its outbox
    // intent transactionally; enqueue happens only after the transaction.
    const removal = await removeDatasetMember(actor, { datasetId: primary.id, userId: member.id });
    await enqueueMembershipDispatches(removal);
    await waitFor(() => sockets[2].closed, "the primary-only session must close after its final scope is revoked");
    assert.equal(sockets[0].closed, false, "first multi-scope session retains secondary dataset");
    assert.equal(sockets[1].closed, false, "second multi-scope session retains secondary dataset");
    const deniedTicket = await fetch(`${webOrigin}/api/realtime/ticket`, { method: "POST", headers: { "content-type": "application/json", cookie: firstSession.cookie }, body: JSON.stringify({ datasetIds: [primary.id] }) });
    assert.equal(deniedTicket.status, 404, "REST scope access is denied independently of an old socket/ticket");

    const removedScopeEvent = await db.$transaction((tx) => createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: primary.id, actorId: owner.id, recipientUserId: member.id, type: CollaborationOutboxEventType.NOTIFICATION_CREATED,
      dedupeKey: `t067-removed-${primary.id}`, payload: { reason: "t067-removed-scope" },
    }));
    await enqueueCollaborationOutboxDispatch(removedScopeEvent.jobId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(sockets[0].messages.some((message) => (message as GatewayEvent).datasetId === primary.id), false, "revoked first tab must not receive later primary events");
    assert.equal(sockets[1].messages.some((message) => (message as GatewayEvent).datasetId === primary.id), false, "revoked second tab must not receive later primary events");

    // The gateway intentionally consumes revocation as a control signal rather
    // than delivering it to the removed client. A durable secondary-scope
    // outbox job proves the two surviving tabs retained only that scope.
    const event = await db.$transaction((tx) => createOrReuseCollaborationOutboxEvent(tx, {
      datasetId: secondary.id, actorId: owner.id, recipientUserId: member.id, type: CollaborationOutboxEventType.NOTIFICATION_CREATED,
      dedupeKey: `t067-secondary-${primary.id}`, payload: { reason: "t067-secondary" },
    }));
    await enqueueCollaborationOutboxDispatch(event.jobId);
    await waitFor(() => sockets[0].messages.some((message) => (message as GatewayEvent).datasetId === secondary.id) && sockets[1].messages.some((message) => (message as GatewayEvent).datasetId === secondary.id), "secondary dataset delivery must survive primary revocation");

    const stillRemoved = await db.datasetMember.findUnique({ where: { datasetId_userId: { datasetId: primary.id, userId: member.id } } });
    assert.equal(stillRemoved, null, "PostgreSQL membership remains authoritative after socket revocation");
  } finally {
    sockets.forEach(({ socket }) => socket.close());
    await cleanupWorkspaceFixture([owner.id, member.id], [primary.id, secondary.id]);
  }
});
