import { apiSuccess } from "@/lib/api-response";
import { cookieOptions, getRequestActor, rotateSession } from "@/lib/auth";
import { authRequired } from "@/lib/authorization-response";
export async function POST(request: Request) { const origin = request.headers.get("origin"); if (origin && origin !== new URL(request.url).origin) return authRequired(); const actor = await getRequestActor(); const session = actor ? await rotateSession() : null; if (!actor || !session) return authRequired(); const response = apiSuccess(actor); response.cookies.set("fieldframe_session", session.token, cookieOptions(session.expiresAt)); return response; }
