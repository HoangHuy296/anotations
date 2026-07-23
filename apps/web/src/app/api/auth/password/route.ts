import { apiError, apiSuccess } from "@/lib/api-response";
import { changePasswordAndRotateSession, cookieOptions, getRequestActor, hashPassword, verifyPassword } from "@/lib/auth";
import { authRequired } from "@/lib/authorization-response";
import { db } from "@/lib/db";
import { passwordChangeSchema } from "@/lib/validation/auth";

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return authRequired();
  const actor = await getRequestActor();
  if (!actor) return authRequired();

  const input = passwordChangeSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiError(400, "INVALID_REQUEST", "Password details are invalid.");

  const user = await db.user.findUnique({ where: { id: actor.id }, select: { passwordHash: true } });
  if (!user || !(await verifyPassword(input.data.currentPassword, user.passwordHash))) {
    return apiError(400, "INVALID_REQUEST", "Your current password is incorrect.");
  }

  const session = await changePasswordAndRotateSession(actor.id, await hashPassword(input.data.newPassword));
  if (!session) return authRequired();

  const response = apiSuccess({ changed: true });
  response.cookies.set("fieldframe_session", session.token, cookieOptions(session.expiresAt));
  return response;
}
