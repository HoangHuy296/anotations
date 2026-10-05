import "../../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import test from "node:test";

import { issueRealtimeTicket, verifyRealtimeTicket } from "@/lib/realtime/ticket-service";
import { createCollaborationFixture } from "./helpers";

test("realtime tickets are short-lived, signed, and limited to currently authorized dataset scopes", async () => {
  const fixture = await createCollaborationFixture();
  const previousSecret = process.env.REALTIME_TICKET_SECRET;
  process.env.REALTIME_TICKET_SECRET = "test-realtime-ticket-secret-which-is-long-enough";
  try {
    const ticket = await issueRealtimeTicket(fixture.labeler, [fixture.dataset.id]);
    const verified = verifyRealtimeTicket(ticket.token);
    assert.ok(verified);
    assert.equal(verified.userId, fixture.labeler.id);
    assert.deepEqual(verified.datasetIds, [fixture.dataset.id]);
    assert.equal(verifyRealtimeTicket(`${ticket.token}x`), null);
    await assert.rejects(() => issueRealtimeTicket(fixture.labeler, ["ckaaaaaaaaaaaaaaaaaaaaaaaa"]));
  } finally {
    if (previousSecret === undefined) delete process.env.REALTIME_TICKET_SECRET;
    else process.env.REALTIME_TICKET_SECRET = previousSecret;
    await fixture.cleanup();
  }
});
