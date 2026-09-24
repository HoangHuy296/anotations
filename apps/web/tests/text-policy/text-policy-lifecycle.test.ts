import assert from "node:assert/strict";
import test from "node:test";
import { DatasetMemberRole, Modality, UserRole } from "@internal/db";

import { db } from "../../src/lib/db.js";
import { policyWriteSchema, readTextPolicy, writeTextPolicy } from "../../src/lib/annotations/text-policy-write-service.js";
import { parseTextPolicy, resolveTextPolicy } from "../../src/lib/annotations/text-policy-service.js";
import { createLabelWithTextEligibility } from "../../src/lib/workspace/label-management.js";
import { createWorkspaceUser, createWorkspaceDataset, addWorkspaceMember, cleanupWorkspaceFixture } from "../workspace/helpers.js";

const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

/**
 * T044: proves the generic policy revision guard and policy-only stale-
 * write/rollback behavior. The route (T043) is a thin wrapper -- it parses
 * the request, authorizes (dataset.read for GET, label.manage for PUT via
 * the already-extensively-tested requireDatasetPermission), and calls
 * exactly these two functions. Testing here, at the service boundary,
 * covers the actual guard/revision/reference logic the route depends on.
 */

test("policyWriteSchema: only the canonical {expectedRevision, policy} shape is accepted -- an expectedPolicyRevision alias is rejected, not silently ignored", () => {
  const validPolicy = { schemaVersion: 1, classificationGroups: [], relationTypes: [] };
  assert.equal(policyWriteSchema.safeParse({ expectedRevision: 1, policy: validPolicy }).success, true);
  assert.equal(policyWriteSchema.safeParse({ expectedPolicyRevision: 1, policy: validPolicy }).success, false, "expectedPolicyRevision is not the canonical field name and must be rejected by .strict()");
  assert.equal(policyWriteSchema.safeParse({ expectedRevision: 1, expectedPolicyRevision: 1, policy: validPolicy }).success, false, "an extra alias field alongside the canonical one is still rejected");
});

test("readTextPolicy: an unconfigured dataset reads back the implicit empty policy at revision 1", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const { dataset: row, labels } = await readTextPolicy(dataset.id);
    assert.ok(row);
    const policy = parseTextPolicy(row!.textPolicy);
    assert.deepEqual(policy, { schemaVersion: 1, classificationGroups: [], relationTypes: [] });
    assert.equal(row!.textPolicyRevision, 1);
    assert.deepEqual(labels, []);
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("writeTextPolicy: a correct expectedRevision commits atomically and bumps the revision exactly once", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const entity = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: "Person", color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(entity.ok, true);
    if (!entity.ok) return;

    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true } });
    const relationLabel = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: "WorksAt", color: "#0EA5E9", description: null, hotkey: null, textEligibility: "RELATION" });
    assert.equal(relationLabel.ok, true);
    if (!relationLabel.ok) return;
    const afterLabelCreates = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true } });

    const policy = {
      schemaVersion: 1 as const,
      classificationGroups: [],
      relationTypes: [{ relationLabelId: relationLabel.label.id, allowedSourceLabelIds: [entity.label.id], allowedTargetLabelIds: [entity.label.id], allowUnlabeledSource: false, allowUnlabeledTarget: false }],
    };
    const result = await writeTextPolicy(owner, dataset.id, { expectedRevision: afterLabelCreates.textPolicyRevision, policy });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.revision, afterLabelCreates.textPolicyRevision + 1);
    assert.deepEqual(result.policy, policy);

    const stored = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicy: true, textPolicyRevision: true } });
    assert.deepEqual(stored.textPolicy, policy);
    assert.equal(stored.textPolicyRevision, result.revision);
    assert.ok(stored.textPolicyRevision > before.textPolicyRevision);

    const outboxEvent = await db.collaborationOutboxEvent.findFirst({ where: { datasetId: dataset.id, type: "TEXT_POLICY_CHANGED" }, orderBy: { createdAt: "desc" }, select: { assetId: true, payload: true } });
    assert.ok(outboxEvent);
    assert.equal(outboxEvent!.assetId, null, "a policy write must never carry an assetId");
    assert.deepEqual(outboxEvent!.payload, { datasetId: dataset.id, policyRevision: result.revision });
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("writeTextPolicy: a stale expectedRevision is rejected and rolls back the Dataset guard claim without changing anything", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicy: true, textPolicyRevision: true, textMutationRevision: true } });
    const stale = await writeTextPolicy(owner, dataset.id, { expectedRevision: before.textPolicyRevision + 5, policy: { schemaVersion: 1, classificationGroups: [], relationTypes: [] } });
    assert.deepEqual(stale, { ok: false, reason: "REVISION_STALE" });

    const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicy: true, textPolicyRevision: true, textMutationRevision: true } });
    assert.deepEqual(after.textPolicy, before.textPolicy);
    assert.equal(after.textPolicyRevision, before.textPolicyRevision);
    assert.equal(after.textMutationRevision, before.textMutationRevision, "a rejected write must not leave the Dataset guard claimed");
    assert.equal(await db.collaborationOutboxEvent.count({ where: { datasetId: dataset.id, type: "TEXT_POLICY_CHANGED" } }), 0);
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("writeTextPolicy: a reference to a label outside the dataset, or with an ineligible scope, is rejected as INVALID_REQUEST", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  const otherDataset = await createWorkspaceDataset(owner.id);
  try {
    const foreignLabel = await createLabelWithTextEligibility(owner, { datasetId: otherDataset.id, name: "Foreign", color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(foreignLabel.ok, true);
    if (!foreignLabel.ok) return;
    const wrongScopeLabel = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: "WrongScope", color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(wrongScopeLabel.ok, true);
    if (!wrongScopeLabel.ok) return;

    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true } });

    const foreignRef = await writeTextPolicy(owner, dataset.id, {
      expectedRevision: before.textPolicyRevision,
      policy: { schemaVersion: 1, classificationGroups: [{ id: "g1", name: "G", cardinality: "SINGLE", memberLabelIds: [foreignLabel.label.id] }], relationTypes: [] },
    });
    assert.deepEqual(foreignRef, { ok: false, reason: "INVALID_REQUEST" });

    // ENTITY-scoped label used as a classification-group member (wrong role for its scope).
    const wrongScopeRef = await writeTextPolicy(owner, dataset.id, {
      expectedRevision: before.textPolicyRevision,
      policy: { schemaVersion: 1, classificationGroups: [{ id: "g1", name: "G", cardinality: "SINGLE", memberLabelIds: [wrongScopeLabel.label.id] }], relationTypes: [] },
    });
    assert.deepEqual(wrongScopeRef, { ok: false, reason: "INVALID_REQUEST" });

    const after = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true } });
    assert.equal(after.textPolicyRevision, before.textPolicyRevision, "a rejected write must not advance the policy revision");
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id, otherDataset.id]);
  }
});

