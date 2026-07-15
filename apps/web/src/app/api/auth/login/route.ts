import { apiError, apiSuccess } from "@/lib/api-response";
import { cookieOptions, createSession, normalizeEmail, verifyPassword } from "@/lib/auth";
import { db } from "@/lib/db";
import { credentialsSchema } from "@/lib/validation/auth";
export async function POST(request: Request) {
  const input = credentialsSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiError(400, "INVALID_REQUEST", "Credentials are invalid.");
  const user = await db.user.findUnique({ where: { email: normalizeEmail(input.data.email) }, select: { id: true, email: true, name: true, role: true, passwordHash: true } });
  if (!user || !(await verifyPassword(input.data.password, user.passwordHash))) return apiError(401, "AUTH_REQUIRED", "Invalid email or password.");
  const session = await createSession(user.id);
  const response = apiSuccess({ id: user.id, email: user.email, name: user.name ?? user.email, role: user.role });
  response.cookies.set("fieldframe_session", session.token, cookieOptions(session.expiresAt));
  return response;
}
