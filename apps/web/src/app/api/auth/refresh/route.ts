import { apiSuccess } from "@/lib/api-response";
import { cookieOptions, getRequestActor, rotateSession } from "@/lib/auth";
import { authRequired, isCrossOriginRequest } from "@/lib/authorization-response";
export async function POST(request: Request) { if (isCrossOriginRequest(request)) return authRequired(); const actor = await getRequestActor(); const session = actor ? await rotateSession() : null; if (!actor || !session) return authRequired(); const response = apiSuccess(actor); response.cookies.set("fieldframe_session", session.token, cookieOptions(session.expiresAt)); return response;}
