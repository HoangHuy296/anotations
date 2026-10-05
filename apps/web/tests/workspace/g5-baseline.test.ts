import "../../../../scripts/db-safety/test-entry.cjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { g5History } from "./g5-fixtures";

test("G5 unresolved history exists only as synthetic rows before candidate migration 24", async () => {
  const receipt = JSON.parse(readFileSync(process.env.DB_SAFETY_RECEIPT!, "utf8"));
  const { PrismaClient } = await import(pathToFileURL(join(dirname(receipt.config), "baseline-client/client.ts")).href);
  const baseline = new PrismaClient();
  try {
    await baseline.$transaction(async (tx: typeof baseline) => {
      await tx.user.createMany({ data: [
        { id: g5History.owner, email: "g5-history-owner@fixture.test", role: "MANAGER" },
        { id: g5History.manager, email: "g5-history-manager@fixture.test", role: "MANAGER" },
      ] });
      for (const [name, id] of [["empty", g5History.empty], ["mixed", g5History.mixed], ["single", g5History.single], ["owner-resolution", g5History.ownerResolution], ["admin-resolution", g5History.adminResolution]]) {
        await tx.dataset.create({ data: { id, ownerId: g5History.owner, name: `G5 historical ${name}`, metadata: { workflowStatus: "IN_PROGRESS" } } });
      }
      for (const datasetId of [g5History.empty, g5History.mixed, g5History.single, g5History.ownerResolution, g5History.adminResolution]) {
        await tx.datasetMember.create({ data: { datasetId, userId: g5History.manager, role: "MANAGER" } });
      }
      await tx.asset.createMany({ data: [
        { id: g5History.mixedImage, datasetId: g5History.mixed, modality: "IMAGE", filename: "mixed-image.png", mimeType: "image/png", relativePath: "mixed-image.png", sourceFingerprint: "g5-historical-mixed-image" },
        { id: g5History.mixedAudio, datasetId: g5History.mixed, modality: "AUDIO", filename: "mixed-audio.wav", mimeType: "audio/wav", relativePath: "mixed-audio.wav", sourceFingerprint: "g5-historical-mixed-audio", deletedAt: new Date() },
        { id: g5History.singleImage, datasetId: g5History.single, modality: "IMAGE", filename: "single-image.png", mimeType: "image/png", relativePath: "single-image.png", sourceFingerprint: "g5-historical-single-image" },
      ] });
      assert.equal(await tx.dataset.count({ where: { ownerId: g5History.owner } }), 5);
    });
  } finally { await baseline.$disconnect(); }
});
