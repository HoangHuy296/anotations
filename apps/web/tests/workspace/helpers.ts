import { randomBytes } from "node:crypto";

import { DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

export function workspaceUnique(prefix: string) {
  return `${prefix}-${Date.now()}-${randomBytes(5).toString("hex")}`;
}

export async function createWorkspaceUser(role: UserRole = UserRole.LABELER) {
  const marker = workspaceUnique("workspace-user");
  const password = "workspace-test-password";
  const user = await db.user.create({ data: { email: `${marker}@test.invalid`, name: marker, role, passwordHash: await hashPassword(password) }, select: { id: true, email: true, name: true, role: true } });
  return { ...user, name: user.name ?? user.email, password };
}

export async function createWorkspaceDataset(ownerId: string) {
  return db.dataset.create({ data: { ownerId, name: workspaceUnique("workspace-dataset") }, select: { id: true, name: true } });
}

export async function addWorkspaceMember(datasetId: string, userId: string, role: DatasetMemberRole) {
  return db.datasetMember.create({ data: { datasetId, userId, role } });
}

export async function createWorkspaceSessionPair(role: UserRole = UserRole.MANAGER) {
  const first = await createWorkspaceUser(role);
  const second = await createWorkspaceUser(role);
  return { first, second };
}

export async function createWorkspaceAssetBatch(datasetId: string, count = 250) {
  const marker = workspaceUnique("asset-batch");
  await db.asset.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      datasetId,
      modality: Modality.IMAGE,
      filename: `${marker}-${String(index).padStart(4, "0")}.png`,
      mimeType: "image/png",
      sourceFingerprint: `${marker}-${index}`,
      batchIndex: Math.floor(index / 100),
      orderIndex: index,
      status: index % 3 === 0 ? "COMPLETED" : index % 3 === 1 ? "IN_PROGRESS" : "NEW",
    })),
  });
  return marker;
}

export async function createImageAsset(datasetId: string, overrides: Partial<{ filename: string; width: number; height: number }> = {}) {
  return db.asset.create({ data: { datasetId, modality: Modality.IMAGE, filename: overrides.filename ?? "image.png", mimeType: "image/png", width: overrides.width ?? 1000, height: overrides.height ?? 800, sourceFingerprint: workspaceUnique("image") }, select: { id: true, revision: true, filename: true } });
}

export async function createImageLabel(datasetId: string, name = "object") {
  return db.label.create({ data: { datasetId, modality: Modality.IMAGE, name, normalizedName: workspaceUnique(name), color: "#0EA5E9" }, select: { id: true, name: true } });
}

/** Calls the actual route handler with credentials and returns only the opaque cookie header for follow-up HTTP requests. */
export async function loginThroughHttp(email: string, password: string) {
  const { POST } = await import("@/app/api/auth/login/route");
  const response = await POST(new Request("http://fieldframe.test/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) }));
  const cookie = response.headers.get("set-cookie");
  return { response, cookie: cookie ? cookie.split(";")[0] : null };
}

export async function cleanupWorkspaceFixture(userIds: string[], datasetIds: string[]) {
  await db.annotation.deleteMany({ where: { datasetId: { in: datasetIds } } });
  await db.dataset.deleteMany({ where: { id: { in: datasetIds } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
}
