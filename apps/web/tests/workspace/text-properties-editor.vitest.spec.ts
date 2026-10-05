import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { describe, expect, it } from "vitest";

import { draftValueToStored, toDraftRows, type DraftRow } from "@/components/workspace/text-custom-properties-editor";

/**
 * T084: `TextCustomPropertiesEditor`'s pure conversion logic. This repo has
 * no `@testing-library/react` (or any component-rendering test infra)
 * installed -- AGENTS.md requires explicit permission before adding a new
 * npm dependency, so full render/keyboard-event interaction tests are not
 * attempted here. `toDraftRows`/`draftValueToStored` are the two functions
 * that turn a stored `TextCustomMap` into editable rows and back --
 * everything a keyboard-driven edit (type a value, submit) ultimately
 * reduces to.
 */

describe("toDraftRows", () => {
  it("infers a draft row's type from each stored value's JS type, including explicit null", () => {
    const rows = toDraftRows({ confidence: 0.75, note: "reviewed", verified: true, empty: null });
    expect(rows).toEqual<DraftRow[]>([
      { key: "confidence", type: "number", value: "0.75" },
      { key: "note", type: "string", value: "reviewed" },
      { key: "verified", type: "boolean", value: "true" },
      { key: "empty", type: "null", value: "" },
    ]);
  });

  it("returns no rows for an empty custom map", () => {
    expect(toDraftRows({})).toEqual([]);
  });
});

describe("draftValueToStored", () => {
  it("converts a string-typed row through unchanged", () => {
    expect(draftValueToStored({ key: "note", type: "string", value: "hello" })).toBe("hello");
  });

  it("parses a number-typed row's value, falling back to 0 for a non-finite entry", () => {
    expect(draftValueToStored({ key: "confidence", type: "number", value: "0.5" })).toBe(0.5);
    expect(draftValueToStored({ key: "confidence", type: "number", value: "not-a-number" })).toBe(0);
  });

  it("maps a boolean-typed row's value string to an actual boolean", () => {
    expect(draftValueToStored({ key: "verified", type: "boolean", value: "true" })).toBe(true);
    expect(draftValueToStored({ key: "verified", type: "boolean", value: "false" })).toBe(false);
  });

  it("always returns null for a null-typed row regardless of its (unused) value field", () => {
    expect(draftValueToStored({ key: "empty", type: "null", value: "anything" })).toBe(null);
  });

  it("round-trips every fixture from toDraftRows back to its original stored value", () => {
    const custom = { confidence: 0.75, note: "reviewed", verified: true, empty: null };
    const roundTripped = Object.fromEntries(toDraftRows(custom).map((row) => [row.key, draftValueToStored(row)]));
    expect(roundTripped).toEqual(custom);
  });
});
