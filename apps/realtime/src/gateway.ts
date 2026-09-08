import { createHmac, timingSafeEqual } from "node:crypto";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { PresenceActivity, PresenceService } from "./presence.js";

type Ticket = { sub: string; datasets: string[]; exp: number; jti: string };
export type RealtimeEnvelope = { id: string; type: string; occurredAt: string; datasetId: string; assetId?: string; recipientUserId?: string; payload: Record<string, unknown> };
type Connection = { userId: string; datasetIds: Set<string>; connectionId: string; expiresAt: number; expiryTimer?: ReturnType<typeof setTimeout> };

function verify(token: string, secret: string): Ticket | null {
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length) return null;
  const expected = Buffer.from(createHmac("sha256", secret).update(encoded).digest("base64url"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const ticket = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Ticket;
    return ticket.sub && ticket.jti && Array.isArray(ticket.datasets) && ticket.datasets.every((item) => typeof item === "string") && Number.isFinite(ticket.exp) && ticket.exp > Date.now() ? ticket : null;
  } catch { return null; }
}

export class RealtimeGateway {
  readonly server = new WebSocketServer({ noServer: true });
  private readonly connections = new Map<WebSocket, Connection>();
  constructor(private readonly ticketSecret: string, private readonly presence?: PresenceService) {
    this.server.on("connection", (socket, connection: Connection) => {
      this.connections.set(socket, connection);
      socket.on("message", (raw) => void this.handleMessage(socket, connection, raw.toString()));
      socket.on("close", () => {
        if (connection.expiryTimer) clearTimeout(connection.expiryTimer);
        this.connections.delete(socket);
        void this.presence?.leave(connection.connectionId);
      });
    });
  }
  attach(httpServer: Server) {
    httpServer.on("upgrade", (request, socket, head) => {
      const ticket = new URL(request.url ?? "/", "http://gateway.invalid").searchParams.get("ticket");
      const verified = ticket ? verify(ticket, this.ticketSecret) : null;
      if (!verified) return socket.destroy();
      this.server.handleUpgrade(request, socket, head, (ws) => {
        const connection: Connection = {
          userId: verified.sub,
          datasetIds: new Set(verified.datasets),
          connectionId: this.presence?.createConnectionId() ?? "",
          expiresAt: verified.exp,
        };
        // A ticket authorizes a connection only until its signed expiry. A
        // reconnect must obtain a fresh ticket from Next.js; no gateway/Redis
        // read is used as an alternate authorization source.
        connection.expiryTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) ws.close(1008, "ticket expired");
        }, Math.max(verified.exp - Date.now(), 0));
        this.server.emit("connection", ws, connection);
      });
    });
  }
  deliver(event: RealtimeEnvelope) {
    for (const [socket, connection] of this.connections) {
      if (event.type === "MEMBERSHIP_REVOKED" && event.recipientUserId === connection.userId) {
        connection.datasetIds.delete(event.datasetId);
        if (!connection.datasetIds.size) socket.close(1008, "scope revoked");
        continue;
      }
      if (!connection.datasetIds.has(event.datasetId) || (event.recipientUserId && event.recipientUserId !== connection.userId) || socket.readyState !== WebSocket.OPEN) continue;
      socket.send(JSON.stringify(event));
    }
  }
  close() { for (const socket of this.connections.keys()) socket.close(); this.server.close(); }
  private async handleMessage(socket: WebSocket, connection: Connection, raw: string) {
    try {
      const message = JSON.parse(raw) as { type?: unknown; datasetId?: unknown; assetId?: unknown; activity?: unknown };
      if (message.type !== "presence.heartbeat" || typeof message.datasetId !== "string" || !connection.datasetIds.has(message.datasetId) || (message.assetId !== undefined && typeof message.assetId !== "string") || (message.activity !== "VIEWING" && message.activity !== "EDITING") || !this.presence) throw new Error("invalid");
      await this.presence.heartbeat({ connectionId: connection.connectionId, userId: connection.userId, datasetId: message.datasetId, assetId: message.assetId ?? null, activity: message.activity as PresenceActivity });
    } catch { socket.close(1008, "commands are not supported"); }
  }
}
