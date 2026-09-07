"use client";

import { useEffect } from "react";

type WorkflowShortcutOptions = {
  canSubmit: boolean;
  canApprove: boolean;
  onSubmit: () => void;
  onApprove: () => void;
};

export type WorkflowShortcutInput = {
  key: string;
  canSubmit: boolean;
  canApprove: boolean;
  editableTarget?: boolean;
  annotationInteractionActive?: boolean;
  modified?: boolean;
};

/** Returns only actions which do not need extra user input (Reject has none). */
export function workflowShortcutAction(input: WorkflowShortcutInput): "SUBMIT" | "APPROVE" | null {
  if (input.editableTarget || input.annotationInteractionActive || input.modified) return null;
  if (input.key.toLowerCase() === "s" && input.canSubmit) return "SUBMIT";
  if (input.key.toLowerCase() === "a" && input.canApprove) return "APPROVE";
  return null;
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/** Minimal workflow-only shortcuts. It intentionally has no registry or global shortcut state. */
export function useWorkflowShortcuts({ canSubmit, canApprove, onSubmit, onApprove }: WorkflowShortcutOptions) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const action = workflowShortcutAction({
        key: event.key,
        canSubmit,
        canApprove,
        editableTarget: isEditableTarget(event.target),
        annotationInteractionActive: document.documentElement.dataset.annotationInteraction === "active",
        modified: event.metaKey || event.ctrlKey || event.altKey,
      });
      if (!action) return;
      event.preventDefault();
      if (action === "SUBMIT") onSubmit();
      else onApprove();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canApprove, canSubmit, onApprove, onSubmit]);
}
