import { AssetWorkflowAction } from "@internal/db";
import { z } from "zod";

const expectedRevision = z.number().int().positive();

const baseAction = z.object({
  action: z.nativeEnum(AssetWorkflowAction),
  expectedRevision,
});

/** The API never accepts a target status or an event payload from a client. */
export const assetWorkflowActionRequestSchema = z.discriminatedUnion("action", [
  baseAction.extend({ action: z.literal(AssetWorkflowAction.START) }).strict(),
  baseAction.extend({ action: z.literal(AssetWorkflowAction.SUBMIT) }).strict(),
  baseAction.extend({ action: z.literal(AssetWorkflowAction.OPEN_REVIEW) }).strict(),
  baseAction.extend({ action: z.literal(AssetWorkflowAction.APPROVE) }).strict(),
  baseAction.extend({ action: z.literal(AssetWorkflowAction.START_REWORK) }).strict(),
  baseAction.extend({ action: z.literal(AssetWorkflowAction.RESUBMIT) }).strict(),
  baseAction.extend({
    action: z.literal(AssetWorkflowAction.REJECT),
    feedback: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

export type AssetWorkflowActionRequest = z.infer<typeof assetWorkflowActionRequestSchema>;
