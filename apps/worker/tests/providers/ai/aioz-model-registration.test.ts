import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PrismaClient } from "../../../../../lib/generated/prisma/client.js";
import { registerAiozModel } from "../../../src/providers/ai/aioz-model-registration.js";

const modelFixture = { key: randomUUID(), displayName: "Test model", provider: "aioz-company", modality: "IMAGE", taskType: "DETECTION" } as const;

test("unsupported capabilities reject before database access", async () => {
  const db = {} as PrismaClient;
  for (const change of [{ modality: "VIDEO" }, { modality: null }, { taskType: "CLASSIFY" }, { provider: "unknown" }, { key: "not-uuid" }, { metadata: { secret: "not-allowed" } }]) {
    await assert.rejects(registerAiozModel(db, { ...modelFixture, ...change }), /AIOZ_MODEL_CAPABILITY_UNSUPPORTED/);
  }
});

test("registration is concurrent-safe, repeatable and never overwrites conflicting or inactive rows", { skip: !process.env.DATABASE_URL }, async () => {
  const db = new PrismaClient();
  const definition = { ...modelFixture, key: randomUUID(), displayName: "Registration test" };
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => registerAiozModel(db, definition)));
    assert.equal(results.filter((result) => result.created).length, 1);
    assert.equal(new Set(results.map((result) => result.model.id)).size, 1);
    assert.equal(await db.aiModel.count({ where: { key: definition.key } }), 1);
    const before = await db.aiModel.findUniqueOrThrow({ where: { key: definition.key } });
    assert.equal((await registerAiozModel(db, definition)).created, false);
    assert.deepEqual(await db.aiModel.findUniqueOrThrow({ where: { key: definition.key } }), before);
    await assert.rejects(registerAiozModel(db, { ...definition, displayName: "Changed" }), /REGISTRATION_CONFLICT/);
    await db.aiModel.update({ where: { key: definition.key }, data: { isActive: false, metadata: { retained: true } } });
    await assert.rejects(registerAiozModel(db, definition), /REGISTRATION_CONFLICT/);
    const retained = await db.aiModel.findUniqueOrThrow({ where: { key: definition.key } });
    assert.equal(retained.isActive, false);
    assert.deepEqual(retained.metadata, { retained: true });
    await db.aiModel.update({ where: { key: definition.key }, data: { provider: "other-provider", isActive: true } });
    await assert.rejects(registerAiozModel(db, definition), /REGISTRATION_CONFLICT/);
    assert.equal((await db.aiModel.findUniqueOrThrow({ where: { key: definition.key } })).provider, "other-provider");
  } finally {
    await db.aiModel.deleteMany({ where: { key: definition.key } });
    await db.$disconnect();
  }
});
