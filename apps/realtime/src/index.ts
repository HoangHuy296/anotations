import { createServer } from "node:http";
import { getRealtimeConfig } from "./env.js";
import { RealtimeGateway } from "./gateway.js";
import { subscribeToCollaborationEvents } from "./subscriptions.js";
import { PresenceService } from "./presence.js";

const config = getRealtimeConfig();
const http = createServer((request, response) => { response.writeHead(request.url === "/health" ? 200 : 404).end(); });
const presence = new PresenceService({ host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: config.BULLMQ_PREFIX });
const gateway = new RealtimeGateway(config.REALTIME_TICKET_SECRET, presence);
gateway.attach(http);
const unsubscribe = await subscribeToCollaborationEvents(gateway, { host: config.REDIS_HOST, port: config.REDIS_PORT, password: config.REDIS_PASSWORD, db: config.REDIS_DB, prefix: config.BULLMQ_PREFIX });
http.listen(config.REALTIME_PORT);
process.on("SIGTERM", async () => { await unsubscribe(); await presence.close(); gateway.close(); http.close(); });
