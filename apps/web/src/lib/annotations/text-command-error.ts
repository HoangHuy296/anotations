/**
 * T093: one shared mapping from a TEXT command's server `reason` code to a
 * human-readable message and a conflict/non-conflict classification, used
 * by every TEXT mutation surface (`text-engine.tsx`, `text-workspace.ts`,
 * `text-annotation-editor.tsx`, `text-custom-properties-editor.tsx`)
 * instead of each one showing a raw reason code or writing its own message.
 * "Conflict" reasons are the ones where retrying with the same input can
 * never succeed until the caller reloads current state (a revision/policy/
 * source moved since the request was built) -- everything else is an
 * ordinary validation/permission failure the user can act on directly.
 */

const CONFLICT_REASONS = new Set(["REVISION_STALE", "POLICY_STALE", "SOURCE_MISMATCH", "CONFLICT", "RECEIPT_CONFLICT"]);

export function isTextCommandConflict(reason: string | undefined): boolean {
  return Boolean(reason && CONFLICT_REASONS.has(reason));
}

const MESSAGES: Record<string, string> = {
  REVISION_STALE: "This annotation changed since you started editing.",
  POLICY_STALE: "The label/relation taxonomy changed. Reload to pick up the latest configuration.",
  SOURCE_MISMATCH: "This document's source changed unexpectedly.",
  CONFLICT: "This asset changed. Reload before trying again.",
  RECEIPT_CONFLICT: "A conflicting request with the same identity was already recorded.",
  WORKFLOW_LOCKED: "This asset's review state does not allow edits right now.",
  DATASET_LOCKED: "Another change to this dataset is in progress. Try again in a moment.",
  FORBIDDEN: "You do not have permission for this action.",
  NOT_FOUND: "That resource could not be found.",
  DUPLICATE_SPAN: "An identical span already exists.",
  DUPLICATE_RELATION: "An identical relation already exists.",
  INVALID_RANGE: "That range is not valid for this document.",
  LIMIT_EXCEEDED: "This asset has reached its annotation limit.",
  INVALID_REQUEST: "That request was not valid.",
  SOURCE_NOT_READY: "This document is not ready to annotate yet.",
};

export function describeTextCommandFailure(result: { reason?: string; code?: string }): string {
  if (result.reason && MESSAGES[result.reason]) return MESSAGES[result.reason];
  return result.reason ?? result.code ?? "That change could not be saved.";
}
