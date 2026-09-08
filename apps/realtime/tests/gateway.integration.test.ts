import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { Redis } from "ioredis";
import WebSocket from "ws";

import { RealtimeGateway } from "../src/gateway.js";
import { collaborationRedisChannel, subscribeToCollaborationEvents } from "../src/subscriptions.js";

const enabled = Boolean(process.env.REDIS_PASSWORD);
const secret = "realtime-integration-ticket-secret-which-is-long-enough";
const redis = () => new Redis({ host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD, db: Number(process.env.REDIS_DB ?? 0), maxRetriesPerRequest: null });

function ticket(userId: string, datasetIds: string[], expiresAt = Date.now() + 60_000) {
  const encoded = Buffer.from(JSON.stringify({ sub: userId, datasets: datasetIds, iat: Date.now(), exp: expiresAt, jti: randomUUID() })).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("gateway verifies tickets, fans Redis envelopes only to scope, and revocation prevents later delivery", { skip: !enabled }, async () => {
  const http = createServer();
  const gateway = new RealtimeGateway(secret);
  gateway.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const channelPrefix = `realtime-test-${randomUUID()}`;
  const unsubscribe = await subscribeToCollaborationEvents(gateway, { host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD!, db: Number(process.env.REDIS_DB ?? 0), prefix: channelPrefix });
  const publisher = redis();
  const received: string[] = [];
  let closed = false;
  const client = new WebSocket(`ws://127.0.0.1:${address.port}/?ticket=${encodeURIComponent(ticket("member-b", ["dataset-a"]))}`);
  try {
    await new Promise<void>((resolve, reject) => { client.once("open", resolve); client.once("error", reject); });
    client.on("message", (message) => received.push(message.toString()));
    client.on("close", () => { closed = true; });
    await publisher.publish(collaborationRedisChannel(channelPrefix), JSON.stringify({ id: "one", type: "COMMENT_CHANGED", occurredAt: new Date().toISOString(), datasetId: "dataset-a", recipientUserId: "member-b", payload: { reason: "changed" } }));
    await wait(100);
    assert.equal(received.length, 1, "authorized dataset event was delivered");

    await publisher.publish(collaborationRedisChannel(channelPrefix), JSON.stringify({ id: "revoke", type: "MEMBERSHIP_REVOKED", occurredAt: new Date().toISOString(), datasetId: "dataset-a", recipientUserId: "member-b", payload: { reason: "removed" } }));
    await wait(100);
    assert.equal(closed, true, "last scope revocation closed the connection");
    await publisher.publish(collaborationRedisChannel(channelPrefix), JSON.stringify({ id: "after", type: "COMMENT_CHANGED", occurredAt: new Date().toISOString(), datasetId: "dataset-a", recipientUserId: "member-b", payload: { reason: "must-not-deliver" } }));
    await wait(100);
    assert.equal(received.length, 1, "connected member removed → subsequent event not delivered");
  } finally {
    client.close();
    await publisher.quit();
    await unsubscribe();
    gateway.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
