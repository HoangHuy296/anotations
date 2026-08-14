import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after } from "node:test";

import { db } from "@/lib/db";
import { aiHttpEnabled, aiHttpSkipReason, request, signupAndLogin } from "./helpers";

const cleanupModelIds: string[] = [];
after(async () => {
  if (cleanupModelIds.length) await db.aiModel.deleteMany({ where: { id: { in: cleanupModelIds } } });
});

test("GET /api/ai/models returns only active models with the safe DTO shape", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const active = await db.aiModel.create({
    data: { key: `ai-models-active-${suffix}`, displayName: "Active Fixture Model", provider: "aioz-company", modality: "IMAGE", taskType: "DETECT_OBJECTS", isActive: true },
    select: { id: true },
  });
  const inactive = await db.aiModel.create({
    data: { key: `ai-models-inactive-${suffix}`, displayName: "Inactive Fixture Model", provider: "aioz-company", modality: "IMAGE", taskType: "DETECT_OBJECTS", isActive: false },
    select: { id: true },
  });
  cleanupModelIds.push(active.id, inactive.id);

  const owner = await signupAndLogin();
  const response = await request("/api/ai/models", { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { models: Array<Record<string, unknown>> } };

  const ids = body.data.models.map((model) => model.id);
  assert.ok(ids.includes(active.id), "active model must be listed");
  assert.ok(!ids.includes(inactive.id), "inactive model must not be listed");

  const returnedActive = body.data.models.find((model) => model.id === active.id)!;
  assert.equal(returnedActive.key, `ai-models-active-${suffix}`);
  assert.equal(returnedActive.displayName, "Active Fixture Model");
  assert.equal(returnedActive.modality, "IMAGE");
  assert.equal(returnedActive.taskType, "DETECT_OBJECTS");
  assert.equal("provider" in returnedActive, false, "provider is an internal resolution detail and must never be returned");
});

test("GET /api/ai/models surfaces a null modality for a multi-modality model", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
  const model = await db.aiModel.create({
    data: { key: `ai-models-multimodal-${suffix}`, displayName: "Multimodal Fixture Model", provider: "aioz-company", modality: null, taskType: "DETECT_OBJECTS", isActive: true },
    select: { id: true },
  });
  cleanupModelIds.push(model.id);

  const owner = await signupAndLogin();
  const response = await request("/api/ai/models", { headers: { Cookie: owner.cookie } });
  assert.equal(response.status, 200);
  const body = await response.json() as { data: { models: Array<Record<string, unknown>> } };
  const returned = body.data.models.find((row) => row.id === model.id)!;
  assert.equal(returned.modality, null);
});

test("GET /api/ai/models requires authentication", { skip: aiHttpEnabled ? false : aiHttpSkipReason }, async () => {
  const response = await request("/api/ai/models");
  assert.equal(response.status, 401);
});
