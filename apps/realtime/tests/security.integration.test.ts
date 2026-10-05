import "../../../scripts/db-safety/test-entry.cjs"; // G1: verify disposable target before fixtures.
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import { Redis } from "ioredis";
import WebSocket from "ws";

import { RealtimeGateway } from "../src/gateway.js";
import { collaborationRedisChannel, subscribeToCollaborationEvents } from "../src/subscriptions.js";

const enabled = Boolean(process.env.REDIS_PASSWORD);
const secret = "realtime-security-integration-secret-which-is-long-enough";
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function ticket(userId: string, datasetIds: string[], expiresAt = Date.now() + 60_000) {
  const encoded = Buffer.from(JSON.stringify({ sub: userId, datasets: datasetIds, iat: Date.now(), exp: expiresAt, jti: randomUUID() })).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

test("gateway rejects invalid/expired tickets and revokes every tab without delivering later protected events", { skip: !enabled }, async () => {
  const http = createServer();
  const gateway = new RealtimeGateway(secret);
  gateway.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const prefix = `realtime-security-${randomUUID()}`;
  const subscriber = await subscribeToCollaborationEvents(gateway, { host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD!, db: Number(process.env.REDIS_DB ?? 0), prefix });
  const publisher = new Redis({ host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD, db: Number(process.env.REDIS_DB ?? 0), maxRetriesPerRequest: null });
  const url = (value: string) => `ws://127.0.0.1:${address.port}/?ticket=${encodeURIComponent(value)}`;
  const first = new WebSocket(url(ticket("member", ["dataset-a", "dataset-b"])));
  const second = new WebSocket(url(ticket("member", ["dataset-a", "dataset-b"])));
  const received: string[] = [];
  let firstClosed = false;
  let secondClosed = false;
  try {
    await Promise.all([first, second].map((socket) => new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); })));
    first.on("message", (message) => received.push(message.toString()));
    second.on("message", (message) => received.push(message.toString()));
    first.on("close", () => { firstClosed = true; });
    second.on("close", () => { secondClosed = true; });

    await publisher.publish(collaborationRedisChannel(prefix), JSON.stringify({ id: "revoke-a", type: "MEMBERSHIP_REVOKED", occurredAt: new Date().toISOString(), datasetId: "dataset-a", recipientUserId: "member", payload: {} }));
    await wait(80);
    await publisher.publish(collaborationRedisChannel(prefix), JSON.stringify({ id: "a-after", type: "COMMENT_CHANGED", occurredAt: new Date().toISOString(), datasetId: "dataset-a", payload: {} }));
    await publisher.publish(collaborationRedisChannel(prefix), JSON.stringify({ id: "b-still-authorized", type: "COMMENT_CHANGED", occurredAt: new Date().toISOString(), datasetId: "dataset-b", payload: {} }));
    await wait(100);
    assert.equal(received.filter((item) => item.includes("a-after")).length, 0);
    assert.equal(received.filter((item) => item.includes("b-still-authorized")).length, 2, "both tabs retain their independently authorized scope");

    await publisher.publish(collaborationRedisChannel(prefix), JSON.stringify({ id: "revoke-b", type: "MEMBERSHIP_REVOKED", occurredAt: new Date().toISOString(), datasetId: "dataset-b", recipientUserId: "member", payload: {} }));
    await wait(100);
    assert.equal(firstClosed, true);
    assert.equal(secondClosed, true, "membership revocation applies to every connection for the member");

    const expired = new WebSocket(url(ticket("expired", ["dataset-a"], Date.now() - 1)));
    // Invalid upgrades can report ECONNRESET before close; that is the
    // expected transport result and must not become an uncaught test error.
    expired.on("error", () => undefined);
    await new Promise<void>((resolve) => expired.once("close", resolve));
  } finally {
    first.close(); second.close();
    await publisher.quit();
    await subscriber();
    gateway.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
