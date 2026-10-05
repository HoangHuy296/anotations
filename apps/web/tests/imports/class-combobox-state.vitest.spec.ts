import { describe, expect, it } from "vitest";

import { activeDescendant, buildClassOptions, initialComboboxState, isExpanded, nextComboboxState, optionId, type ComboboxEvent, type ComboboxState } from "@/lib/imports/class-combobox-state";

const run = (state: ComboboxState, events: ComboboxEvent[], recommended: readonly string[] = [], classes: readonly string[] = []) => {
  let current = state; let action = null as ReturnType<typeof nextComboboxState>["action"];
  for (const event of events) {
    const options = buildClassOptions(current.query, recommended, classes);
    const next = nextComboboxState(current, event, options);
    current = next.state; action = next.action;
  }
  return { state: current, action, options: buildClassOptions(current.query, recommended, classes) };
};

describe("class combobox options", () => {
  it("offers one add-option for typed text and none for empty text", () => {
    expect(buildClassOptions("", [], [])).toEqual([]);
    expect(buildClassOptions(" truck ", [], [])).toEqual([{ kind: "custom", name: "truck" }]);
  });
  it("hides already-added classes and never offers a duplicate add-option", () => {
    expect(buildClassOptions("Car", [], ["car"])).toEqual([]);
    expect(buildClassOptions("c", ["car", "cat"], ["car"])).toEqual([{ kind: "recommended", name: "cat" }, { kind: "custom", name: "c" }]);
  });
});

describe("class combobox keyboard behavior", () => {
  it("starts closed with no active descendant (no mount focus or popup)", () => {
    expect(initialComboboxState).toEqual({ query: "", open: false, activeIndex: -1 });
    expect(isExpanded(initialComboboxState, [])).toBe(false);
  });
  it("typing opens the popup with nothing active; clearing the text closes it", () => {
    const typed = run(initialComboboxState, [{ type: "change", query: "tr" }]);
    expect(typed.state).toEqual({ query: "tr", open: true, activeIndex: -1 });
    expect(isExpanded(typed.state, typed.options)).toBe(true);
    expect(activeDescendant("p", typed.state, typed.options)).toBeUndefined();
    const cleared = run(typed.state, [{ type: "change", query: "" }]);
    expect(isExpanded(cleared.state, cleared.options)).toBe(false);
  });
  it("ArrowDown/ArrowUp move and wrap, and expose the matching option id", () => {
    const rec = ["car", "cat", "cow"];
    const down = run({ query: "c", open: true, activeIndex: -1 }, [{ type: "ArrowDown" }], rec);
    expect(down.state.activeIndex).toBe(0);
    expect(activeDescendant("p", down.state, down.options)).toBe(optionId("p", 0));
    expect(run(down.state, [{ type: "ArrowDown" }, { type: "ArrowDown" }, { type: "ArrowDown" }], rec).state.activeIndex).toBe(3); // 3 recommendations + the add-option = 4 options
    expect(run(down.state, [{ type: "ArrowDown" }, { type: "ArrowDown" }, { type: "ArrowDown" }, { type: "ArrowDown" }], rec).state.activeIndex).toBe(0); // wraps
    expect(run({ query: "c", open: true, activeIndex: 0 }, [{ type: "ArrowUp" }], rec).state.activeIndex).toBe(3);
  });
  it("ArrowDown on a closed popup with options opens it on the first option", () => {
    const result = run({ query: "c", open: false, activeIndex: -1 }, [{ type: "ArrowDown" }], ["car"]);
    expect(result.state).toMatchObject({ open: true, activeIndex: 0 });
  });
  it("Enter adds the active option, else the typed text, else nothing", () => {
    expect(run({ query: "c", open: true, activeIndex: 1 }, [{ type: "Enter" }], ["car", "cat"]).action).toEqual({ type: "add", name: "cat" });
    expect(run({ query: " truck ", open: true, activeIndex: -1 }, [{ type: "Enter" }]).action).toEqual({ type: "add", name: " truck " });
    expect(run(initialComboboxState, [{ type: "Enter" }]).action).toBeNull();
  });
  it("Escape closes without committing and keeps the typed text", () => {
    const result = run({ query: "tr", open: true, activeIndex: 0 }, [{ type: "Escape" }]);
    expect(result.action).toBeNull();
    expect(result.state).toEqual({ query: "tr", open: false, activeIndex: -1 });
    expect(activeDescendant("p", result.state, result.options)).toBeUndefined();
  });
  it("blur closes the popup and drops the active descendant", () => {
    expect(run({ query: "tr", open: true, activeIndex: 0 }, [{ type: "blur" }]).state).toEqual({ query: "tr", open: false, activeIndex: -1 });
  });
  it("the active descendant disappears when the options disappear", () => {
    const state = { query: "car", open: true, activeIndex: 0 };
    expect(activeDescendant("p", state, buildClassOptions("car", [], ["car"]))).toBeUndefined();
  });
});
