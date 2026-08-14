import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { db } from "@/lib/db";

export const aiHttpEnabled = Boolean(process.env.AI_HTTP_BASE_URL);
export const aiHttpSkipReason = "AI route HTTP integration skipped: set AI_HTTP_BASE_URL to a reachable web server.";

const baseUrl = process.env.AI_HTTP_BASE_URL ?? "";
const password = randomBytes(24).toString("base64url");

function sessionCookie(response: Response) {
  const match = /^fieldframe_session=([^;]+)/i.exec(response.headers.get("set-cookie") ?? "");
  assert.ok(match?.[1], "normal login must issue an opaque session cookie");
  return `fieldframe_session=${match[1]}`;
}

export function uniqueTestEmail(role: string) {
  return `ai-${role}-${Date.now()}-${randomBytes(6).toString("hex")}@test.invalid`;
}

export async function signupAndLogin(role: "MANAGER" | "LABELER" = "MANAGER") {
  const email = uniqueTestEmail(role.toLowerCase());
  const signup = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "AI integration test", role }),
  });
  assert.equal(signup.status, 201);
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(login.status, 200);
  const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  return { email, userId: user.id, cookie: sessionCookie(login) };
}

export function request(path: string, init: RequestInit = {}) {
  return fetch(`${baseUrl}${path}`, init);
}

/** Dataset + one Asset + one active AiModel, owned by `ownerId`. */
export async function createAiTaskFixture(ownerId: string) {
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const dataset = await db.dataset.create({ data: { ownerId, name: `ai-fixture-${suffix}` }, select: { id: true } });
  const asset = await db.asset.create({
    data: {
      datasetId: dataset.id,
      modality: "IMAGE",
      filename: `fixture-${suffix}.jpg`,
      mimeType: "image/jpeg",
      sourceFingerprint: `ai-fixture-${suffix}`,
    },
    select: { id: true },
  });
  const model = await db.aiModel.create({
    data: { key: `ai-fixture-model-${suffix}`, displayName: "Fixture Model", provider: "aioz-company", modality: "IMAGE", taskType: "DETECT_OBJECTS", isActive: true },
    select: { id: true },
  });
  return { datasetId: dataset.id, assetId: asset.id, modelId: model.id };
}
