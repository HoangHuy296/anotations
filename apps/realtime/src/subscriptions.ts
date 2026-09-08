import { Redis } from "ioredis";
import type { RealtimeGateway, RealtimeEnvelope } from "./gateway.js";

export function collaborationRedisChannel(prefix: string) { return `${prefix}:collaboration:events`; }

/** Redis only: the gateway never reads or claims a PostgreSQL outbox row. */
export async function subscribeToCollaborationEvents(gateway: RealtimeGateway, input: { host: string; port: number; password: string; db: number; prefix: string }) {
  const subscriber = new Redis({ host: input.host, port: input.port, password: input.password, db: input.db, maxRetriesPerRequest: null });
  await subscriber.subscribe(collaborationRedisChannel(input.prefix));
  subscriber.on("message", (_channel, raw) => {
    try {
      const event = JSON.parse(raw) as RealtimeEnvelope;
      if (event.id && event.type && event.occurredAt && event.datasetId && event.payload && typeof event.payload === "object") gateway.deliver(event);
    } catch { /* malformed delivery envelopes are transport noise */ }
  });
  return () => subscriber.quit();
}
