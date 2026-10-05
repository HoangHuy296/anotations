import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { workflowShortcutAction } from "@/components/workspace/use-workflow-shortcuts";

test("workflow shortcuts are permission- and state-capability-gated", () => {
  assert.equal(workflowShortcutAction({ key: "s", canSubmit: true, canApprove: false }), "SUBMIT");
  assert.equal(workflowShortcutAction({ key: "a", canSubmit: false, canApprove: true }), "APPROVE");
  assert.equal(workflowShortcutAction({ key: "s", canSubmit: false, canApprove: false }), null);
  assert.equal(workflowShortcutAction({ key: "a", canSubmit: false, canApprove: false }), null);
});

test("workflow shortcuts never bypass feedback or editable/active interactions", () => {
  assert.equal(workflowShortcutAction({ key: "r", canSubmit: true, canApprove: true }), null, "Reject deliberately has no shortcut because feedback is required");
  assert.equal(workflowShortcutAction({ key: "s", canSubmit: true, canApprove: false, editableTarget: true }), null);
  assert.equal(workflowShortcutAction({ key: "a", canSubmit: false, canApprove: true, annotationInteractionActive: true }), null);
  assert.equal(workflowShortcutAction({ key: "s", canSubmit: true, canApprove: false, modified: true }), null);
});
