import { apiError, apiSuccess } from "@/lib/api-response";
import { getRequestActor } from "@/lib/auth";
import { authRequired } from "@/lib/authorization-response";
import { db } from "@/lib/db";
import { profileSchema } from "@/lib/validation/auth";

export async function PATCH(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return authRequired();
  const actor = await getRequestActor();
  if (!actor) return authRequired();

  const input = profileSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiError(400, "INVALID_REQUEST", "Profile details are invalid.");

  const user = await db.user.update({
    where: { id: actor.id },
    data: { name: input.data.name },
    select: { id: true, email: true, name: true, role: true },
  });
  return apiSuccess({ ...user, name: user.name ?? user.email });
}
