"use client";

import type { TextRelationType, TextClassificationGroup } from "@/lib/annotations/text-policy-service";

/**
 * Browser client for `GET /api/datasets/{datasetId}/text-policy`. Carries
 * exactly what the toolbox/properties panel need to build span/relation
 * creation controls: the current `revision` (sent back as a command's
 * `expectedPolicyRevision`) and the *resolved* eligible ids/types --
 * `resolveTextPolicy`'s output, already filtered to labels that actually
 * exist and match scope, never the raw unresolved policy JSON.
 */
export type TextEligiblePolicy = {
  revision: number;
  entityLabelIds: string[];
  classificationGroups: TextClassificationGroup[];
  relationTypes: TextRelationType[];
};

export async function fetchTextEligiblePolicy(datasetId: string): Promise<TextEligiblePolicy | null> {
  const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/text-policy`, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null) as { data?: { revision: number; eligible: { entityLabelIds: string[]; classificationGroups: TextClassificationGroup[]; relationTypes: TextRelationType[] } } } | null;
  if (!payload?.data) return null;
  return { revision: payload.data.revision, entityLabelIds: payload.data.eligible.entityLabelIds, classificationGroups: payload.data.eligible.classificationGroups, relationTypes: payload.data.eligible.relationTypes };
}

/** Explicit Labels-panel action: enable a relation label for the current entity taxonomy. */
export async function enableTextRelationLabel(datasetId: string, relationLabelId: string): Promise<TextEligiblePolicy | null> {
  const url = `/api/datasets/${encodeURIComponent(datasetId)}/text-policy`;
  const response = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return null;
  const { data } = await response.json() as { data: { revision: number; policy: import("@/lib/annotations/text-policy-service").TextPolicy; eligible: TextEligiblePolicy } };
  if (!data.policy.relationTypes.some((type) => type.relationLabelId === relationLabelId)) {
    const result = await fetch(url, {
      method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: data.revision, policy: { ...data.policy, relationTypes: [...data.policy.relationTypes, { relationLabelId, allowedSourceLabelIds: data.eligible.entityLabelIds, allowedTargetLabelIds: data.eligible.entityLabelIds, allowUnlabeledSource: true, allowUnlabeledTarget: true }] } }),
    });
    if (!result.ok) return null;
  }
  return fetchTextEligiblePolicy(datasetId);
}
