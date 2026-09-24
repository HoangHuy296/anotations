import { NextResponse } from "next/server";

import { apiError } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { readTextSource } from "@/lib/annotations/text-source-read-service";
import { mapTextSourceReadOutcomeToHttp } from "@/lib/annotations/text-source-http-mapping";

export const dynamic = "force-dynamic";

/**
 * Thin caller of the single authoritative T028 source-read service — no
 * source-authority logic lives in this route. Every readiness state
 * (including a not-yet-`READY` one) is a normal 200 response, never an
 * error; only a concealed/nonexistent asset is 404. Uses `NextResponse`
 * directly (not the shared `apiSuccess` helper) because this route must
 * send the exact `Cache-Control: private, no-store` this endpoint's
 * contract requires — stronger and more explicit than `apiSuccess`'s
 * blanket `no-store` default, which this potentially-user-content response
 * deliberately does not rely on alone.
 */
export async function GET(_request: Request, context: { params: Promise<{ assetId: string }> }) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  const { assetId } = await context.params;
  const outcome = await readTextSource(actor, assetId);
  const { status } = mapTextSourceReadOutcomeToHttp(outcome);
  if (!outcome.ok) return apiError(status, "GITEA_NOT_FOUND", "The asset was not found.");
  return NextResponse.json({ data: outcome }, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
