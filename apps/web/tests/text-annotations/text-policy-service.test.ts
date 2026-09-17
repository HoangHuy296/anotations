import assert from "node:assert/strict";
import test from "node:test";
import { LabelScope, Modality } from "@internal/db";
import {
  parseTextPolicy,
  resolveTextPolicy,
  isTextEligibleLabel,
  findTextClassificationGroupForLabel,
  findTextRelationType,
  isCompatibleTextRelationEndpoints,
  EMPTY_TEXT_POLICY,
  TEXT_POLICY_SCHEMA_VERSION,
} from "../../src/lib/annotations/text-policy-service.js";

test("parseTextPolicy: absent, empty and corrupt stored JSON all fall back to the implicit empty policy", () => {
  assert.deepEqual(parseTextPolicy(null), EMPTY_TEXT_POLICY);
  assert.deepEqual(parseTextPolicy(undefined), EMPTY_TEXT_POLICY);
  assert.deepEqual(parseTextPolicy({}), EMPTY_TEXT_POLICY);
  assert.deepEqual(parseTextPolicy({ garbage: true }), EMPTY_TEXT_POLICY);
  assert.deepEqual(parseTextPolicy({ schemaVersion: 99 }), EMPTY_TEXT_POLICY);
});

test("parseTextPolicy: valid policy round-trips exactly", () => {
  const raw = { schemaVersion: TEXT_POLICY_SCHEMA_VERSION, classificationGroups: [{ id: "g1", name: "Topic", cardinality: "MULTI", memberLabelIds: ["l1", "l2"] }], relationTypes: [] };
  assert.deepEqual(parseTextPolicy(raw), raw);
});

test("isTextEligibleLabel: modality null or TEXT with a matching scope is eligible; other modality or scope is not", () => {
  assert.equal(isTextEligibleLabel({ id: "a", modality: null, scope: LabelScope.ENTITY }, [LabelScope.ENTITY]), true);
  assert.equal(isTextEligibleLabel({ id: "a", modality: Modality.TEXT, scope: LabelScope.ENTITY }, [LabelScope.ENTITY]), true);
  assert.equal(isTextEligibleLabel({ id: "a", modality: Modality.IMAGE, scope: LabelScope.ENTITY }, [LabelScope.ENTITY]), false);
  assert.equal(isTextEligibleLabel({ id: "a", modality: null, scope: LabelScope.OBJECT }, [LabelScope.ENTITY]), false);
});

test("resolveTextPolicy: with no explicit groups, every eligible document-scope label shares one implicit SINGLE group", () => {
  const labels = [
    { id: "cls-1", modality: null, scope: LabelScope.CLASSIFICATION },
    { id: "sentiment-1", modality: Modality.TEXT, scope: LabelScope.SENTIMENT },
    { id: "intent-1", modality: null, scope: LabelScope.INTENT },
    { id: "entity-1", modality: null, scope: LabelScope.ENTITY },
    { id: "image-1", modality: Modality.IMAGE, scope: LabelScope.CLASSIFICATION },
  ];
  const resolved = resolveTextPolicy({ policy: EMPTY_TEXT_POLICY, labels });
  assert.deepEqual(resolved.entityLabelIds, ["entity-1"]);
  assert.equal(resolved.classificationGroups.length, 1);
  assert.equal(resolved.classificationGroups[0].cardinality, "SINGLE");
  assert.deepEqual(new Set(resolved.classificationGroups[0].memberLabelIds), new Set(["cls-1", "sentiment-1", "intent-1"]));
});

test("resolveTextPolicy: once explicit groups exist, only their declared membership applies -- no implicit fallback", () => {
  const labels = [
    { id: "cls-1", modality: null, scope: LabelScope.CLASSIFICATION },
    { id: "cls-2", modality: null, scope: LabelScope.CLASSIFICATION },
  ];
  const policy = { schemaVersion: TEXT_POLICY_SCHEMA_VERSION, classificationGroups: [{ id: "g1", name: "Topic", cardinality: "SINGLE" as const, memberLabelIds: ["cls-1"] }], relationTypes: [] };
  const resolved = resolveTextPolicy({ policy, labels });
  assert.equal(resolved.classificationGroups.length, 1);
  assert.deepEqual(resolved.classificationGroups[0].memberLabelIds, ["cls-1"]);
  assert.equal(findTextClassificationGroupForLabel(resolved, "cls-2"), null, "cls-2 is eligible but not in any configured group -- not silently added");
});

test("resolveTextPolicy: relation types with no eligible relation label are unavailable, not silently kept", () => {
  const labels = [{ id: "rel-1", modality: null, scope: LabelScope.RELATION }];
  const policy = {
    schemaVersion: TEXT_POLICY_SCHEMA_VERSION,
    classificationGroups: [],
    relationTypes: [
      { relationLabelId: "rel-1", allowedSourceLabelIds: ["e1"], allowedTargetLabelIds: ["e2"], allowUnlabeledSource: false, allowUnlabeledTarget: false },
      { relationLabelId: "rel-does-not-exist", allowedSourceLabelIds: [], allowedTargetLabelIds: [], allowUnlabeledSource: false, allowUnlabeledTarget: false },
    ],
  };
  const resolved = resolveTextPolicy({ policy, labels });
  assert.equal(resolved.relationTypes.length, 1);
  assert.equal(resolved.relationTypes[0].relationLabelId, "rel-1");
  assert.ok(findTextRelationType(resolved, "rel-1"));
  assert.equal(findTextRelationType(resolved, "rel-does-not-exist"), null);
});

test("isCompatibleTextRelationEndpoints: checks allowed label sets and explicit unlabeled-endpoint flags independently for source/target", () => {
  const relationType = { relationLabelId: "rel-1", allowedSourceLabelIds: ["e1"], allowedTargetLabelIds: ["e2"], allowUnlabeledSource: false, allowUnlabeledTarget: true };
  assert.equal(isCompatibleTextRelationEndpoints(relationType, { sourceLabelId: "e1", targetLabelId: "e2" }), true);
  assert.equal(isCompatibleTextRelationEndpoints(relationType, { sourceLabelId: "wrong", targetLabelId: "e2" }), false);
  assert.equal(isCompatibleTextRelationEndpoints(relationType, { sourceLabelId: null, targetLabelId: "e2" }), false, "source has no allowUnlabeledSource");
  assert.equal(isCompatibleTextRelationEndpoints(relationType, { sourceLabelId: "e1", targetLabelId: null }), true, "target allows unlabeled");
});
