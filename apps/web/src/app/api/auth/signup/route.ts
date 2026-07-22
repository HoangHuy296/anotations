import { Prisma } from "@internal/db";
import { apiError, apiSuccess } from "@/lib/api-response";
import { cookieOptions, createSession, hashPassword, normalizeEmail } from "@/lib/auth";
import { db } from "@/lib/db";
import { registrationSchema } from "@/lib/validation/auth";

export async function POST(request: Request) {
  const input = registrationSchema.safeParse(await request.json().catch(() => null));
  if (!input.success) return apiError(400, "INVALID_REQUEST", "Credentials are invalid.");
  try {
    const user = await db.user.create({ data: { email: normalizeEmail(input.data.email), name: input.data.name || null, role: input.data.role, passwordHash: await hashPassword(input.data.password) }, select: { id: true, email: true, name: true, role: true } });
    const session = await createSession(user.id);
    const response = apiSuccess({ id: user.id, email: user.email, name: user.name ?? user.email, role: user.role }, { status: 201 });
    response.cookies.set("fieldframe_session", session.token, cookieOptions(session.expiresAt));
    return response;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return apiError(409, "INVALID_REQUEST", "An account with this email already exists.");
    console.error("Signup failed.", {
      kind: error instanceof Prisma.PrismaClientKnownRequestError ? "prisma" : "unexpected",
      code: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
    });
    return apiError(500, "INTERNAL_ERROR", "The account could not be created.");
  }
}
