import { randomUUID } from "node:crypto";

import { Redis } from "ioredis";

import { collaborationRedisChannel } from "./subscriptions.js";

export type PresenceActivity = "VIEWING" | "EDITING";
export type PresenceMember = { userId: string; assetId: string | null; activity: PresenceActivity };
type ConnectionPresence = PresenceMember & { datasetId: string; expiresAt: number };

const PRESENCE_TTL_SECONDS = 45;

function connectionKey(connectionId: string) { return `presence:connection:${connectionId}`; }
function datasetKey(datasetId: string) { return `presence:dataset:${datasetId}`; }
function assetKey(assetId: string) { return `presence:asset:${assetId}`; }

/** Redis-only presence. It is intentionally separate from durable outbox delivery. */
export class PresenceService {
  private readonly redis: Redis;
  readonly connectionIds = new Map<string, string>();

  constructor(private readonly input: { host: string; port: number; password: string; db: number; prefix: string; ttlSeconds?: number }) {
    this.redis = new Redis({ host: input.host, port: input.port, password: input.password, db: input.db, maxRetriesPerRequest: null });
  }

  createConnectionId() { return randomUUID(); }

  async heartbeat(input: { connectionId: string; userId: string; datasetId: string; assetId?: string | null; activity: PresenceActivity }) {
    const ttlSeconds = this.input.ttlSeconds ?? PRESENCE_TTL_SECONDS;
    const expiresAt = Date.now() + ttlSeconds * 1000;
    const value: ConnectionPresence = { userId: input.userId, datasetId: input.datasetId, assetId: input.assetId ?? null, activity: input.activity, expiresAt };
    const key = connectionKey(input.connectionId);
    await this.redis.multi()
      .set(key, JSON.stringify(value), "EX", ttlSeconds)
      .zadd(datasetKey(input.datasetId), expiresAt, input.connectionId)
      .expire(datasetKey(input.datasetId), ttlSeconds * 2)
      .exec();
    if (input.assetId) await this.redis.multi().zadd(assetKey(input.assetId), expiresAt, input.connectionId).expire(assetKey(input.assetId), ttlSeconds * 2).exec();
    await this.publish(input.datasetId, input.assetId ?? null, "presence.updated");
  }

  async leave(connectionId: string) {
    const raw = await this.redis.get(connectionKey(connectionId));
    if (!raw) return;
    const value = JSON.parse(raw) as ConnectionPresence;
    await this.redis.multi().del(connectionKey(connectionId)).zrem(datasetKey(value.datasetId), connectionId).exec();
    if (value.assetId) await this.redis.zrem(assetKey(value.assetId), connectionId);
    await this.publish(value.datasetId, value.assetId, "presence.left");
  }

  async members(datasetId: string, assetId?: string | null): Promise<PresenceMember[]> {
    const now = Date.now();
    const scope = assetId ? assetKey(assetId) : datasetKey(datasetId);
    await this.redis.zremrangebyscore(scope, "-inf", now);
    const ids = await this.redis.zrangebyscore(scope, now, "+inf");
    const rows = await Promise.all(ids.map((id) => this.redis.get(connectionKey(id))));
    const aggregated = new Map<string, PresenceMember>();
    for (const raw of rows) {
      if (!raw) continue;
      const value = JSON.parse(raw) as ConnectionPresence;
      if (value.datasetId !== datasetId || value.expiresAt <= now) continue;
      const current = aggregated.get(value.userId);
      if (!current || value.activity === "EDITING") aggregated.set(value.userId, { userId: value.userId, assetId: value.assetId, activity: value.activity });
    }
    return [...aggregated.values()];
  }

  async close() { await this.redis.quit(); }

  private async publish(datasetId: string, assetId: string | null, type: "presence.updated" | "presence.left") {
    const members = await this.members(datasetId, assetId);
    await this.redis.publish(collaborationRedisChannel(this.input.prefix), JSON.stringify({
      id: randomUUID(), type, occurredAt: new Date().toISOString(), datasetId, ...(assetId ? { assetId } : {}), payload: { members },
    }));
  }
}
