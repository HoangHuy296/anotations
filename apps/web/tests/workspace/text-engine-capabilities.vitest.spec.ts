import { describe, expect, it } from "vitest";

import { deriveTextEngineCapabilities, UNAVAILABLE_TEXT_ENGINE_CAPABILITIES } from "@/lib/workspace/text-engine-capabilities";

const FULLY_ELIGIBLE = {
  readiness: "READY" as const,
  workflowFrozen: false,
  canCreateAnnotation: true,
  hasEligibleEntityLabels: true,
  hasEligibleClassificationGroups: true,
  hasEligibleRelationTypes: true,
};

describe("deriveTextEngineCapabilities", () => {
  it("allows unlabeled spans before an entity taxonomy exists", () => {
    expect(deriveTextEngineCapabilities({ ...FULLY_ELIGIBLE, hasEligibleEntityLabels: false }).span).toBe(true);
  });

  it("read/select are always true regardless of readiness/policy/permissions", () => {
    const capabilities = deriveTextEngineCapabilities({ ...FULLY_ELIGIBLE, readiness: "UNAVAILABLE", canCreateAnnotation: false });
    expect(capabilities.read).toBe(true);
    expect(capabilities.select).toBe(true);
  });

  it("grants span/classification/relation only when every gate passes", () => {
    const capabilities = deriveTextEngineCapabilities(FULLY_ELIGIBLE);
    expect(capabilities.span).toBe(true);
    expect(capabilities.classification).toBe(true);
    expect(capabilities.relation).toBe(true);
    expect(capabilities.reasons).toEqual({ span: null, classification: null, relation: null });
  });

  it("blocks every write capability when the source is not READY, with a stated reason", () => {
    const capabilities = deriveTextEngineCapabilities({ ...FULLY_ELIGIBLE, readiness: "UNPREPARED" });
    expect(capabilities.span).toBe(false);
    expect(capabilities.classification).toBe(false);
    expect(capabilities.relation).toBe(false);
    expect(capabilities.reasons.span).toMatch(/prepared/i);
  });

  it("blocks writes when the workflow is frozen (NEEDS_REVIEW/REVIEWED/REJECTED)", () => {
    const capabilities = deriveTextEngineCapabilities({ ...FULLY_ELIGIBLE, workflowFrozen: true });
    expect(capabilities.span).toBe(false);
    expect(capabilities.reasons.span).toMatch(/review state/i);
  });

  it("blocks writes when the actor lacks annotation.create", () => {
    const capabilities = deriveTextEngineCapabilities({ ...FULLY_ELIGIBLE, canCreateAnnotation: false });
    expect(capabilities.span).toBe(false);
    expect(capabilities.reasons.span).toMatch(/permission/i);
  });

  it("gates each capability independently on its own eligible-taxonomy flag", () => {
    const onlyEntity = deriveTextEngineCapabilities({ ...FULLY_ELIGIBLE, hasEligibleClassificationGroups: false, hasEligibleRelationTypes: false });
    expect(onlyEntity.span).toBe(true);
    expect(onlyEntity.classification).toBe(false);
    expect(onlyEntity.relation).toBe(false);
    expect(onlyEntity.reasons.classification).toMatch(/classification/i);
    expect(onlyEntity.reasons.relation).toMatch(/relation/i);
  });

  it("the shared UNAVAILABLE default never reports an unearned capability", () => {
    expect(UNAVAILABLE_TEXT_ENGINE_CAPABILITIES.span).toBe(false);
    expect(UNAVAILABLE_TEXT_ENGINE_CAPABILITIES.classification).toBe(false);
    expect(UNAVAILABLE_TEXT_ENGINE_CAPABILITIES.relation).toBe(false);
    expect(UNAVAILABLE_TEXT_ENGINE_CAPABILITIES.read).toBe(true);
    expect(UNAVAILABLE_TEXT_ENGINE_CAPABILITIES.select).toBe(true);
  });
});