test("writeTextPolicy: reconfiguring a group away from a label with an existing classification annotation is rejected (CONFLICT), never silently orphaning it", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const dataset = await createWorkspaceDataset(owner.id);
  try {
    const cls = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: "Topic", color: "#0EA5E9", description: null, hotkey: null, textEligibility: "CLASSIFICATION" });
    assert.equal(cls.ok, true);
    if (!cls.ok) return;
    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true } });
    const configured = await writeTextPolicy(owner, dataset.id, {
      expectedRevision: before.textPolicyRevision,
      policy: { schemaVersion: 1, classificationGroups: [{ id: "g1", name: "Topic", cardinality: "SINGLE", memberLabelIds: [cls.label.id] }], relationTypes: [] },
    });
    assert.equal(configured.ok, true);
    if (!configured.ok) return;

    const asset = await db.asset.create({ data: { datasetId: dataset.id, modality: Modality.TEXT, filename: "orphan-test.txt", mimeType: "text/plain", sourceFingerprint: `orphan-${Date.now()}` }, select: { id: true } });
    await db.annotation.create({ data: { datasetId: dataset.id, assetId: asset.id, createdById: owner.id, modality: Modality.TEXT, type: "TEXT_CLASSIFICATION", labelId: cls.label.id, geometry: {}, properties: {} } });

    // Reconfigure to a *different explicit* group that excludes the
    // referenced label -- would orphan the existing classification. (An
    // empty `classificationGroups` array is deliberately NOT equivalent:
    // per data-model.md, zero explicit groups falls back to the implicit
    // SINGLE group covering every eligible document label, so it would
    // NOT orphan anything -- that fallback is exercised by the earlier
    // "implicit SINGLE group" resolveTextPolicy test.)
    const orphaning = await writeTextPolicy(owner, dataset.id, {
      expectedRevision: configured.revision,
      policy: { schemaVersion: 1, classificationGroups: [{ id: "g2", name: "Other", cardinality: "SINGLE", memberLabelIds: [] }], relationTypes: [] },
    });
    assert.deepEqual(orphaning, { ok: false, reason: "CONFLICT" });

    const stillConfigured = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicy: true, textPolicyRevision: true } });
    assert.equal(stillConfigured.textPolicyRevision, configured.revision, "a rejected reconfiguration must not advance the policy revision");
  } finally {
    await cleanupWorkspaceFixture([owner.id], [dataset.id]);
  }
});

test("writeTextPolicy: a LABELER (no label.manage) is forbidden", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
  try {
    const before = await db.dataset.findUniqueOrThrow({ where: { id: dataset.id }, select: { textPolicyRevision: true } });
    const attempt = await writeTextPolicy(labeler, dataset.id, { expectedRevision: before.textPolicyRevision, policy: { schemaVersion: 1, classificationGroups: [], relationTypes: [] } });
    assert.deepEqual(attempt, { ok: false, reason: "FORBIDDEN" });
  } finally {
    await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]);
  }
});

test("readTextPolicy + resolveTextPolicy: dataset.read (any member, including LABELER) can read the resolved eligible taxonomy", { skip: !hasIntegrationDatabase }, async () => {
  const owner = await createWorkspaceUser(UserRole.MANAGER);
  const labeler = await createWorkspaceUser(UserRole.LABELER);
  const dataset = await createWorkspaceDataset(owner.id);
  await addWorkspaceMember(dataset.id, labeler.id, DatasetMemberRole.LABELER);
  try {
    const entity = await createLabelWithTextEligibility(owner, { datasetId: dataset.id, name: "Org", color: "#0EA5E9", description: null, hotkey: null, textEligibility: "ENTITY" });
    assert.equal(entity.ok, true);
    if (!entity.ok) return;
    const { dataset: row, labels } = await readTextPolicy(dataset.id);
    assert.ok(row);
    const resolved = resolveTextPolicy({ policy: parseTextPolicy(row!.textPolicy), labels });
    assert.deepEqual(resolved.entityLabelIds, [entity.label.id]);
  } finally {
    await cleanupWorkspaceFixture([owner.id, labeler.id], [dataset.id]);
  }
});
