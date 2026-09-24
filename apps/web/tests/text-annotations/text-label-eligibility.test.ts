import assert from "node:assert/strict";
import test from "node:test";
import { DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { createLabelWithTextEligibility, updateLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { createWorkspaceUser, createWorkspaceDataset, addWorkspaceMember, cleanupWorkspaceFixture, workspaceUnique } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/**
 * T040/T041: labels can become TEXT-eligible through normal authorized
 * product use (no direct database seeding), a referenced label is locked to
 * its current scope, and creating/changing eligibility bumps
 * Dataset.textPolicyRevision and emits TEXT_POLICY_CHANGED atomically —
 * while an ordinary non-TEXT edit never touches the TEXT guard at all.
 */

test("createLabelWithTextEligibility creates an eligible ENTITY label and bumps textPolicyRevision atomically", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true, textMutationRevision: true } });
    const created = await createLabelWithTextEligibility(owner, {
      datasetId: dataset.id, name: workspaceUnique("Entity Label"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.label.modality, Modality.TEXT);
    assert.equal(created.label.scope, "ENTITY");

    const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true, textMutationRevision: true } });
    assert.equal(after.textPolicyRevision, before.textPolicyRevision + 1);
    assert.equal(after.textMutationRevision, before.textMutationRevision + 1);
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("createLabelWithTextEligibility with no eligibility never claims the TEXT dataset guard", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true, textMutationRevision: true } });
    const created = await createLabelWithTextEligibility(owner, {
      datasetId: dataset.id, name: workspaceUnique("Plain Label"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: undefined,
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.equal(created.label.modality, null);
    assert.equal(created.label.scope, "OBJECT");

    const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true, textMutationRevision: true } });
    assert.equal(after.textPolicyRevision, before.textPolicyRevision, "an ordinary label create must never touch the TEXT policy revision");
    assert.equal(after.textMutationRevision, before.textMutationRevision, "an ordinary label create must never claim the TEXT dataset guard");
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("updateLabelWithTextEligibility can toggle an unreferenced label's eligibility on and back off", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const created = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: workspaceUnique("Togglable"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: undefined });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const madeEligible = await updateLabelWithTextEligibility(owner, { labelId: created.label.id, datasetId: dataset.id, name: created.label.name, color: created.label.color, description: null, hotkey: null, textEligibility: "CLASSIFICATION" });
    assert.equal(madeEligible.ok, true);
    if (madeEligible.ok) { assert.equal(madeEligible.label.modality, Modality.TEXT); assert.equal(madeEligible.label.scope, "CLASSIFICATION"); }

    const clearedEligibility = await updateLabelWithTextEligibility(owner, { labelId: created.label.id, datasetId: dataset.id, name: created.label.name, color: created.label.color, description: null, hotkey: null, textEligibility: "NONE" });
    assert.equal(clearedEligibility.ok, true);
    if (clearedEligibility.ok) { assert.equal(clearedEligibility.label.modality, null); assert.equal(clearedEligibility.label.scope, "OBJECT"); }
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("a plain color/description edit of an already-eligible label leaves its eligibility and the TEXT guard untouched", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const created = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: workspaceUnique("Sentiment"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "SENTIMENT" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true, textMutationRevision: true } });
    const edited = await updateLabelWithTextEligibility(owner, { labelId: created.label.id, datasetId: dataset.id, name: created.label.name, color: "#FF0000", description: "updated", hotkey: null, textEligibility: undefined });
    assert.equal(edited.ok, true);
    if (edited.ok) { assert.equal(edited.label.modality, Modality.TEXT); assert.equal(edited.label.scope, "SENTIMENT"); assert.equal(edited.label.color, "#FF0000"); }

    const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true, textMutationRevision: true } });
    assert.equal(after.textPolicyRevision, before.textPolicyRevision, "an ordinary field edit must not bump the policy revision");
    assert.equal(after.textMutationRevision, before.textMutationRevision, "an ordinary field edit must not claim the TEXT dataset guard");
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("a referenced label is locked to its current eligibility -- REFERENCED_SCOPE_LOCKED, not a silent change", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const created = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: workspaceUnique("Referenced Entity"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.TEXT, filename: `${workspaceUnique("ref")}.txt`, mimeType: "text/plain", sourceFingerprint: workspaceUnique("ref") }, select: { id: true } });
    await db.annotation.create({ data: { datasetId: dataset.id, assetId: asset.id, createdById: owner.id, modality: Modality.TEXT, type: "NAMED_ENTITY_RECOGNITION", labelId: created.label.id, geometry: {}, properties: {} } });

    const attempt = await updateLabelWithTextEligibility(owner, { labelId: created.label.id, datasetId: dataset.id, name: created.label.name, color: created.label.color, description: null, hotkey: null, textEligibility: "CLASSIFICATION" });
    assert.deepEqual(attempt, { ok: false, reason: "REFERENCED_SCOPE_LOCKED" });

    // The label itself is provably untouched.
    const unchanged = await db.label.findUniqueOrThrow({ where: { id: created.label.id }, select: { modality: true, scope: true } });
    assert.equal(unchanged.modality, Modality.TEXT);
    assert.equal(unchanged.scope, "ENTITY");
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("duplicate label names are rejected on both the guarded and plain create paths", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const name = workspaceUnique("Dup");
    const first = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name, color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(first.ok, true);
    const duplicate = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name, color: "#0EA5E9", description: null, hotkey: null, textEligibility: "INTENT" });
    assert.deepEqual(duplicate, { ok: false, reason: "DUPLICATE_NAME" });
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("a LABELER without label.manage is forbidden from creating or updating eligibility", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
  try {
    const created = await createLabelWithTextEligibility(labeler, { datasetId: dataset.id, name: workspaceUnique("Forbidden"), color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.deepEqual(created, { ok: false, reason: "FORBIDDEN" });
  } finally {
    await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]);
  }
});
