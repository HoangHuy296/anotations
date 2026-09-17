import "server-only";

import { z } from "zod";
import { LabelScope, Modality } from "@internal/db";

/**
 * Dataset TEXT taxonomy policy: read/validate side (data-model.md "Dataset
 * taxonomy policy"). `Dataset.textPolicy` is versioned JSON; absence or
 * invalid stored data both fall back to the implicit empty policy rather
 * than a hard read-time error — no read-time seeding. Reuses the existing
 * generic `Label.scope`/`Label.modality` fields (ENTITY/CLASSIFICATION/
 * SENTIMENT/INTENT/RELATION already exist on `LabelScope`); no second
 * taxonomy subsystem.
 */

export const TEXT_POLICY_SCHEMA_VERSION = 1 as const;

const textPolicyCardinalitySchema = z.enum(["SINGLE", "MULTI"]);

const textClassificationGroupSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  cardinality: textPolicyCardinalitySchema,
  memberLabelIds: z.array(z.string().min(1)),
}).strict();

const textRelationTypeSchema = z.object({
  relationLabelId: z.string().min(1),
  allowedSourceLabelIds: z.array(z.string().min(1)),
  allowedTargetLabelIds: z.array(z.string().min(1)),
  allowUnlabeledSource: z.boolean().default(false),
  allowUnlabeledTarget: z.boolean().default(false),
}).strict();

export const textPolicySchema = z.object({
  schemaVersion: z.literal(TEXT_POLICY_SCHEMA_VERSION),
  classificationGroups: z.array(textClassificationGroupSchema).default([]),
  relationTypes: z.array(textRelationTypeSchema).default([]),
}).strict();

export type TextPolicy = z.infer<typeof textPolicySchema>;
export type TextClassificationGroup = z.infer<typeof textClassificationGroupSchema>;
export type TextRelationType = z.infer<typeof textRelationTypeSchema>;

export const EMPTY_TEXT_POLICY: TextPolicy = Object.freeze({ schemaVersion: TEXT_POLICY_SCHEMA_VERSION, classificationGroups: [], relationTypes: [] });

/** Never throws: an empty/missing/corrupt stored policy is the implicit empty policy, not a read failure. */
export function parseTextPolicy(raw: unknown): TextPolicy {
  if (raw === null || raw === undefined) return EMPTY_TEXT_POLICY;
  if (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as object).length === 0) return EMPTY_TEXT_POLICY;
  const parsed = textPolicySchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_TEXT_POLICY;
}

export const TEXT_ENTITY_LABEL_SCOPES = [LabelScope.ENTITY] as const;
export const TEXT_DOCUMENT_LABEL_SCOPES = [LabelScope.CLASSIFICATION, LabelScope.SENTIMENT, LabelScope.INTENT] as const;
export const TEXT_RELATION_LABEL_SCOPES = [LabelScope.RELATION] as const;

export interface EligibleLabelRow {
  id: string;
  modality: Modality | null;
  scope: LabelScope;
}

/** A label is TEXT-eligible when it belongs to no specific modality (shared) or is explicitly TEXT, and has an eligible scope. */
export function isTextEligibleLabel(label: EligibleLabelRow, scopes: readonly LabelScope[]): boolean {
  return (label.modality === null || label.modality === Modality.TEXT) && scopes.includes(label.scope);
}

export interface ResolvedTextPolicy {
  policy: TextPolicy;
  entityLabelIds: string[];
  classificationGroups: TextClassificationGroup[];
  relationTypes: TextRelationType[];
}

const IMPLICIT_SINGLE_GROUP_ID = "implicit-single";

/**
 * With no explicit groups, every eligible document-scope label (CLASSIFICATION
 * + SENTIMENT + INTENT) shares one implicit SINGLE-cardinality group. Once
 * any explicit group is configured, only its declared membership applies —
 * an eligible label not referenced by any configured group is not part of
 * any group (data-model.md: "no invented labels/types"). Unconfigured
 * relation types are filtered out entirely (unavailable, not a default).
 */
export function resolveTextPolicy(input: { policy: TextPolicy; labels: readonly EligibleLabelRow[] }): ResolvedTextPolicy {
  const entityLabelIds = input.labels.filter((label) => isTextEligibleLabel(label, TEXT_ENTITY_LABEL_SCOPES)).map((label) => label.id);

  let classificationGroups = input.policy.classificationGroups;
  if (classificationGroups.length === 0) {
    const documentLabelIds = input.labels.filter((label) => isTextEligibleLabel(label, TEXT_DOCUMENT_LABEL_SCOPES)).map((label) => label.id);
    if (documentLabelIds.length > 0) {
      classificationGroups = [{ id: IMPLICIT_SINGLE_GROUP_ID, name: "Classification", cardinality: "SINGLE", memberLabelIds: documentLabelIds }];
    }
  }

  const relationLabelIds = new Set(input.labels.filter((label) => isTextEligibleLabel(label, TEXT_RELATION_LABEL_SCOPES)).map((label) => label.id));
  const relationTypes = input.policy.relationTypes.filter((relationType) => relationLabelIds.has(relationType.relationLabelId));

  return { policy: input.policy, entityLabelIds, classificationGroups, relationTypes };
}

export function findTextClassificationGroupForLabel(resolved: ResolvedTextPolicy, labelId: string): TextClassificationGroup | null {
  return resolved.classificationGroups.find((group) => group.memberLabelIds.includes(labelId)) ?? null;
}

export function findTextRelationType(resolved: ResolvedTextPolicy, relationLabelId: string): TextRelationType | null {
  return resolved.relationTypes.find((relationType) => relationType.relationLabelId === relationLabelId) ?? null;
}

/** Endpoint compatibility check for a candidate relation: both endpoint labels (or explicit unlabeled) must be allowed by the configured type. */
export function isCompatibleTextRelationEndpoints(relationType: TextRelationType, input: { sourceLabelId: string | null; targetLabelId: string | null }): boolean {
  const sourceOk = input.sourceLabelId ? relationType.allowedSourceLabelIds.includes(input.sourceLabelId) : relationType.allowUnlabeledSource;
  const targetOk = input.targetLabelId ? relationType.allowedTargetLabelIds.includes(input.targetLabelId) : relationType.allowUnlabeledTarget;
  return sourceOk && targetOk;
}
