import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { listSourceConnections, createSourceConnection } from "@/lib/source-connection-service";
import { sourceConnectionCreateSchema } from "@/lib/validation/source-connection";

export const dynamic = "force-dynamic";

function sourceError(code: string) {
  const details: Record<string, [number, string]> = {
    SOURCE_URL_UNSAFE: [400, "The source address is not allowed."],
    SOURCE_DESTINATION_NOT_ALLOWED: [400, "The source destination is not allowed."],
    SOURCE_CONNECTION_EXISTS: [409, "An active connection already exists."],
    SOURCE_TOKEN_EXPIRED: [422, "The source token has expired."],
    SOURCE_TOKEN_INVALID: [422, "The source token is invalid."],
    SOURCE_PROVIDER_UNAVAILABLE: [503, "The source provider is unavailable."],
  };
  const [status, message] = details[code] ?? [500, "The source connection could not be completed."];
  return apiError(status, code as never, message);
}

export async function GET() {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  return apiSuccess({ connections: await listSourceConnections(actor) });
}

export async function POST(request: Request) {
  const actor = await getRequestActor();
  if (!actor) return apiError(401, "AUTH_REQUIRED", "Authentication is required.");
  let body: unknown;
  try { body = await request.json(); } catch { return apiError(400, "INVALID_REQUEST", "The request body must contain valid JSON."); }
  const parsed = sourceConnectionCreateSchema.safeParse(body);
  if (!parsed.success) return apiError(400, "INVALID_REQUEST", "The source connection request is invalid.", parsed.error.flatten().fieldErrors as Record<string, string[]>);
  const result = await createSourceConnection(actor, parsed.data);
  return result.ok ? apiSuccess({ connection: result.connection }, { status: 201 }) : sourceError(result.code);
}
