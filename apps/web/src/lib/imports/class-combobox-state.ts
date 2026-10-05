import { normalizeLabelName } from "@/lib/validation/label";
import type { ConfirmedClassDraft } from "@/lib/imports/confirmed-classes";

export type ClassOption = { kind: "recommended" | "custom"; name: string };
export type ComboboxState = { query: string; open: boolean; activeIndex: number };
export type ComboboxEvent =
  | { type: "change"; query: string }
  | { type: "ArrowDown" | "ArrowUp" | "Enter" | "Escape" | "blur" };
export type ComboboxAction = { type: "add"; name: string } | null;

export const initialComboboxState: ComboboxState = { query: "", open: false, activeIndex: -1 };

/** Options are matching maintained recommendations (none today) plus, for non-empty text, one "add" option. */
export function buildClassOptions(query: string, recommended: readonly string[], classes: ConfirmedClassDraft): ClassOption[] {
  const key = normalizeLabelName(query);
  const taken = new Set(classes.map(normalizeLabelName));
  const options: ClassOption[] = recommended
    .filter((name) => !taken.has(normalizeLabelName(name)) && normalizeLabelName(name).includes(key))
    .map((name) => ({ kind: "recommended" as const, name }));
  const trimmed = query.trim();
  if (trimmed && !taken.has(key) && !options.some((option) => normalizeLabelName(option.name) === key)) options.push({ kind: "custom", name: trimmed });
  return options;
}

export function nextComboboxState(state: ComboboxState, event: ComboboxEvent, options: readonly ClassOption[]): { state: ComboboxState; action: ComboboxAction } {
  const count = options.length;
  switch (event.type) {
    case "change":
      return { state: { query: event.query, open: event.query.trim().length > 0, activeIndex: -1 }, action: null };
    case "ArrowDown":
      if (!count) return { state: { ...state, open: true, activeIndex: -1 }, action: null };
      return { state: { ...state, open: true, activeIndex: state.open ? (state.activeIndex + 1) % count : 0 }, action: null };
    case "ArrowUp":
      if (!count) return { state: { ...state, open: true, activeIndex: -1 }, action: null };
      return { state: { ...state, open: true, activeIndex: state.open ? (state.activeIndex <= 0 ? count - 1 : state.activeIndex - 1) : count - 1 }, action: null };
    case "Enter": {
      const active = state.open && state.activeIndex >= 0 ? options[state.activeIndex] : undefined;
      const name = active ? active.name : state.query.trim() ? state.query : null;
      // The caller validates through the existing Label rule; state is reset only when it accepts the name.
      return { state, action: name === null ? null : { type: "add", name } };
    }
    case "Escape":
      // Closes without committing; the typed text is kept.
      return { state: { ...state, open: false, activeIndex: -1 }, action: null };
    case "blur":
      return { state: { ...state, open: false, activeIndex: -1 }, action: null };
  }
}

/** Popup is expanded only while it has options to show. */
export function isExpanded(state: ComboboxState, options: readonly ClassOption[]) {
  return state.open && options.length > 0;
}
export function optionId(idPrefix: string, index: number) { return `${idPrefix}-option-${index}`; }
export function activeDescendant(idPrefix: string, state: ComboboxState, options: readonly ClassOption[]) {
  return isExpanded(state, options) && state.activeIndex >= 0 && state.activeIndex < options.length ? optionId(idPrefix, state.activeIndex) : undefined;
}
