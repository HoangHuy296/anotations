import { apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { authRequired } from "@/lib/authorization-response";
export async function GET() { const actor = await getRequestActor(); return actor ? apiSuccess(actor) : authRequired(); }
