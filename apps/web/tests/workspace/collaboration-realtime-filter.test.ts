import { describe, expect, it } from "vitest";
import { isInvalidatingGatewayMessage } from "@/components/workspace/use-collaboration-realtime";

describe("isInvalidatingGatewayMessage", () => {
  it("ignores presence events so a heartbeat never refreshes the server page", () => {
    expect(isInvalidatingGatewayMessage(JSON.stringify({ type: "presence.update", datasetId: "d", payload: { members: [] } }))).toBe(false);
    expect(isInvalidatingGatewayMessage(JSON.stringify({ type: "presence.heartbeat" }))).toBe(false);
  });
  it("still invalidates on collaboration events and on unparseable input", () => {
    expect(isInvalidatingGatewayMessage(JSON.stringify({ type: "comment.created" }))).toBe(true);
    expect(isInvalidatingGatewayMessage("not json")).toBe(true);
    expect(isInvalidatingGatewayMessage(JSON.stringify({}))).toBe(true);
    expect(isInvalidatingGatewayMessage(new ArrayBuffer(1))).toBe(true);
  });
});
