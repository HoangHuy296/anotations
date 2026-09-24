import type { TextSourceReadiness } from "@/lib/annotations/text-source-readiness";

/**
 * TEXT engine capability gating (T045). Read/select are always available
 * once a TEXT asset resolves into the workspace at all — an unready source
 * is shown as an in-engine state, never a capability gate (research.md D6).
 * Writes gate on source readiness, permissions, and workflow state;
 * classification/relation additionally require taxonomy, with a reason when unavailable
 * rather than a bare disabled control.
 */
export type TextEngineCapabilities = {
  read: boolean;
  select: boolean;
  span: boolean;
  classification: boolean;
  relation: boolean;
  reasons: { span: string | null; classification: string | null; relation: string | null };
};

export interface DeriveTextEngineCapabilitiesInput {
  readiness: TextSourceReadiness;
  /** NEEDS_REVIEW/REVIEWED/REJECTED reject content writes (data-model.md "Workflow and client state"). */
  workflowFrozen: boolean;
  canCreateAnnotation: boolean;
  hasEligibleEntityLabels: boolean;
  hasEligibleClassificationGroups: boolean;
  hasEligibleRelationTypes: boolean;
}

function gate(conditions: Array<{ ok: boolean; reason: string }>): { ok: boolean; reason: string | null } {
  const failed = conditions.find((condition) => !condition.ok);
  return failed ? { ok: false, reason: failed.reason } : { ok: true, reason: null };
}

export function deriveTextEngineCapabilities(input: DeriveTextEngineCapabilitiesInput): TextEngineCapabilities {
  const sourceReady = input.readiness === "READY";
  const commonGates = [
    { ok: sourceReady, reason: "The source must be prepared and ready before it can be annotated." },
    { ok: !input.workflowFrozen, reason: "This asset's review state does not allow edits." },
    { ok: input.canCreateAnnotation, reason: "You do not have permission to annotate this asset." },
  ];

  // An entity may be created without a label and classified later.
  const span = gate(commonGates);
  const classification = gate([...commonGates, { ok: input.hasEligibleClassificationGroups, reason: "No classification taxonomy is configured for this dataset." }]);
  const relation = gate([...commonGates, { ok: input.hasEligibleRelationTypes, reason: "No relation type is configured for this dataset." }]);

  return {
    read: true,
    select: true,
    span: span.ok,
    classification: classification.ok,
    relation: relation.ok,
    reasons: { span: span.reason, classification: classification.reason, relation: relation.reason },
  };
}

/** Conservative default used until the workspace selection DTO carries real readiness/policy/permission context (T048). Never reports an unearned capability. */
export const UNAVAILABLE_TEXT_ENGINE_CAPABILITIES: TextEngineCapabilities = deriveTextEngineCapabilities({
  readiness: "UNPREPARED",
  workflowFrozen: false,
  canCreateAnnotation: false,
  hasEligibleEntityLabels: false,
  hasEligibleClassificationGroups: false,
  hasEligibleRelationTypes: false,
});
