import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { DatasetMemberRole, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { acceptShareLink, createDatasetShareLink, hashShareToken, listDatasetShareLinks, MAX_ACTIVE_SHARE_LINKS, previewShareLink, revokeDatasetShareLink, ShareLinkError, shareLinkState } from "@/lib/collaboration/share-link-service";
import { addWorkspaceMember, cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser } from "./helpers";

const enabled = process.env.WORKSPACE_INTEGRATION_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const rejects = (promise: Promise<unknown>, code: ShareLinkError["code"]) => assert.rejects(promise, (error: unknown) => error instanceof ShareLinkError && error.code === code);

test("share link state is derived from revocation, expiry and the use limit", () => {
  const base = { revokedAt: null, expiresAt: new Date(Date.now() + 60_000), maxUses: null, useCount: 0 };
  assert.equal(shareLinkState(base), "ACTIVE");
  assert.equal(shareLinkState({ ...base, revokedAt: new Date() }), "REVOKED");
  assert.equal(shareLinkState({ ...base, expiresAt: new Date(Date.now() - 1) }), "EXPIRED");
  assert.equal(shareLinkState({ ...base, maxUses: 2, useCount: 2 }), "EXHAUSTED");
  assert.equal(shareLinkState({ ...base, maxUses: 2, useCount: 1 }), "ACTIVE");
  assert.equal(hashShareToken("a").length, 64);
});

test("only an owner or manager creates a link, only its hash is stored, and the raw token is never listed", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
    await rejects(createDatasetShareLink(labeler, { datasetId: dataset.id, expiresInDays: 7, maxUses: null }), "FORBIDDEN");
    const { link, token } = await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 7, maxUses: null });
    assert.equal(link.role, "LABELER");
    assert.equal(link.state, "ACTIVE");
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    const row = await db.datasetShareLink.findUniqueOrThrow({ where: { id: link.id } });
    assert.equal(row.tokenHash, hashShareToken(token));
    assert.notEqual(row.tokenHash, token);
    assert.ok(!JSON.stringify(row).includes(token), "the raw token is never persisted");
    assert.ok(!JSON.stringify(await listDatasetShareLinks(owner, dataset.id)).includes(token), "listing never exposes the token");
    await rejects(listDatasetShareLinks(labeler, dataset.id), "FORBIDDEN");
  } finally { await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]); }
});

test("joining adds the user as a LABELER, notifies the link creator, and is idempotent", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const guest = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const { link, token } = await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: null });
    assert.deepEqual(await previewShareLink(guest, token), { datasetId: dataset.id, datasetName: dataset.name, ownerName: owner.name ?? owner.email, role: "LABELER", alreadyMember: false });

    const joined = await acceptShareLink(guest, token);
    assert.equal(joined.alreadyMember, false);
    const member = await db.datasetMember.findUniqueOrThrow({ where: { datasetId_userId: { datasetId: dataset.id, userId: guest.id } } });
    assert.equal(member.role, DatasetMemberRole.LABELER);
    assert.equal((await db.datasetShareLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 1);
    const notices = await db.notification.findMany({ where: { userId: owner.id, datasetId: dataset.id }, select: { title: true, actorId: true } });
    assert.deepEqual(notices.map((notice) => notice.title), ["Joined via share link"]);
    assert.equal(notices[0]!.actorId, guest.id);

    // Opening the link again, or as the owner, consumes nothing and changes no role.
    assert.equal((await acceptShareLink(guest, token)).alreadyMember, true);
    assert.equal((await acceptShareLink(owner, token)).alreadyMember, true);
    assert.equal((await db.datasetShareLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 1);
    assert.equal((await previewShareLink(guest, token))?.alreadyMember, true);
  } finally { await cleanupWorkspaceFixture([owner.id, guest.id], [dataset.id]); }
});

test("a link can never grant more than LABELER, even if its stored role is tampered with", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const guest = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const { link, token } = await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: null });
    await db.datasetShareLink.update({ where: { id: link.id }, data: { role: DatasetMemberRole.MANAGER } });
    await acceptShareLink(guest, token);
    assert.equal((await db.datasetMember.findUniqueOrThrow({ where: { datasetId_userId: { datasetId: dataset.id, userId: guest.id } } })).role, DatasetMemberRole.LABELER);
  } finally { await cleanupWorkspaceFixture([owner.id, guest.id], [dataset.id]); }
});

test("expired, revoked, exhausted and unknown links are all refused identically", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const [a, b, c, d] = await Promise.all([UserRole.LABELER, UserRole.LABELER, UserRole.LABELER, UserRole.LABELER].map((role) => createWorkspaceUser(role)));
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const expired = await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: null });
    await db.datasetShareLink.update({ where: { id: expired.link.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await rejects(acceptShareLink(a!, expired.token), "INVALID_LINK");
    assert.equal(await previewShareLink(a!, expired.token), null);

    const revoked = await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: null });
    await revokeDatasetShareLink(owner, { datasetId: dataset.id, linkId: revoked.link.id });
    await rejects(acceptShareLink(a!, revoked.token), "INVALID_LINK");

    const single = await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: 1 });
    await acceptShareLink(b!, single.token);
    await rejects(acceptShareLink(c!, single.token), "INVALID_LINK");
    assert.equal(await db.datasetMember.count({ where: { datasetId: dataset.id, userId: c!.id } }), 0);

    await rejects(acceptShareLink(d!, "A".repeat(43)), "INVALID_LINK");
    assert.equal(await previewShareLink(d!, "A".repeat(43)), null);
    assert.equal(await db.datasetMember.count({ where: { datasetId: dataset.id, userId: { in: [a!.id, c!.id, d!.id] } } }), 0);
  } finally { await cleanupWorkspaceFixture([owner.id, a!.id, b!.id, c!.id, d!.id], [dataset.id]); }
});

test("concurrent joins never exceed the use limit", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const guests = await Promise.all([1, 2, 3, 4].map(() => createWorkspaceUser(UserRole.LABELER)));
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const { link, token } = await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: 2 });
    const outcomes = await Promise.allSettled(guests.map((guest) => acceptShareLink(guest, token)));
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 2);
    assert.equal((await db.datasetShareLink.findUniqueOrThrow({ where: { id: link.id } })).useCount, 2);
    assert.equal(await db.datasetMember.count({ where: { datasetId: dataset.id, userId: { in: guests.map((guest) => guest.id) } } }), 2);
  } finally { await cleanupWorkspaceFixture([owner.id, ...guests.map((guest) => guest.id)], [dataset.id]); }
});

test("a dataset holds a bounded number of active links", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    for (let index = 0; index < MAX_ACTIVE_SHARE_LINKS; index += 1) await createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: null });
    await rejects(createDatasetShareLink(owner, { datasetId: dataset.id, expiresInDays: 1, maxUses: null }), "LIMIT");
  } finally { await cleanupWorkspaceFixture([owner.id], [dataset.id]); }
});
