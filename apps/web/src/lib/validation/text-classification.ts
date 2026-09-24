import { z } from "zod";

/**
 * `replaceClassification`: the one atomic document-classification command,
 * used for both SINGLE and MULTI groups (data-model.md D4: "Single-label
 * classification replacement requires the current group's complete
 * membership {id,revision} set"). A client computes the desired full
 * membership (`memberLabelIds`) and submits the group's *current* full
 * membership (`expectedMembers`, each `{id,revision}`) alongside it; the
 * server atomically retains/removes/creates to reach exactly that set, or
 * rejects with `REVISION_STALE` if `expectedMembers` no longer matches
 * reality (a concurrent change already moved the group). There is no
 * separate incremental `updateClassification` command: for MULTI, "add
 * label X" and "remove annotation Y" are both just `memberLabelIds`
 * expressed as "current members, plus/minus one" -- the same atomic
 * operation, not a second one worth a second code path.
 */
export const replaceClassificationSchema = z.object({
  operationId: z.string().min(1).max(128),
  sourceIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  expectedPolicyRevision: z.number().int().positive().safe(),
  command: z.object({
    kind: z.literal("replaceClassification"),
    groupId: z.string().min(1).max(64),
    memberLabelIds: z.array(z.string().min(1).max(128)).max(64),
    expectedMembers: z.array(z.object({ id: z.string().min(1), revision: z.number().int().positive().safe() }).strict()).max(64),
  }).strict(),
}).strict();
export type ReplaceClassificationInput = z.infer<typeof replaceClassificationSchema>;
