import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import { describe, expect, it } from "vitest";

import { describeTextCommandFailure, isTextCommandConflict } from "@/lib/annotations/text-command-error";

describe("text command failure messages", () => {
  it("a cross-origin rejection explains itself instead of showing the bare code FORBIDDEN, and is not a reload-conflict", () => {
    const message = describeTextCommandFailure({ code: "FORBIDDEN", reason: "CROSS_ORIGIN" });
    expect(message).toMatch(/address of this page/i);
    expect(message).not.toBe("FORBIDDEN");
    expect(isTextCommandConflict("CROSS_ORIGIN")).toBe(false);
  });

  it("a genuine permission failure keeps its own message", () => {
    expect(describeTextCommandFailure({ reason: "FORBIDDEN" })).toBe("You do not have permission for this action.");
  });
});
