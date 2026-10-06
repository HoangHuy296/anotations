import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test, { after } from "node:test";

import { Modality, UserRole } from "@internal/db";

import { readPersistedDatasetRef } from "@/lib/datasets/dataset-ref";
import { cleanupWorkspaceFixture, createWorkspaceDataset, createWorkspaceUser } from "../workspace/helpers";

// The creation responses of /datasets/imports and /datasets/local-folder expose this persisted reference, never request input.
const enabled = Boolean(process.env.DATABASE_URL);
const users: string[] = [];
const datasets: string[] = [];
after(async () => { if (users.length || datasets.length) await cleanupWorkspaceFixture(users, datasets); });

test("the persisted Dataset reference carries the stored modality for every fixed modality", { skip: !enabled }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  users.push(owner.id);
  for (const modality of [Modality.IMAGE, Modality.VIDEO, Modality.AUDIO, Modality.TEXT]) {
    const dataset = await createWorkspaceDataset(owner.id, modality);
    datasets.push(dataset.id);
    assert.deepEqual(await readPersistedDatasetRef(dataset.id), { id: dataset.id, modality });
  }
});

test("a missing Dataset has no reference, so the creation responses fail closed", { skip: !enabled }, async () => {
  assert.equal(await readPersistedDatasetRef("does-not-exist"), null);
});
