import { afterEach, describe, expect, it, vi } from "vitest";

import { hasPendingTextAnnotationCommands, submitTextAnnotationCommand } from "@/lib/annotations/text-annotation-client";

/** T096: `hasPendingTextAnnotationCommands` backs the `beforeunload` warning -- a synchronous in-flight check `flushTextAnnotationCommands` (an async wait) cannot serve. */

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify({ data }), { status });
}

describe("hasPendingTextAnnotationCommands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is false before any command, true while one is in flight, false again once it settles", async () => {
    expect(hasPendingTextAnnotationCommands("asset-1")).toBe(false);

    let resolveFetch: (value: Response) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));

    const request = submitTextAnnotationCommand("asset-1", { operationId: "op-1", sourceIdentity: `sha256:${"a".repeat(64)}`, expectedPolicyRevision: 1, command: { kind: "createSpan", startOffset: 0, endOffset: 1, labelId: null } });
    expect(hasPendingTextAnnotationCommands("asset-1")).toBe(true);
    expect(hasPendingTextAnnotationCommands("asset-2")).toBe(false);

    resolveFetch(jsonResponse({ id: "span-1" }, 201));
    await request;
    expect(hasPendingTextAnnotationCommands("asset-1")).toBe(false);
  });
});
