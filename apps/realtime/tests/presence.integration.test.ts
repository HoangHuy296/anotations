import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import WebSocket from "ws";

import { RealtimeGateway } from "../src/gateway.js";
import { PresenceService } from "../src/presence.js";
import { subscribeToCollaborationEvents } from "../src/subscriptions.js";

const enabled = Boolean(process.env.REDIS_PASSWORD);
const config = () => ({ host: process.env.REDIS_HOST ?? "127.0.0.1", port: Number(process.env.REDIS_PORT ?? 6379), password: process.env.REDIS_PASSWORD ?? "", db: Number(process.env.REDIS_DB ?? 0), prefix: `presence-test-${randomUUID()}`, ttlSeconds: 1 });

test("presence aggregates tabs, gives EDITING precedence, expires, and never locks", { skip: !enabled }, async () => {
  const presence = new PresenceService(config());
  try {
    await presence.heartbeat({ connectionId: "tab-a", userId: "user-a", datasetId: "dataset-a", assetId: "asset-a", activity: "VIEWING" });
    await presence.heartbeat({ connectionId: "tab-b", userId: "user-a", datasetId: "dataset-a", assetId: "asset-a", activity: "EDITING" });
    await presence.heartbeat({ connectionId: "tab-c", userId: "user-b", datasetId: "dataset-a", assetId: "asset-a", activity: "VIEWING" });
    assert.deepEqual(await presence.members("dataset-a", "asset-a"), [
      { userId: "user-a", assetId: "asset-a", activity: "EDITING" },
      { userId: "user-b", assetId: "asset-a", activity: "VIEWING" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.deepEqual(await presence.members("dataset-a", "asset-a"), [], "TTL expiry only removes ephemeral presence; it does not deny any action");
  } finally { await presence.close(); }
});

function ticket(userId: string, datasetId: string, secret: string) {
  const encoded = Buffer.from(JSON.stringify({ sub: userId, datasets: [datasetId], exp: Date.now() + 60_000, jti: randomUUID() })).toString("base64url");
  return `${encoded}.${createHmac("sha256", secret).update(encoded).digest("base64url")}`;
}

test("gateway broadcasts scoped heartbeat presence without creating an edit lock", { skip: !enabled }, async () => {
  const input = config();
  const presence = new PresenceService(input);
  const secret = "presence-gateway-secret-long-enough-for-test";
  const http = createServer();
  const gateway = new RealtimeGateway(secret, presence);
  gateway.attach(http);
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  assert.ok(address && typeof address !== "string");
  const unsubscribe = await subscribeToCollaborationEvents(gateway, input);
  const first = new WebSocket(`ws://127.0.0.1:${address.port}/?ticket=${encodeURIComponent(ticket("editor", "dataset-a", secret))}`);
  const second = new WebSocket(`ws://127.0.0.1:${address.port}/?ticket=${encodeURIComponent(ticket("viewer", "dataset-a", secret))}`);
  const messages: string[] = [];
  try {
    await Promise.all([first, second].map((socket) => new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); })));
    second.on("message", (message) => messages.push(message.toString()));
    first.send(JSON.stringify({ type: "presence.heartbeat", datasetId: "dataset-a", assetId: "asset-a", activity: "EDITING" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(messages.some((message) => message.includes("presence.updated") && message.includes("EDITING")));
    assert.equal(second.readyState, WebSocket.OPEN, "presence never locks or disconnects another authorized viewer");
  } finally {
    const closed = [first, second].map((socket) => new Promise<void>((resolve) => socket.readyState === WebSocket.CLOSED ? resolve() : socket.once("close", () => resolve())));
    first.close(); second.close();
    await Promise.all(closed);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await unsubscribe(); await presence.close(); gateway.close(); await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
