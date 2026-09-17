import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { authRequired, isCrossOriginRequest } from "@/lib/authorization-response";
import { db } from "@/lib/db";
import { accountPreferencesSchema, mergeAccountPreferences, readAccountPreferences } from "@/lib/validation/account-preferences";

export async function PATCH(request: Request) {
  if (isCrossOriginRequest(request)) return authRequired();
  const actor = await getRequestActor();
  if (!actor) return authRequired();

  const input = accountPreferencesSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiError(400, "INVALID_REQUEST", "Account preferences are invalid.");

  const current = await db.user.findUnique({ where: { id: actor.id }, select: { preferences: true } });
  const merged = mergeAccountPreferences(readAccountPreferences(current?.preferences), input.data);
  const user = await db.user.update({ where: { id: actor.id }, data: { preferences: merged }, select: { preferences: true } });
  return apiSuccess(readAccountPreferences(user.preferences));
}
