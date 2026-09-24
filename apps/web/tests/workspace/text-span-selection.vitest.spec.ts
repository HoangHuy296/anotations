import { describe, expect, it } from "vitest";
import { normalizeTextSpanSelection } from "@/lib/workspace/text-span-selection";
import { createTextSpanSchema } from "@/lib/validation/text-span";

describe("text entity selection", () => {
  it("normalizes reversed ranges and expands partial emoji/combining selections using supplied boundaries", () => {
    expect(normalizeTextSpanSelection({ startOffset: 2, endOffset: 1 }, [0, 1, 3, 4])).toEqual({ startOffset: 1, endOffset: 3 });
    expect(normalizeTextSpanSelection({ startOffset: 1, endOffset: 2 }, [0, 2, 3])).toEqual({ startOffset: 0, endOffset: 2 });
    expect(normalizeTextSpanSelection({ startOffset: 2, endOffset: 4 }, [0, 5])).toEqual({ startOffset: 0, endOffset: 5 });
  });
  it("rejects collapsed, fractional and out-of-range selections", () => {
    for (const [startOffset, endOffset] of [[1,1],[-1,1],[1,5],[0.5,2]]) expect(normalizeTextSpanSelection({startOffset,endOffset},[0,1,2])).toBeNull();
  });
  it("preserves whitespace ranges and rejects metadata injected into a create command", () => {
    expect(normalizeTextSpanSelection({startOffset:0,endOffset:2},[0,1,2])).toEqual({startOffset:0,endOffset:2});
    const input = {operationId:"test",sourceIdentity:`sha256:${"a".repeat(64)}`,expectedPolicyRevision:1,command:{kind:"createSpan",startOffset:0,endOffset:2,labelId:"label"}};
    expect(createTextSpanSchema.safeParse(input).success).toBe(true);
    expect(createTextSpanSchema.safeParse({...input,command:{...input.command,status:"APPROVED"}}).success).toBe(false);
  });
});
