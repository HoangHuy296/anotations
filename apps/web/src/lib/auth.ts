import "server-only";

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { UserRole } from "@internal/db";
import { cookies, headers } from "next/headers";

import { db } from "@/lib/db";

const scrypt = promisify(scryptCallback);
const SESSION_COOKIE = "fieldframe_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

export type RequestActor = { id: string; email: string; name: string; role: UserRole };
export type SafeUser = RequestActor;

export const sessionCookieName = SESSION_COOKIE;

function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
function normalizeEmail(value: string) { return value.trim().toLowerCase(); }

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const hash = Buffer.from(await scrypt(password, salt, 64) as ArrayBuffer).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [algorithm, salt, expected] = stored.split("$");
  if (algorithm !== "scrypt" || !salt || !expected) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64) as ArrayBuffer);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

/**
 * Defaults to the previous NODE_ENV-based behavior (secure in production).
 * COOKIE_SECURE lets a non-TLS deployment (e.g. a local review/demo stack
 * reached over plain HTTP from another machine) opt out explicitly, since
 * browsers silently drop Secure cookies set over HTTP for any origin other
 * than localhost.
 */
function resolveCookieSecure() {
  const override = process.env.COOKIE_SECURE;
  if (override === "false") return false;
  if (override === "true") return true;
  return process.env.NODE_ENV === "production";
}

export function cookieOptions(expiresAt: Date) {
  return { httpOnly: true, sameSite: "lax" as const, secure: resolveCookieSecure(), path: "/", expires: expiresAt };
}

async function sessionContext() {
  try {
    const requestHeaders = await headers();
    return { userAgent: requestHeaders.get("user-agent")?.slice(0, 512) ?? null, ipAddress: requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null };
  } catch {
    // Server-side integration calls have no request context; no client data is inferred.
    return { userAgent: null, ipAddress: null };
  }
}

export async function createSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const context = await sessionContext();
  await db.authSession.create({ data: { userId, refreshTokenHash: digest(token), expiresAt, ...context } });
  return { token, expiresAt };
}

export async function getRequestActor(): Promise<RequestActor | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? getActorFromSessionToken(token) : null;
}

/** Server-only token resolver shared by request handlers and integration tests. */
export async function getActorFromSessionToken(token: string): Promise<RequestActor | null> {
  const session = await db.authSession.findFirst({
    where: { refreshTokenHash: digest(token), revokedAt: null, deletedAt: null, expiresAt: { gt: new Date() } },
    select: { user: { select: { id: true, email: true, name: true, role: true } } },
  });
  return session ? { ...session.user, name: session.user.name ?? session.user.email } : null;
}

export async function rotateSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const replacement = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const result = await db.authSession.updateMany({ where: { refreshTokenHash: digest(token), revokedAt: null, deletedAt: null, expiresAt: { gt: new Date() } }, data: { refreshTokenHash: digest(replacement), expiresAt } });
  return result.count === 1 ? { token: replacement, expiresAt } : null;
}

export async function revokeSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return;
  await db.authSession.updateMany({ where: { refreshTokenHash: digest(token), revokedAt: null }, data: { revokedAt: new Date() } });
}

/**
 * Replaces the current opaque credential while invalidating every other active
 * session for the same user. The caller must verify the current password first.
 */
export async function changePasswordAndRotateSession(userId: string, passwordHash: string) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const replacement = randomBytes(32).toString("base64url");
  const replacementHash = digest(replacement);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const now = new Date();

  const changed = await db.$transaction(async (tx) => {
    const currentSession = await tx.authSession.updateMany({
      where: {
        userId,
        refreshTokenHash: digest(token),
        revokedAt: null,
        deletedAt: null,
        expiresAt: { gt: now },
      },
      data: { refreshTokenHash: replacementHash, expiresAt },
    });
    if (currentSession.count !== 1) return false;

    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    await tx.authSession.updateMany({
      where: { userId, refreshTokenHash: { not: replacementHash }, revokedAt: null, deletedAt: null },
      data: { revokedAt: now },
    });
    return true;
  });

  return changed ? { token: replacement, expiresAt } : null;
}

export { normalizeEmail };
