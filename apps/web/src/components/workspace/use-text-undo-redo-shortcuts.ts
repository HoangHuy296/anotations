"use client";

import { useEffect } from "react";

type TextUndoRedoShortcutOptions = {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
};

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

/**
 * Ctrl/Cmd+Z (undo) and Ctrl/Cmd+Shift+Z or Ctrl+Y (redo) for TEXT's
 * Undo/Redo core (T095, keyboard operability per T147/T152). Suppressed
 * while an editable control has focus -- the browser's own native undo for
 * that field must win, not TEXT's annotation history. Mirrors
 * `use-workflow-shortcuts.ts`'s `isEditableTarget` guard and minimal,
 * registry-free shape.
 */
export function useTextUndoRedoShortcuts({ canUndo, canRedo, onUndo, onRedo }: TextUndoRedoShortcutOptions) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || isEditableTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) { if (canUndo) { event.preventDefault(); onUndo(); } return; }
      if ((key === "z" && event.shiftKey) || key === "y") { if (canRedo) { event.preventDefault(); onRedo(); } }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [canUndo, canRedo, onUndo, onRedo]);
}
