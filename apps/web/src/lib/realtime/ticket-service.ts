import "server-only";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import type { RequestActor } from "@/lib/auth";
import { requireDatasetPermission } from "@/lib/authorization";

const TICKET_TTL_MS = 60_000;

type TicketPayload = { sub: string; datasets: string[]; iat: number; exp: number; jti: string };
export type VerifiedRealtimeTicket = { userId: string; datasetIds: string[]; expiresAt: Date; id: string };

function secret() {
  const value = process.env.REALTIME_TICKET_SECRET;
  if (!value || value.length < 32) throw new Error("REALTIME_TICKET_SECRET is not configured.");
  return value;
}

function sign(encodedPayload: string) {
  return createHmac("sha256", secret()).update(encodedPayload).digest("base64url");
}

export async function issueRealtimeTicket(actor: RequestActor, datasetIds: string[]) {
  const uniqueDatasetIds = [...new Set(datasetIds)];
  for (const datasetId of uniqueDatasetIds) {
    const access = await requireDatasetPermission(actor, datasetId, "dataset.read");
    if (!access || access.forbidden) throw new Error("REALTIME_TICKET_SCOPE_DENIED");
  }
  const now = Date.now();
  const payload: TicketPayload = { sub: actor.id, datasets: uniqueDatasetIds, iat: now, exp: now + TICKET_TTL_MS, jti: randomUUID() };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { token: `${encoded}.${sign(encoded)}`, expiresAt: new Date(payload.exp) };
}

/** Shared verification contract for the delivery-only gateway. */
export function verifyRealtimeTicket(token: string): VerifiedRealtimeTicket | null {
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length) return null;
  const expected = Buffer.from(sign(encoded));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TicketPayload;
    if (!payload.sub || !Array.isArray(payload.datasets) || !payload.datasets.every((id) => typeof id === "string") || !Number.isFinite(payload.exp) || payload.exp <= Date.now() || !payload.jti) return null;
    return { userId: payload.sub, datasetIds: [...new Set(payload.datasets)], expiresAt: new Date(payload.exp), id: payload.jti };
  } catch { return null; }
}
