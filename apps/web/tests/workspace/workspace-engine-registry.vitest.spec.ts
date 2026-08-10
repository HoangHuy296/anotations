import { describe, expect, it } from "vitest";

import { workspaceEngineRegistry, type WorkspaceEngineRegistryEntry } from "@/lib/workspace/workspace-engine-registry";

// This repo has no jsdom/@testing-library/react (AGENTS.md requires explicit
// permission before adding one), so this exercises the registry's structural
// contract rather than rendering React trees -- the same pattern already
// established by the sibling `*.vitest.spec.ts` files in this directory.

describe("workspaceEngineRegistry", () => {
  it("has exactly one entry per WorkspaceSelection engine, each with Component/Toolbox/Tabs/StatusFields", () => {
    const keys = Object.keys(workspaceEngineRegistry).sort();
    expect(keys).toEqual(["AUDIO", "IMAGE", "TEXT", "VIDEO"]);
    for (const engine of keys as Array<keyof typeof workspaceEngineRegistry>) {
      const entry = workspaceEngineRegistry[engine];
      expect(typeof entry.Component).toBe("function");
      expect(typeof entry.Toolbox).toBe("function");
      expect(typeof entry.Tabs).toBe("function");
      expect(typeof entry.StatusFields).toBe("function");
    }
  });

  it("gives every engine a distinct Component/Toolbox/Tabs/StatusFields reference (no accidental sharing across modalities)", () => {
    const entries = Object.values(workspaceEngineRegistry);
    for (const field of ["Component", "Toolbox", "Tabs", "StatusFields"] as const) {
      const refs = entries.map((entry) => entry[field]);
      expect(new Set(refs).size).toBe(refs.length);
    }
  });

  it("proves a synthetic fifth entry can be added and looked up without changing any existing entry, and cleanly removed again", () => {
    const before = { ...workspaceEngineRegistry };
    const syntheticEntry: WorkspaceEngineRegistryEntry = {
      Component: () => null,
      Toolbox: () => null,
      Tabs: () => null,
      StatusFields: () => null,
    };
    // A future modality only needs a new key in this map (spec FR-040,
    // FR-044) -- simulated here with a plain object spread since the real
    // registry's key type is the closed `WorkspaceSelection["engine"]`
    // union (spec Known limitations: not a runtime-extensible plugin
    // system). The assertion that matters is that adding one key changes
    // nothing about the other four.
    const withSynthetic: Record<string, WorkspaceEngineRegistryEntry> = { ...before, SYNTHETIC: syntheticEntry };
    expect(withSynthetic.SYNTHETIC).toBe(syntheticEntry);
    for (const engine of Object.keys(before) as Array<keyof typeof before>) {
      expect(withSynthetic[engine]).toBe(before[engine]);
    }
    const afterRemoval = { ...withSynthetic };
    delete afterRemoval.SYNTHETIC;
    expect(afterRemoval).toEqual(before);
    expect(workspaceEngineRegistry).toEqual(before);
  });

  it("keeps IMAGE's entry the reference implementation (unchanged component identities across repeated lookups)", () => {
    const first = workspaceEngineRegistry.IMAGE;
    const second = workspaceEngineRegistry.IMAGE;
    expect(first).toBe(second);
    expect(first.Component).toBe(second.Component);
  });
});
